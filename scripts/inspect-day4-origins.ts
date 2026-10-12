import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {PrivyClient} from '@privy-io/node';
import {createPublicClient,http} from 'viem';
import {inspectDay4Origins} from '../packages/protocol/src/day4-origins.js';
import {Day4ChainFlowDeploymentSchema} from '../packages/protocol/src/day4-chain-flow-types.js';
import {day4ChainFlowPort} from '../packages/protocol/src/day4-chain-flow-port.js';
import {day4CreationPairPort} from '../packages/protocol/src/day4-creation-pair-port.js';
import {Day4OriginsRequestSchema,Day4CreationPairConfigSchema,PrivyOriginConfigSchema} from '../packages/protocol/src/day4-origin-types.js';
import {privyOriginPort} from '../packages/adapters/src/privy-origin-port.js';
import {compileDay4OriginArtifacts} from './origin-artifacts.js';
import {readPrivateOriginJson} from './private-origin-input.js';
import {strictJsonParse} from './strict-json.js';
import {auditBytes} from './public-audit.js';
import {commandExit} from './verification-outcome.js';
import {day4OriginSourceBindings as bindings} from './day4-origin-source.js';

const startedAt=new Date().toISOString(),revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const sourceCommit=commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty=commandExit(working)!==0||!!working.stdout.trim();

