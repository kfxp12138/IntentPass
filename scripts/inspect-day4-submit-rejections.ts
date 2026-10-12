import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {createPublicClient,http} from 'viem';
import {Day4SubmitRejectionConfigSchema,Day4SubmitRejectionRequestSchema} from '../packages/protocol/src/day4-submit-rejection-types.js';
import {inspectDay4SubmitRejections} from '../packages/protocol/src/day4-submit-rejections.js';
import {day4SubmitRejectionPort} from '../packages/protocol/src/day4-submit-rejection-port.js';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {readPrivateOriginJson} from './private-origin-input.js';
import {strictJsonParse} from './strict-json.js';
import {auditBytes} from './public-audit.js';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {commandExit} from './verification-outcome.js';

const startedAt=new Date().toISOString();
const working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const worktreeDirty=commandExit(working)!==0||!!working.stdout.trim();
let before:ReleaseSourceSnapshot|null=null,after:ReleaseSourceSnapshot|null=null;
let compiled:ReturnType<typeof compileDeploymentArtifacts>|null=null;
let privateBytes:Buffer|null=null,privateInputPath:string|null=null;
let report:Record<string,unknown>={status:'FAIL',reason:'DAY4_SUBMIT_SOURCE_UNAVAILABLE'};
let exitCode=1,publicRpcInspectionAttempted=false,submitCallsAttempted=0;
try{
  if(process.argv.length!==2)throw Error('DAY4_SUBMIT_ARGUMENT_INVALID');
  before=captureReleaseSource();
  if(commandExit(working)!==0)throw Error('DAY4_SUBMIT_SOURCE_UNAVAILABLE');
  if(existsSync('.env'))loadEnvFile('.env');
  const names=['CHAIN_ID','DEPLOYER_ADDRESS','CVA_ADDRESS','CVI_VALIDATOR_ADDRESS','CVA_POLICY_ADDRESS','ELIGIBILITY_GATE_ADDRESS',
    'ARBITER_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','CLEANVERSE_GATE_NONCE','PRIVY_EXECUTOR_ADDRESS','D4_SUBMIT_REJECTIONS_PATH'];
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length)report={status:'BLOCKED',reason:'DAY4_SUBMIT_CONFIGURATION_MISSING',missing};
  else{
    const config=Day4SubmitRejectionConfigSchema.safeParse({chainId:process.env.CHAIN_ID,deployer:process.env.DEPLOYER_ADDRESS,
      asset:process.env.CVA_ADDRESS,validator:process.env.CVI_VALIDATOR_ADDRESS,policy:process.env.CVA_POLICY_ADDRESS,
      gate:process.env.ELIGIBILITY_GATE_ADDRESS,pool:process.env.ARBITER_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,
      committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim()),gateNonce:process.env.CLEANVERSE_GATE_NONCE,
      executor:process.env.PRIVY_EXECUTOR_ADDRESS});
    if(!config.success)throw Error('DAY4_SUBMIT_CONFIGURATION_INVALID');
    privateInputPath=process.env.D4_SUBMIT_REJECTIONS_PATH!;
    try{privateBytes=readPrivateOriginJson(privateInputPath);}catch{throw Error('DAY4_SUBMIT_PRIVATE_INPUT_INVALID');}
    let request;
    try{request=Day4SubmitRejectionRequestSchema.parse(strictJsonParse(privateBytes.toString('utf8')));}
    catch{throw Error('DAY4_SUBMIT_PRIVATE_INPUT_INVALID');}
    compiled=compileDeploymentArtifacts();
    // This live collector has one fixed public endpoint, no caller-selected RPC,
    // wallet client, signing key, retry, redirect, batch or state override.
    const client=createPublicClient({ccipRead:false,batch:{multicall:false},transport:http('https://testnet-rpc.monad.xyz',
      {batch:false,retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    const port=day4SubmitRejectionPort(client);
    const markedPort=Object.freeze({...port,submitCall:((input)=>{
      submitCallsAttempted++;
      return port.submitCall(input);
    }) as typeof port.submitCall});
    publicRpcInspectionAttempted=true;
    const inspection=await inspectDay4SubmitRejections(request,config.data,compiled.artifacts,markedPort);
    compiled.assertCurrent();
    report={status:inspection.status,reason:'DAY4_SUBMIT_FIXED_CALL_OBSERVATIONS',inspection};
    exitCode=inspection.status==='COMPLETE'?0:1;
  }
}catch(error){
  const reason=error instanceof Error&&/^(?:DAY4_(?:SUBMIT|CREATIONS)_[A-Z_]{1,96}|DEPLOYMENT_(?:BUILD_UNAVAILABLE|ARTIFACT_SOURCE_MISMATCH))$/.test(error.message)
    ?error.message:'DAY4_SUBMIT_INPUT_OR_READ_INVALID';
  const blocked=/(?:READ_UNAVAILABLE|BUILD_UNAVAILABLE|PENDING|CODE_MISSING|BLOCK_UNAVAILABLE|NOT_FINALIZED)$/.test(reason);
  report={status:blocked?'BLOCKED':'FAIL',reason};exitCode=1;
}
try{
  after=captureReleaseSource();
  const finalWorking=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
  if(!sameReleaseSource(before,after)||commandExit(finalWorking)!==0||working.stdout!==finalWorking.stdout)
    throw Error('DAY4_SUBMIT_SOURCE_CHANGED');
  if(compiled&&!compiled.isCurrent())throw Error('DAY4_SUBMIT_ARTIFACT_CHANGED');
  if(privateBytes&&privateInputPath&&!privateBytes.equals(readPrivateOriginJson(privateInputPath)))throw Error('DAY4_SUBMIT_PRIVATE_INPUT_CHANGED');
}catch(error){
  const reason=error instanceof Error&&/^DAY4_SUBMIT_(?:SOURCE|ARTIFACT|PRIVATE_INPUT)_CHANGED$/.test(error.message)
    ?error.message:'DAY4_SUBMIT_SOURCE_UNAVAILABLE';
  report={status:'FAIL',reason};exitCode=1;
}
try{
  const output={schemaVersion:1,scope:'LIVE_FIXED_PUBLIC_MONAD_SUBMIT_CALLS_NOT_D4_EXTERNAL_ACCEPTANCE',startedAt,endedAt:new Date().toISOString(),
    sourceCommit:before?.sourceCommit??null,worktreeDirty,sourceObservation:{before,after},sourceStable:sameReleaseSource(before,after),
    artifactBindings:compiled?.bindings??[],...report,publicRpcInspectionAttempted,submitCallsAttempted,
    financialAcceptanceStatus:'BLOCKED',officialIntegrationVerified:false,canPassD4:false,canExecute:false,signaturesRequested:0,transactionsSent:0,exitCode};
  const bytes=Buffer.from(JSON.stringify(output,null,2)+'\n');
  const sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY']
    .map(name=>process.env[name]).filter(value=>value&&value.length>=16);
  if(auditBytes('day4-submit-rejections.json',bytes).length||sensitive.some(value=>bytes.includes(value!)))throw Error();
  const directory='artifacts/acceptance',path=`${directory}/day4-submit-rejections.json`;mkdirSync(directory,{recursive:true});
  if(existsSync(path)){const history=`${directory}/history/${startedAt.replaceAll(':','-')}-day4-submit-rejections`;mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/day4-submit-rejections.json`);}
  writeFileSync(path,bytes);
  console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,financialAcceptanceStatus:'BLOCKED',
    publicRpcInspectionAttempted,submitCallsAttempted,signaturesRequested:0,transactionsSent:0,evidence:path,exitCode}));
}catch{console.error('DAY4_SUBMIT_EVIDENCE_WRITE_UNAVAILABLE');exitCode=1;}
process.exitCode=exitCode;
