import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {createPublicClient,http} from 'viem';
import {inspectCleanverseEligibility} from '../packages/protocol/src/cleanverse-inspection.js';
import {cleanverseInspectionPort} from '../packages/protocol/src/cleanverse-inspection-port.js';
import {CleanverseInspectionInputSchema} from '../packages/protocol/src/cleanverse-inspection-types.js';
import {commandExit} from './verification-outcome.js';

const startedAt=new Date().toISOString();
// Capture before this invocation archives or publishes its own evidence.
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
const working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const sourceCommit=commandExit(revision)===0?revision.stdout.trim():null;
const worktreeDirty=commandExit(working)!==0||!!working.stdout.trim();
const directory='artifacts/acceptance',path=`${directory}/cleanverse-inspection.json`;
const sourcePaths=['packages/protocol/src/cleanverse-inspection-types.ts','packages/protocol/src/cleanverse-inspection.ts',
  'packages/protocol/src/cleanverse-inspection-port.ts','scripts/inspect-cleanverse.ts','packages/protocol/src/schemas.ts','pnpm-lock.yaml'];
sourcePaths.push('scripts/verification-outcome.ts','.env.example','package.json');
let report:Record<string,unknown>;
let exitCode=1;
try{
  if(process.argv.length!==2)throw Error('ARGUMENT_INVALID');
  if(!sourceCommit||!(/^[a-f0-9]{40}$/).test(sourceCommit)||commandExit(working)!==0)throw Error('SOURCE_REVISION_UNAVAILABLE');
  if(existsSync('.env'))loadEnvFile('.env');
  const names=['CHAIN_ID','CVA_ADDRESS','CVI_VALIDATOR_ADDRESS','CVA_POLICY_ADDRESS','ARBITER_ADDRESS','MONAD_RPC_URL',
    'CLEANVERSE_INSPECTION_FROM','CLEANVERSE_INSPECTION_TO','CLEANVERSE_INSPECTION_AMOUNT'];
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length){
    report={status:'BLOCKED',reason:'CLEANVERSE_INSPECTION_CONFIGURATION_MISSING',missing};
  }else{
    const parsed=CleanverseInspectionInputSchema.safeParse({
      config:{chainId:process.env.CHAIN_ID,asset:process.env.CVA_ADDRESS,validator:process.env.CVI_VALIDATOR_ADDRESS,
        policy:process.env.CVA_POLICY_ADDRESS,pool:process.env.ARBITER_ADDRESS},
      request:{from:process.env.CLEANVERSE_INSPECTION_FROM,to:process.env.CLEANVERSE_INSPECTION_TO,amount:process.env.CLEANVERSE_INSPECTION_AMOUNT}
    });
    if(!parsed.success)throw Error('CLEANVERSE_INSPECTION_CONFIGURATION_INVALID');
    let endpoint:URL;
    try{endpoint=new URL(process.env.MONAD_RPC_URL!);}catch{throw Error('RPC_ENDPOINT_INVALID');}
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw Error('RPC_ENDPOINT_INVALID');
    const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    const inspection=await inspectCleanverseEligibility(parsed.data,cleanverseInspectionPort(client));
    exitCode=inspection.status==='COMPLETE'?0:1;
    report={status:inspection.status==='COMPLETE'?'INSPECTED':inspection.status,
      reason:inspection.status==='COMPLETE'?(inspection.eligibility==='ALLOWED'?'CONFIGURED_QUERIES_RETURNED_ALLOW':'CONFIGURED_QUERIES_RETURNED_DENIAL')
        :'CONFIGURED_QUERIES_INCOMPLETE_OR_INVALID',inspection};
  }
}catch(error){
  const safeCodes=['ARGUMENT_INVALID','SOURCE_REVISION_UNAVAILABLE','CLEANVERSE_INSPECTION_CONFIGURATION_INVALID','RPC_ENDPOINT_INVALID'];
  const code=error instanceof Error&&safeCodes.includes(error.message)?error.message:'CLEANVERSE_INSPECTION_UNAVAILABLE';
  report={status:safeCodes.slice(0,4).includes(code)?'FAIL':'BLOCKED',reason:code};
}
try{
  const sourceBindings=sourcePaths.map(path=>{
    const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  report={schemaVersion:1,scope:'READ_ONLY_CLEANVERSE_INTERFACE_DIAGNOSTIC_NOT_D4_ACCEPTANCE',startedAt,endedAt:new Date().toISOString(),
    sourceCommit,worktreeDirty,sourceBindings,...report,
    financialAcceptanceStatus:'BLOCKED',canExecute:false,officialIntegrationVerified:false,signaturesRequested:0,transactionsSent:0,
    limits:['Configured addresses are not independently authenticated as official deployments.',
      'Queries do not prove actual identity enrollment, gas, balances, allowances, Privy authorization or token transfer.',
      'A false pool registration is distinct from a false subject compliance result.',
      'Missing or malformed interfaces never count as identity denial; this diagnostic cannot make D4 PASS.'],exitCode};
  mkdirSync(directory,{recursive:true});
  if(existsSync(path)){
    const history=`${directory}/history/${startedAt.replaceAll(':','-')}-cleanverse-inspection`;
    mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/cleanverse-inspection.json`);
  }
  writeFileSync(path,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,
    inspectionStatus:(report.inspection as {status?:string}|undefined)?.status,
    eligibility:(report.inspection as {eligibility?:string}|undefined)?.eligibility,
    financialAcceptanceStatus:'BLOCKED',transactionsSent:0,evidence:path,exitCode}));
}catch{
  console.error('CLEANVERSE_INSPECTION_EVIDENCE_WRITE_UNAVAILABLE');exitCode=1;
}
process.exitCode=exitCode;
