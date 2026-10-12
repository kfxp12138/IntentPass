import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createPublicClient,http,getContractAddress,type Address} from 'viem';
import {configuredAssetMode} from '../packages/protocol/src/asset-mode.js';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {demoDependencyPlan} from './demo-dependency.js';
import {metamaskPlan} from './metamask-types.js';
const startedAt=new Date().toISOString(),directory=`artifacts/acceptance/demo-bootstrap/${Date.now()}-${randomUUID()}`;mkdirSync(directory,{recursive:true});
let report:Record<string,unknown>;
try{
  if(existsSync('.env'))loadEnvFile('.env');
  if(process.argv.length!==2||configuredAssetMode(process.env)!=='demo-erc20')throw Error('DEMO_PROFILE_REQUIRED');
  const compilation=compileDeploymentArtifacts({assetMode:'demo-erc20'});writeFileSync(`${directory}/build.log`,compilation.log);
  const missing=['CHAIN_ID','DEPLOYER_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','MONAD_RPC_URL'].filter(name=>!process.env[name]?.trim());
  if(missing.length)report={status:'BLOCKED',reason:'DEMO_ESCROW_ROLE_CONFIGURATION_MISSING',missing,artifactBindings:compilation.bindings};
  else{
    const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});if(revision.status!==0||!compilation.artifacts.asset)throw Error('DEPLOYMENT_SOURCE_UNAVAILABLE');
    const endpoint=new URL(process.env.MONAD_RPC_URL!);if(endpoint.protocol!=='https:')throw Error('DEPLOYMENT_RPC_INVALID');
    const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})}),account=process.env.DEPLOYER_ADDRESS as Address;
    const asset=demoDependencyPlan('ASSET',{chainId:process.env.CHAIN_ID,deployer:account},compilation.artifacts.asset,revision.stdout.trim());
    if(await client.getChainId()!==10143)throw Error('DEPLOYMENT_CHAIN_MISMATCH');
    const [pending,latest]=await Promise.all([client.getTransactionCount({address:account,blockTag:'pending'}),client.getTransactionCount({address:account,blockTag:'latest'})]);
    if(pending!==latest||!Number.isSafeInteger(pending)||pending<0)throw Error('DEPLOYMENT_NONCE_UNAVAILABLE_OR_PENDING');
    const addresses={asset:getContractAddress({from:account,nonce:BigInt(pending)}),gate:getContractAddress({from:account,nonce:BigInt(pending)+1n}),escrow:getContractAddress({from:account,nonce:BigInt(pending)+2n})};
    const gate=demoDependencyPlan('GATE',{chainId:'10143',deployer:account,asset:addresses.asset},compilation.artifacts.gate,revision.stdout.trim());
    const escrow=metamaskPlan({chainId:'10143',deployer:account,asset:addresses.asset,gate:addresses.gate,reviewer:process.env.REVIEWER_ADDRESS,committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim())},compilation.artifacts.escrow,revision.stdout.trim());
    const roles=[account,escrow.reviewer,...escrow.committee];if(roles.some(role=>Object.values(addresses).some(future=>future.toLowerCase()===role.toLowerCase())))throw Error('DEPLOYMENT_FUTURE_ADDRESS_ROLE_CONFLICT');
    const [afterPending,afterLatest]=await Promise.all([client.getTransactionCount({address:account,blockTag:'pending'}),client.getTransactionCount({address:account,blockTag:'latest'})]);
    if(afterPending!==pending||afterLatest!==pending||await client.getChainId()!==10143)throw Error('DEPLOYMENT_SNAPSHOT_CHANGED');
    report={status:'BLOCKED',reason:'UNSIGNED_DEMO_PREVIEW_ONLY_EACH_CREATION_REQUIRES_NEW_PREFLIGHT_AND_WALLET_CONFIRMATION',sourceCommit:revision.stdout.trim(),nonceObserved:String(pending),addresses,asset,gate,escrow,artifactBindings:compilation.bindings};
  }
  compilation.assertCurrent();
}catch{report={status:'BLOCKED',reason:'DEMO_BOOTSTRAP_UNAVAILABLE_OR_INVALID_INPUT'};}
report={startedAt,endedAt:new Date().toISOString(),scope:'UNSIGNED_TEST_ONLY_MONAD_ERC20_STACK_PREVIEW',assetMode:'demo-erc20',identityVerification:false,canExecute:false,signaturesRequested:0,transactionsSent:0,...report};
writeFileSync(`${directory}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,evidence:`${directory}/report.json`}));process.exitCode=1;
