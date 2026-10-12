import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadEnvFile} from 'node:process';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {runPlannerSmokeOnce,plannerSmokeFailure,plannerSmokeReportBytes,plannerSmokeLimits,assertPlannerSmokePublicBytes,type PlannerSmokeResult} from './planner-smoke-evidence.js';

const startedAt=new Date().toISOString(),invocationId=randomUUID();
let source:ReleaseSourceSnapshot|null=null,sourceStable=false,result:PlannerSmokeResult=plannerSmokeFailure('PLANNER_SOURCE_UNAVAILABLE');
const working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'}),worktreeDirty=working.status!==0||!!working.stdout.trim();
try{
  if(process.argv.length!==2){result=plannerSmokeFailure('PLANNER_ARGUMENT_INVALID');throw Error('STOP');}
  try{source=captureReleaseSource();}catch{throw Error('STOP');}
  // Root alone runs this command. Private environment bytes are never copied,
  // hashed, logged or incorporated into the source snapshot/public report.
  try{
    if(existsSync('.env')){
      const before=lstatSync('.env');
      if(!before.isFile()||before.isSymbolicLink()||(before.mode&0o777)!==0o600||before.nlink!==1||typeof process.getuid==='function'&&before.uid!==process.getuid())throw Error();
      loadEnvFile('.env');const after=lstatSync('.env');
      if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.mode!==after.mode||before.uid!==after.uid||after.nlink!==1)throw Error();
    }
  }catch{result=plannerSmokeFailure('PLANNER_PRIVATE_ENV_INVALID');throw Error('STOP');}
  result=await runPlannerSmokeOnce({endpoint:process.env.PLANNER_API_URL,key:process.env.PLANNER_API_KEY,model:process.env.PLANNER_MODEL});
}catch{/* No exception text, provider body or private configuration is emitted. */}
try{sourceStable=source!==null&&sameReleaseSource(source,captureReleaseSource());}catch{/* Source identity is not inferred. */}
if(source!==null&&!sourceStable)result=plannerSmokeFailure('PLANNER_SOURCE_CHANGED',result.requestAttempts,result.httpStatus);
const exitCode=result.status==='PASS'?0:1;
process.exitCode=exitCode;
const secrets=['PLANNER_API_KEY','TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PRIVY_REVIEWER_AUTHORIZATION_PRIVATE_KEY']
  .map(name=>process.env[name]).filter((value):value is string=>!!value);
try{
  const bytes=plannerSmokeReportBytes({schemaVersion:1,invocationId,scope:'REAL_PLANNER_SYNTHETIC_FINITE_SELECTION_ONLY',startedAt,endedAt:new Date().toISOString(),
    source,sourceStable,worktreeDirty,...result,retries:0,credentialsRecorded:false,authorizationHeadersRecorded:false,providerBodyRecorded:false,
    providerReasoningRecorded:false,privateTaskPayloadRecorded:false,canExecute:false,financialAcceptanceStatus:'BLOCKED',signaturesRequested:0,transactionsSent:0,exitCode,limits:plannerSmokeLimits},secrets);
  const folder='artifacts/acceptance/planner-smoke';mkdirSync(folder,{recursive:true});
  if(realpathSync(folder)!==resolve(folder))throw Error('PLANNER_SMOKE_EVIDENCE_PATH_INVALID');
  const path=`${folder}/${Date.now()}-${invocationId}.json`,summary=Buffer.from(JSON.stringify({status:result.status,code:result.code,httpStatus:result.httpStatus,
    requestAttempts:result.requestAttempts,sourceStable,financialAcceptanceStatus:'BLOCKED',evidence:path,exitCode}));
  assertPlannerSmokePublicBytes(summary,secrets);writeFileSync(path,bytes,{flag:'wx'});console.log(summary.toString('utf8'));
}catch{
  process.exitCode=1;const message=Buffer.from('PLANNER_SMOKE_EVIDENCE_WRITE_UNAVAILABLE');
  try{assertPlannerSmokePublicBytes(message,secrets);console.error(message.toString('utf8'));}catch{/* No unsafe output is emitted. */}
}
