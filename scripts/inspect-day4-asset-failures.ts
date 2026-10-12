import {spawnSync} from 'node:child_process';
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {createPublicClient,http} from 'viem';
import {Day4AssetFailureConfigSchema,Day4AssetFailureRequestSchema,type Day4AssetFailurePort} from '../packages/protocol/src/day4-asset-failure-types.js';
import {inspectDay4AssetFailures} from '../packages/protocol/src/day4-asset-failures.js';
import {day4CreationPairPort} from '../packages/protocol/src/day4-creation-pair-port.js';
import {day4ChainFlowPort} from '../packages/protocol/src/day4-chain-flow-port.js';
import {day4FailureTracePort} from '../packages/adapters/src/day4-failure-trace.js';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {readPrivateOriginJson} from './private-origin-input.js';
import {strictJsonParse} from './strict-json.js';
import {auditBytes} from './public-audit.js';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {commandExit} from './verification-outcome.js';

const startedAt=new Date().toISOString(),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const worktreeDirty=commandExit(working)!==0||!!working.stdout.trim();
let before:ReleaseSourceSnapshot|null=null,after:ReleaseSourceSnapshot|null=null;
let compiled:ReturnType<typeof compileDeploymentArtifacts>|null=null,privateBytes:Buffer|null=null,privateInputPath:string|null=null;
let report:Record<string,unknown>={status:'FAIL',reason:'DAY4_ASSET_FAILURE_SOURCE_UNAVAILABLE'};
let exitCode=1,publicRpcInspectionAttempted=false,traceCallsAttempted=0;
function privateInput(path:string){
  const check=()=>{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600
    ||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw Error('DAY4_ASSET_FAILURE_PRIVATE_INPUT_INVALID');};
  try{check();const bytes=readPrivateOriginJson(path);check();return bytes;}catch{throw Error('DAY4_ASSET_FAILURE_PRIVATE_INPUT_INVALID');}
}
try{
  if(process.argv.length!==2)throw Error('DAY4_ASSET_FAILURE_ARGUMENT_INVALID');
  before=captureReleaseSource();
  if(commandExit(working)!==0)throw Error('DAY4_ASSET_FAILURE_SOURCE_UNAVAILABLE');
  if(existsSync('.env'))loadEnvFile('.env');
  const names=['CHAIN_ID','DEPLOYER_ADDRESS','CVA_ADDRESS','CVI_VALIDATOR_ADDRESS','CVA_POLICY_ADDRESS','ELIGIBILITY_GATE_ADDRESS',
    'ARBITER_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','CLEANVERSE_GATE_NONCE','PRIVY_EXECUTOR_ADDRESS','D4_ASSET_FAILURES_PATH'];
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length)report={status:'BLOCKED',reason:'DAY4_ASSET_FAILURE_CONFIGURATION_MISSING',missing};
  else{
    const config=Day4AssetFailureConfigSchema.safeParse({chainId:process.env.CHAIN_ID,deployer:process.env.DEPLOYER_ADDRESS,
      asset:process.env.CVA_ADDRESS,validator:process.env.CVI_VALIDATOR_ADDRESS,policy:process.env.CVA_POLICY_ADDRESS,
      gate:process.env.ELIGIBILITY_GATE_ADDRESS,pool:process.env.ARBITER_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,
      committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim()),gateNonce:process.env.CLEANVERSE_GATE_NONCE,
      executor:process.env.PRIVY_EXECUTOR_ADDRESS});
    if(!config.success)throw Error('DAY4_ASSET_FAILURE_CONFIGURATION_INVALID');
    privateInputPath=process.env.D4_ASSET_FAILURES_PATH!;privateBytes=privateInput(privateInputPath);
    let request;
    try{request=Day4AssetFailureRequestSchema.parse(strictJsonParse(privateBytes.toString('utf8')));}catch{throw Error('DAY4_ASSET_FAILURE_PRIVATE_INPUT_INVALID');}
    compiled=compileDeploymentArtifacts();
    // One fixed HTTPS public chain endpoint: no caller RPC, wallet, signing,
    // CCIP, multicall, batch, retry, redirect or arbitrary state override.
    const client=createPublicClient({ccipRead:false,batch:{multicall:false},transport:http('https://testnet-rpc.monad.xyz',
      {batch:false,retryCount:0,timeout:10000,maxResponseBodySize:1_048_576,fetchOptions:{redirect:'error'}})});
    const creations=day4CreationPairPort(client),flow=day4ChainFlowPort(client,{chainId:config.data.chainId,arbiter:config.data.pool,
      asset:config.data.asset,gate:config.data.gate,reviewer:config.data.reviewer,committee:config.data.committee,executor:config.data.executor});
    const trace=day4FailureTracePort();
    // CreationPair's interface selects common transaction fields, but its actual
    // viem getTransaction/getTransactionReceipt returns the complete originals.
    // This cast preserves gas, gasUsed and logs; it does not map or synthesize them.
    const port:Day4AssetFailurePort=Object.freeze({...creations,
      transaction:creations.transaction as Day4AssetFailurePort['transaction'],receipt:creations.receipt as Day4AssetFailurePort['receipt'],
      orderAt:flow.orderAt,traceTransaction:((hash)=>{traceCallsAttempted++;return trace.traceTransaction(hash);}) as Day4AssetFailurePort['traceTransaction']});
    publicRpcInspectionAttempted=true;
    const inspection=await inspectDay4AssetFailures(request,config.data,compiled.artifacts,port);
    compiled.assertCurrent();report={status:inspection.status,reason:'DAY4_ASSET_FAILURE_FIXED_OBSERVATIONS',inspection};
    exitCode=inspection.status==='COMPLETE'?0:1;
  }
}catch(error){
  const reason=error instanceof Error&&/^(?:DAY4_(?:ASSET_FAILURE|CREATIONS)_[A-Z_]{1,96}|DEPLOYMENT_(?:BUILD_UNAVAILABLE|ARTIFACT_SOURCE_MISMATCH))$/.test(error.message)
    ?error.message:'DAY4_ASSET_FAILURE_INPUT_OR_READ_INVALID';
  const blocked=/(?:READ_UNAVAILABLE|BUILD_UNAVAILABLE|PENDING|CODE_MISSING|BLOCK_UNAVAILABLE|NOT_FINALIZED)$/.test(reason);
  report={status:blocked?'BLOCKED':'FAIL',reason};exitCode=1;
}
try{
  after=captureReleaseSource();const finalWorking=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
  if(!sameReleaseSource(before,after)||commandExit(finalWorking)!==0||working.stdout!==finalWorking.stdout)throw Error('DAY4_ASSET_FAILURE_SOURCE_CHANGED');
  if(compiled&&!compiled.isCurrent())throw Error('DAY4_ASSET_FAILURE_ARTIFACT_CHANGED');
  if(privateBytes&&privateInputPath&&!privateBytes.equals(privateInput(privateInputPath)))throw Error('DAY4_ASSET_FAILURE_PRIVATE_INPUT_CHANGED');
}catch(error){
  const reason=error instanceof Error&&/^DAY4_ASSET_FAILURE_(?:SOURCE|ARTIFACT|PRIVATE_INPUT)_CHANGED$/.test(error.message)
    ?error.message:'DAY4_ASSET_FAILURE_SOURCE_UNAVAILABLE';report={status:'FAIL',reason};exitCode=1;
}
try{
  const output={schemaVersion:1,scope:'LIVE_FIXED_PUBLIC_MONAD_ASSET_FAILURES_NOT_D4_EXTERNAL_ACCEPTANCE',startedAt,endedAt:new Date().toISOString(),
    sourceCommit:before?.sourceCommit??null,worktreeDirty,sourceObservation:{before,after},sourceStable:sameReleaseSource(before,after),
    artifactBindings:compiled?.bindings??[],...report,publicRpcInspectionAttempted,traceCallsAttempted,
    financialAcceptanceStatus:'BLOCKED',officialIntegrationVerified:false,canPassD4:false,canExecute:false,signaturesRequested:0,transactionsSent:0,exitCode};
  const bytes=Buffer.from(JSON.stringify(output,null,2)+'\n');
  const sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY']
    .map(name=>process.env[name]).filter(value=>value&&value.length>=16);
  if(auditBytes('day4-asset-failures.json',bytes).length||sensitive.some(value=>bytes.includes(value!)))throw Error();
  const directory='artifacts/acceptance',path=`${directory}/day4-asset-failures.json`;mkdirSync(directory,{recursive:true});
  if(existsSync(path)){const history=`${directory}/history/${startedAt.replaceAll(':','-')}-day4-asset-failures`;mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/day4-asset-failures.json`,constants.COPYFILE_EXCL);}
  writeFileSync(path,bytes);
  console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,financialAcceptanceStatus:'BLOCKED',
    publicRpcInspectionAttempted,traceCallsAttempted,signaturesRequested:0,transactionsSent:0,evidence:path,exitCode}));
}catch{console.error('DAY4_ASSET_FAILURE_EVIDENCE_WRITE_UNAVAILABLE');exitCode=1;}
process.exitCode=exitCode;
