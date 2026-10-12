import {existsSync,readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createPublicClient,getAddress,http} from 'viem';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {loadActivatedReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {verifyDeploymentCreation} from '../packages/protocol/src/deployment-proof.js';
import {deploymentProofPort} from '../packages/protocol/src/deployment-proof-port.js';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {readPrivyServiceOwnerConfiguration} from './prepare-privy-service-wallets.js';
import {readPrivateServiceJson,writePrivateServiceJsonOnce} from './create-privy-service-wallets.js';
import {parsePrivyServiceOwnerConfiguration} from './privy-service-bootstrap.js';
import {installRuntimeSetup,prepareRuntimeSetup,readOperatorAuthorization,runtimePort,type RuntimeConfig} from './privy-runtime-setup.js';

export function configuredRuntimeInput(root:string,env:NodeJS.ProcessEnv){
  if(env.SETTLEMENT_ASSET_MODE!=='demo-erc20'||env.CHAIN_ID!=='10143')throw Error('PRIVY_RUNTIME_TESTNET_REQUIRED');
  const bootstrap=readPrivateServiceJson(resolve(root,'.tools/privy-service-execution/verified.json')) as {roles:{role:string;walletId:string;policyId:string;address:string}[]};
  const proof=JSON.parse(readFileSync(resolve(root,'artifacts/acceptance/escrow-deployment/original-create-proof.json'),'utf8'));
  if(proof.status!=='CONFIRMED'||proof.contractAddress?.toLowerCase()!==env.ARBITER_ADDRESS?.toLowerCase())throw Error('PRIVY_RUNTIME_CONFIRMED_DEPLOYMENT_REQUIRED');
  const policy=loadActivatedReviewPolicy(env.REVIEW_POLICY_PATH!,env.JEV_MODEL!,root);
  const role=(name:string)=>{const r=bootstrap.roles.find(r=>r.role===name);if(!r)throw Error('PRIVY_RUNTIME_ROLE_REQUIRED');return {walletId:r.walletId,initialPolicyId:r.policyId,address:getAddress(r.address)};};
  const config:RuntimeConfig={appId:env.PRIVY_APP_ID!,chainId:'10143',arbiter:env.ARBITER_ADDRESS as `0x${string}`,model:policy.model,questionConfigHash:policy.questionConfigHash,roles:{reviewer:role('reviewer'),executor:role('executor')},owner:parsePrivyServiceOwnerConfiguration(readPrivyServiceOwnerConfiguration(root))};
  if(config.roles.reviewer.address.toLowerCase()!==env.REVIEWER_ADDRESS?.toLowerCase()||config.roles.executor.address.toLowerCase()!==env.PRIVY_EXECUTOR_ADDRESS?.toLowerCase())throw Error('PRIVY_RUNTIME_ROLE_CONFIGURATION_MISMATCH');
  return {config,proof};
}
export function saveRuntimeEnvironment(root:string,config:RuntimeConfig,roles:{role:string;walletId:string;policyId:string;signerId:string}[]){
  const material=readPrivateServiceJson(resolve(root,'.tools/privy-runtime/material.json')) as {roles:Record<string,{privateKey:string}>};
  const reviewer=roles.find(r=>r.role==='reviewer')!,executor=roles.find(r=>r.role==='executor')!;
  if(!reviewer||!executor)throw Error('PRIVY_RUNTIME_VERIFIED_ROLES_REQUIRED');
  const values={PRIVY_REVIEWER_WALLET_ID:reviewer.walletId,PRIVY_REVIEWER_POLICY_ID:reviewer.policyId,PRIVY_REVIEWER_SIGNER_ID:reviewer.signerId,PRIVY_REVIEWER_AUTHORIZATION_PRIVATE_KEY:material.roles.reviewer.privateKey,
    PRIVY_WALLET_ID:executor.walletId,PRIVY_POLICY_ID:executor.policyId,PRIVY_SIGNER_ID:executor.signerId,PRIVY_AUTHORIZATION_PRIVATE_KEY:material.roles.executor.privateKey};
  const path=resolve(root,'.env'),meta=lstatSync(path);if(!meta.isFile()||meta.isSymbolicLink()||(meta.mode&0o777)!==0o600)throw Error('PRIVY_RUNTIME_PRIVATE_ENV_REQUIRED');
  const original=readFileSync(path,'utf8');let next=original;
  for(const [name,value] of Object.entries(values)){
    const pattern=new RegExp('^'+name+'=(.*)$','gm'),matches=[...next.matchAll(pattern)];if(matches.length>1)throw Error('PRIVY_RUNTIME_DUPLICATE_ENV_FIELD');
    const old=matches[0]?.[1]?.trim();const role=name.startsWith('PRIVY_REVIEWER')?config.roles.reviewer:config.roles.executor;
    const allowedPrevious=name.endsWith('POLICY_ID')?role.initialPolicyId:undefined;
    if(old&&old!==value&&old!==allowedPrevious)throw Error('PRIVY_RUNTIME_EXISTING_ENV_MISMATCH');
    next=matches.length?next.replace(pattern,()=>name+'='+value):next.replace(/\s*$/,'\n')+name+'='+value+'\n';
  }
  if(readFileSync(path,'utf8')!==original)throw Error('PRIVY_RUNTIME_ENV_CHANGED');
  const tmp=resolve(root,'.tools/runtime-env-'+randomUUID());writeFileSync(tmp,next,{mode:0o600,flag:'wx'});renameSync(tmp,path);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const correction=process.argv.length===4&&process.argv[2]==='--execute'&&process.argv[3]==='--correct-invalid-quorum-name';
    if(!correction&&(process.argv.length!==3||!['--prepare','--execute'].includes(process.argv[2])))throw Error('PRIVY_RUNTIME_ARGUMENT_INVALID');
    const root=process.cwd(),{config,proof}=configuredRuntimeInput(root,process.env),plan=prepareRuntimeSetup(root,config);
    const planPath=resolve(root,'.tools/privy-runtime/plan.json');if(!existsSync(planPath))writePrivateServiceJsonOnce(planPath,plan);else if(JSON.stringify(readPrivateServiceJson(planPath))!==JSON.stringify(plan))throw Error('PRIVY_RUNTIME_PLAN_CHANGED');
    if(process.argv[2]==='--prepare'){console.log(JSON.stringify({status:'RUNTIME_PLAN_PREPARED',roles:plan.roles.map(r=>({role:r.role,address:r.address})),managementAndRuntimeKeysSeparate:true,privatePlan:'.tools/privy-runtime/plan.json',privateKeyMaterialSavedLocally:true,privateKeysRecordedInOutput:false,mutations:0,transactionsSent:0}));}
    else{
      const compilation=compileDeploymentArtifacts({assetMode:'demo-erc20'}),client=createPublicClient({transport:http(process.env.MONAD_RPC_URL!,{retryCount:0,timeout:20000,fetchOptions:{redirect:'error'}})});
      const verifyDeployment=async()=>{const actual=await verifyDeploymentCreation({chainId:'10143',deployer:proof.deployer,asset:proof.configuration.asset,gate:proof.configuration.gate,reviewer:config.roles.reviewer.address,committee:proof.configuration.committee},compilation.artifacts.escrow,proof.hash,deploymentProofPort(client));if(actual.status!=='CONFIRMED'||!actual.contractAddress||actual.contractAddress.toLowerCase()!==config.arbiter.toLowerCase())throw Error('PRIVY_RUNTIME_DEPLOYMENT_MISMATCH');compilation.assertCurrent();};
      const operatorKey=readOperatorAuthorization(root,config.owner);
      const result=await installRuntimeSetup({root,config,approved:true,correctInvalidQuorumName:correction,port:runtimePort(createPrivyClient({appId:config.appId,appSecret:process.env.PRIVY_APP_SECRET!}),operatorKey),verifyDeployment});
      saveRuntimeEnvironment(root,config,result.roles);
      console.log(JSON.stringify({status:'RUNTIME_DELEGATION_VERIFIED',arbiter:config.arbiter,roles:result.roles.map(r=>({role:r.role,address:r.address})),mutationsThisRun:result.mutationsThisRun,recoveredUpdates:result.recoveredUpdates,managementKeySeparate:true,privateKeyMaterialSavedLocally:true,privateKeysRecordedInOutput:false,walletSignaturesRequested:0,transactionsSent:0,financialAcceptanceStatus:'BLOCKED'}));
    }
  }catch(error){const reason=error instanceof Error&&/^(?:PRIVY_RUNTIME|PRIVY_SERVICE_CREATE|PRIVY_SERVICE_OWNER|DEPLOYMENT|REVIEW_POLICY)_[A-Z_]+$/.test(error.message)?error.message:'PRIVY_RUNTIME_SETUP_UNAVAILABLE';console.error(JSON.stringify({status:'BLOCKED',reason,retryMutationAllowed:false,transactionsSent:0}));process.exitCode=1;}
}
