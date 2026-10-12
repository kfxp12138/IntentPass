import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {createPublicClient,http} from 'viem';
import {inspectDay4ChainFlow} from '../packages/protocol/src/day4-chain-flow.js';
import {day4ChainFlowPort} from '../packages/protocol/src/day4-chain-flow-port.js';
import {Day4ChainFlowDeploymentSchema,Day4ChainFlowRequestSchema} from '../packages/protocol/src/day4-chain-flow-types.js';
import {readStableReleaseJson} from './release-review.js';
import {strictJsonParse} from './strict-json.js';
import {auditBytes} from './public-audit.js';
import {commandExit} from './verification-outcome.js';

const startedAt=new Date().toISOString();
// Source identity precedes this invocation's first archive or evidence write.
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const sourceCommit=commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty=commandExit(working)!==0||!!working.stdout.trim();
const sourcePaths=['packages/protocol/src/day4-chain-flow-types.ts','packages/protocol/src/day4-chain-flow.ts','packages/protocol/src/day4-chain-flow-port.ts',
  'packages/protocol/src/escrow-read.ts','packages/protocol/src/escrow-abi.ts','packages/protocol/src/funding.ts','packages/protocol/src/allocation.ts',
  'packages/protocol/src/withdrawal.ts','packages/protocol/src/fulfillment.ts','packages/protocol/src/report.ts','packages/protocol/src/schemas.ts',
  'packages/protocol/src/index.ts','packages/protocol/src/typed-data.ts','packages/protocol/src/escrow.ts','packages/protocol/src/original-order-read.ts',
  'packages/protocol/src/review-evidence.ts','packages/protocol/src/evidence-version.ts','packages/protocol/src/route.ts',
  'packages/capsule/src/format.ts','packages/capsule/src/recovery.ts','packages/capsule/src/crypto.ts','scripts/inspect-day4-chain-flow.ts',
  'scripts/release-review.ts','scripts/strict-json.ts','scripts/public-audit.ts','scripts/verification-outcome.ts','package.json','.env.example','pnpm-lock.yaml'];
const bindings=()=>sourcePaths.map(path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
let report:Record<string,unknown>,exitCode=1,publicRpcInspectionAttempted=false,sourceBindings:ReturnType<typeof bindings>=[];
try{
  if(process.argv.length!==2)throw Error('ARGUMENT_INVALID');
  if(!sourceCommit||!(/^[a-f0-9]{40}$/).test(sourceCommit)||commandExit(working)!==0)throw Error('SOURCE_REVISION_UNAVAILABLE');
  sourceBindings=bindings();
  if(existsSync('.env'))loadEnvFile('.env');
  const names=['CHAIN_ID','ARBITER_ADDRESS','CVA_ADDRESS','ELIGIBILITY_GATE_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES',
    'PRIVY_EXECUTOR_ADDRESS','MONAD_RPC_URL','D4_CHAIN_FLOW_PATH'];
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length){report={status:'BLOCKED',reason:'DAY4_CHAIN_FLOW_CONFIGURATION_MISSING',missing};}
  else{
    const deployment=Day4ChainFlowDeploymentSchema.safeParse({chainId:process.env.CHAIN_ID,arbiter:process.env.ARBITER_ADDRESS,asset:process.env.CVA_ADDRESS,
      gate:process.env.ELIGIBILITY_GATE_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,executor:process.env.PRIVY_EXECUTOR_ADDRESS,
      committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim())});
    if(!deployment.success)throw Error('DAY4_FLOW_CONFIGURATION_INVALID');
    let request;
    try{request=Day4ChainFlowRequestSchema.parse(strictJsonParse(readStableReleaseJson(process.env.D4_CHAIN_FLOW_PATH!).toString('utf8')));}
    catch{throw Error('DAY4_FLOW_PRIVATE_INPUT_INVALID');}
    let endpoint:URL;try{endpoint=new URL(process.env.MONAD_RPC_URL!);}catch{throw Error('RPC_ENDPOINT_INVALID');}
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw Error('RPC_ENDPOINT_INVALID');
    const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    publicRpcInspectionAttempted=true;
    const inspection=await inspectDay4ChainFlow(request,deployment.data,day4ChainFlowPort(client,deployment.data));
    report={status:'CHAIN_FLOW_VERIFIED',reason:'CONFIGURED_ORIGINAL_PAID_CHAIN_EFFECTS_VERIFIED',inspection};exitCode=0;
  }
}catch(error){
  const code=error instanceof Error&&/^(?:DAY4_FLOW_[A-Z_]+|ARGUMENT_INVALID|SOURCE_REVISION_UNAVAILABLE|RPC_ENDPOINT_INVALID)$/.test(error.message)
    ?error.message:'DAY4_FLOW_READ_UNAVAILABLE';
  const blocked=['DAY4_FLOW_READ_UNAVAILABLE','DAY4_FLOW_TRANSACTION_PENDING'].includes(code);
  report={status:blocked?'BLOCKED':'FAIL',reason:code};exitCode=1;
}
try{
  const finalRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),finalWorking=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
  if(JSON.stringify(sourceBindings)!==JSON.stringify(bindings())||commandExit(finalRevision)!==0||commandExit(finalWorking)!==0
    ||finalRevision.stdout!==revision.stdout||finalWorking.stdout!==working.stdout){report={status:'FAIL',reason:'DAY4_FLOW_SOURCE_CHANGED'};exitCode=1;}
  const publicReport={schemaVersion:1,scope:'READ_ONLY_ORIGINAL_CHAIN_FLOW_NOT_D4_EXTERNAL_ACCEPTANCE',startedAt,endedAt:new Date().toISOString(),
    sourceCommit,worktreeDirty,sourceBindings,...report,publicRpcInspectionAttempted,
    financialAcceptanceStatus:'BLOCKED',canExecute:false,officialIntegrationVerified:false,privyOriginVerified:false,deploymentCreationVerified:false,
    signaturesRequested:0,transactionsSent:0,exitCode};
  const bytes=Buffer.from(JSON.stringify(publicReport,null,2)+'\n');
  if(auditBytes('day4-chain-flow.json',bytes).length)throw Error('PUBLIC_OUTPUT_UNSAFE');
  // Exact provided credentials are checked without exposing their value or fingerprint.
  const sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY'].map(name=>process.env[name]).filter(value=>value&&value.length>=16);
  if(sensitive.some(value=>bytes.includes(value!)))throw Error('PUBLIC_OUTPUT_UNSAFE');
  const directory='artifacts/acceptance',path=`${directory}/day4-chain-flow.json`;mkdirSync(directory,{recursive:true});
  if(existsSync(path)){const history=`${directory}/history/${startedAt.replaceAll(':','-')}-day4-chain-flow`;mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/day4-chain-flow.json`);}
  writeFileSync(path,bytes);
  console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,
    financialAcceptanceStatus:'BLOCKED',publicRpcInspectionAttempted,transactionsSent:0,evidence:path,exitCode}));
}catch{console.error('DAY4_CHAIN_FLOW_EVIDENCE_WRITE_UNAVAILABLE');exitCode=1;}
process.exitCode=exitCode;