let sourceBindings:ReturnType<typeof bindings>=[],artifactBindings:ReturnType<typeof compileDay4OriginArtifacts>['bindings']=[];
let report:Record<string,unknown>,exitCode=1,publicRpcInspectionAttempted=false,privyReadInspectionAttempted=false,privyReadCallsAttempted=0;
try{
  if(process.argv.length!==2)throw Error('DAY4_ORIGINS_ARGUMENT_INVALID');
  if(!sourceCommit||!/^[a-f0-9]{40}$/.test(sourceCommit)||commandExit(working)!==0)throw Error('DAY4_ORIGINS_SOURCE_UNAVAILABLE');
  sourceBindings=bindings();
  if(existsSync('.env'))loadEnvFile('.env');
  const names=['CHAIN_ID','DEPLOYER_ADDRESS','CVA_ADDRESS','CVI_VALIDATOR_ADDRESS','CVA_POLICY_ADDRESS','ARBITER_ADDRESS','ELIGIBILITY_GATE_ADDRESS',
    'REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','CLEANVERSE_GATE_NONCE','PRIVY_EXECUTOR_ADDRESS','PRIVY_APP_ID','PRIVY_APP_SECRET',
    'PRIVY_WALLET_ID','PRIVY_POLICY_ID','PRIVY_SIGNER_ID','MONAD_RPC_URL','D4_ORIGINS_PATH'];
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length)report={status:'BLOCKED',reason:'DAY4_ORIGINS_CONFIGURATION_MISSING',missing};
  else{
    const committee=process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim());
    const flow=Day4ChainFlowDeploymentSchema.parse({chainId:process.env.CHAIN_ID,arbiter:process.env.ARBITER_ADDRESS,asset:process.env.CVA_ADDRESS,
      gate:process.env.ELIGIBILITY_GATE_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,committee,executor:process.env.PRIVY_EXECUTOR_ADDRESS});
    const creations=Day4CreationPairConfigSchema.parse({chainId:flow.chainId,deployer:process.env.DEPLOYER_ADDRESS,asset:flow.asset,
      validator:process.env.CVI_VALIDATOR_ADDRESS,policy:process.env.CVA_POLICY_ADDRESS,pool:flow.arbiter,gate:flow.gate,reviewer:flow.reviewer,committee,gateNonce:process.env.CLEANVERSE_GATE_NONCE});
    const privy=PrivyOriginConfigSchema.parse({chainId:flow.chainId,arbiter:flow.arbiter,address:flow.executor,walletId:process.env.PRIVY_WALLET_ID,policyId:process.env.PRIVY_POLICY_ID,signerId:process.env.PRIVY_SIGNER_ID});
    const inputPath=process.env.D4_ORIGINS_PATH!;
    const privateBytes=readPrivateOriginJson(inputPath);
    let request;try{request=Day4OriginsRequestSchema.parse(strictJsonParse(privateBytes.toString('utf8')));}catch{throw Error('DAY4_ORIGINS_PRIVATE_INPUT_INVALID');}
    // Credentials cannot be used as provider identifiers or transmitted as IDs.
    const sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY'].map(name=>process.env[name]).filter(value=>value&&value.length>=16);
    const identifiers=[privy.walletId,privy.policyId,privy.signerId,request.privy.transactions.funding.recordId,request.privy.transactions.allocation.recordId];
    if(identifiers.some(id=>sensitive.some(value=>id.includes(value!))))throw Error('DAY4_ORIGINS_PROVIDER_IDENTIFIER_INVALID');
    let endpoint:URL;try{endpoint=new URL(process.env.MONAD_RPC_URL!);}catch{throw Error('DAY4_ORIGINS_RPC_ENDPOINT_INVALID');}
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw Error('DAY4_ORIGINS_RPC_ENDPOINT_INVALID');
    const compiled=compileDay4OriginArtifacts();artifactBindings=compiled.bindings;
    const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    const privyClient=new PrivyClient({appId:process.env.PRIVY_APP_ID!,appSecret:process.env.PRIVY_APP_SECRET!,apiUrl:'https://api.privy.io',maxRetries:0,timeout:10000,logLevel:'off',fetchOptions:{redirect:'error'}});
    const provider=privyOriginPort(privyClient),markedProvider={transaction:(id:string)=>{privyReadInspectionAttempted=true;privyReadCallsAttempted++;return provider.transaction(id);},
      wallet:(id:string)=>{privyReadInspectionAttempted=true;privyReadCallsAttempted++;return provider.wallet(id);},policy:(id:string)=>{privyReadInspectionAttempted=true;privyReadCallsAttempted++;return provider.policy(id);}};
    publicRpcInspectionAttempted=true;
    const inspection=await inspectDay4Origins(request,{flow,creations,privy},compiled.artifacts,{flow:day4ChainFlowPort(client,flow),creations:day4CreationPairPort(client),privy:markedProvider});
    report={status:'ORIGINS_VERIFIED',reason:'CONFIGURED_ORIGINAL_CREATIONS_CHAIN_EFFECTS_AND_LIVE_PROVIDER_ASSOCIATIONS_VERIFIED',inspection};exitCode=0;
  }
}catch(error){
  const code=error instanceof Error&&/^(?:DAY4_(?:ORIGINS|CREATIONS|FLOW)_[A-Z_]+|PRIVY_ORIGIN_[A-Z_]+)$/.test(error.message)?error.message:'DAY4_ORIGINS_CONFIGURATION_OR_INPUT_INVALID';
  const blocked=/(?:READ_UNAVAILABLE|BUILD_UNAVAILABLE|PENDING|NOT_FINALIZED)$/.test(code);
  report={status:blocked?'BLOCKED':'FAIL',reason:code};exitCode=1;
}
try{
  const finalRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),finalWorking=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
  if(JSON.stringify(sourceBindings)!==JSON.stringify(bindings())||commandExit(finalRevision)!==0||commandExit(finalWorking)!==0
    ||revision.stdout!==finalRevision.stdout||working.stdout!==finalWorking.stdout
    ||artifactBindings.flatMap(item=>[item,...item.sources]).some(item=>{const bytes=readFileSync(item.path);return bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256;})){
    report={status:'FAIL',reason:'DAY4_ORIGINS_SOURCE_OR_ARTIFACT_CHANGED'};exitCode=1;
  }
  const output={schemaVersion:1,scope:'READ_ONLY_ORIGINAL_CREATIONS_CHAIN_AND_LIVE_PRIVY_ASSOCIATIONS_NOT_D4_EXTERNAL_ACCEPTANCE',startedAt,endedAt:new Date().toISOString(),
    sourceCommit,worktreeDirty,sourceBindings,artifactBindings,...report,publicRpcInspectionAttempted,privyReadInspectionAttempted,privyReadCallsAttempted,
    financialAcceptanceStatus:'BLOCKED',officialIntegrationVerified:false,historicalPolicyAtSendVerified:false,withdrawalProviderOriginVerified:false,
    canExecute:false,signaturesRequested:0,transactionsSent:0,exitCode};
  const bytes=Buffer.from(JSON.stringify(output,null,2)+'\n'),sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY'].map(name=>process.env[name]).filter(value=>value&&value.length>=16);
  if(auditBytes('day4-origins.json',bytes).length||sensitive.some(value=>bytes.includes(value!)))throw Error('PUBLIC_OUTPUT_UNSAFE');
  const directory='artifacts/acceptance',path=`${directory}/day4-origins.json`;mkdirSync(directory,{recursive:true});
  if(existsSync(path)){const history=`${directory}/history/${startedAt.replaceAll(':','-')}-day4-origins`;mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/day4-origins.json`);}
  writeFileSync(path,bytes);console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,financialAcceptanceStatus:'BLOCKED',
    publicRpcInspectionAttempted,privyReadInspectionAttempted,privyReadCallsAttempted,transactionsSent:0,evidence:path,exitCode}));
}catch{console.error('DAY4_ORIGINS_EVIDENCE_WRITE_UNAVAILABLE');exitCode=1;}
process.exitCode=exitCode;
