import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadEnvFile} from 'node:process';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ReviewService} from '../apps/web/src/services/review.js';
import {JevHttp,aggregateJev,type JevResult,type JevPort} from '../packages/adapters/src/jev-review.js';
import {loadReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {ReviewStore} from '../packages/storage/src/review-store.js';
import {contextHash} from '../packages/protocol/src/index.js';
import {verifyQuoteSignature,verifyReceiptSignature} from '../packages/protocol/src/typed-data.js';
import {applicationReviewSmokeCases} from './application-review-smoke.js';

const version2=process.argv.length===3&&process.argv[2]==='--v2',path=version2?'artifacts/acceptance/review-v2/application-smoke.json':'artifacts/acceptance/application-review-smoke.json';
// Reserve this single smoke run before calls. Failed/partial runs are evidence,
// never a reason to regenerate inputs or query the provider until PASS.
if(process.argv.length!==2&&!version2){console.error('APPLICATION_SMOKE_ARGUMENTS_INVALID');process.exit(1);}
if(existsSync(path)){console.error('APPLICATION_SMOKE_ALREADY_RECORDED');process.exit(1);}
if(existsSync('.env'))loadEnvFile('.env');
const key=process.env.TYPESAFE_API_KEY,model=process.env.JEV_MODEL,policyPath=version2?'artifacts/acceptance/review-v2/policy.json':process.env.REVIEW_POLICY_PATH;
if(!key||!model||!policyPath){console.error('APPLICATION_SMOKE_JEV_CONFIGURATION_REQUIRED');process.exit(1);}
let rule:ReturnType<typeof loadReviewPolicy>;
try{rule=loadReviewPolicy(policyPath,model);}catch{console.error('APPLICATION_SMOKE_FROZEN_POLICY_REQUIRED');process.exit(1);}
if(version2&&rule.questionVersion!==2){console.error('APPLICATION_SMOKE_QUESTION_VERSION_INVALID');process.exit(1);}
const startedAt=new Date().toISOString(),clock=()=>BigInt(Math.floor(Date.now()/1000));
const fixture=await applicationReviewSmokeCases(clock()),directory=mkdtempSync(join(tmpdir(),'intentpass-live-review-')),dbPath=join(directory,'review.db');
const domain={chainId:fixture.deployment.chainId,arbiter:fixture.deployment.arbiter};
let store=new ReviewStore(dbPath),calls=0,signs=0;
const rows:unknown[]=[],providerRecords:{state:unknown;startedAt:string;endedAt?:string;durationMs?:number;raw?:JevResult;error?:string}[]=[];
const evidence={schemaVersion:1,scope:'REAL_JEV_APPLICATION_SERVICE_PUBLIC_SYNTHETIC_QUOTES_LOCAL_SIGNER',stage:'D2',settlementRoute:'context-vote-escrow',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceWorktreeDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,startedAt,model:rule.model,questionVersion:rule.questionVersion??1,minConfidence:rule.minConfidence,questionConfigHash:rule.questionConfigHash,frozenPolicySha256:createHash('sha256').update(readFileSync(policyPath)).digest('hex'),deployment:fixture.deployment,inputs:fixture.cases,limitations:['Public synthetic new application inputs; not a development or holdout re-evaluation.','Principal is local; authentication, Privy and wallet UI are not exercised.','Addresses are random local test configuration; no deployed contract, CVI/CVA, transfer or financial capability.','Receipt signatures use an ephemeral local test reviewer, not the configured production reviewer.','No planner calls or user Grant signatures. No threshold or prompt tuning, provider retries or best-of.'],results:rows,providerRecords};
let reserved=false;
function save(status:'IN_PROGRESS'|'PASS'|'FAIL',extra:Record<string,unknown>={}){mkdirSync(version2?'artifacts/acceptance/review-v2':'artifacts/acceptance',{recursive:true});writeFileSync(path,JSON.stringify({...evidence,status,providerRequests:calls,judgments:providerRecords.filter(r=>r.raw).length*3,localReceiptSignatures:signs,...extra},null,2)+'\n',reserved?undefined:{flag:'wx'});reserved=true;}
const live=new JevHttp(key,rule.model,undefined,rule.questionVersion??1);
const observed:JevPort={model:rule.model,questionVersion:live.questionVersion,evaluate:async state=>{
  calls++;const started=performance.now(),record:{state:unknown;startedAt:string;endedAt?:string;durationMs?:number;raw?:JevResult;error?:string}={state,startedAt:new Date().toISOString()};providerRecords.push(record);save('IN_PROGRESS');
  try{record.raw=await live.evaluate(state);return record.raw;}catch(error){record.error=error instanceof Error&&/^JEV_(HTTP_\d+|MODEL_MISMATCH|RESPONSE_INVALID|RESPONSE_TOO_LARGE)$/.test(error.message)?error.message:'JEV_UNAVAILABLE_OR_INVALID';throw new Error(record.error);}finally{record.endedAt=new Date().toISOString();record.durationMs=Math.round(performance.now()-started);save('IN_PROGRESS');}
}};
const signer={address:fixture.signer.address,sign:async(...args:Parameters<typeof fixture.signer.sign>)=>{signs++;return fixture.signer.sign(...args);}};
let service=new ReviewService(observed,fixture.deployment,rule.minConfidence,signer,clock,store);
try{
  save('IN_PROGRESS');
  for(const item of fixture.cases){
    const before={calls,signs},result=await service.review(item.input,fixture.principal),raw=providerRecords.at(-1)?.raw;
    const checks={expectedDecision:result.decision===item.expected,oneProviderRequest:calls===before.calls+1,validOriginalQuote:await verifyQuoteSignature(item.input.quote,domain),aggregationMatches:!!raw&&result.source==='JEV'&&aggregateJev(raw,rule.minConfidence)===result.decision,receiptValid:false,restartResultIdentical:false,restartRequestsUnchanged:false,restartSignaturesUnchanged:false};
    if(result.source==='JEV'&&result.executable){checks.receiptValid=await verifyReceiptSignature(result.receipt,domain)&&result.receipt.contextHash===contextHash(item.input.intent)&&result.receipt.questionConfigHash===rule.questionConfigHash&&result.receipt.modelId===rule.model;}
    else checks.receiptValid=item.expected!=='PASS'&&signs===before.signs&&!('receipt'in result);
    const after={calls,signs};store.close();store=new ReviewStore(dbPath);service=new ReviewService(observed,fixture.deployment,rule.minConfidence,signer,clock,store);
    const replay=await service.review(item.input,fixture.principal);checks.restartResultIdentical=JSON.stringify(replay)===JSON.stringify(result);checks.restartRequestsUnchanged=calls===after.calls;checks.restartSignaturesUnchanged=signs===after.signs;
    rows.push({id:item.id,expected:item.expected,result,replay,checks,passed:Object.values(checks).every(Boolean)});save('IN_PROGRESS');console.log(`${item.id}: ${result.decision}; restart reused original=${checks.restartResultIdentical}`);
  }
  const complete=fixture.cases[0].input,before={calls,signs};
  const failures=[{id:'over-budget',input:{...complete,intent:{...complete.intent,price:'11'}},code:'POLICY_CONTRADICTED'},{id:'invalid-quote-signature',input:{...complete,quote:{...complete.quote,signature:`0x${'0'.repeat(130)}`}},code:'QUOTE_INVALID'}];
  const hardRuleResults=[];for(const item of failures){const result=await service.review(item.input,fixture.principal);hardRuleResults.push({id:item.id,result,passed:result.source==='HARD_RULE'&&result.decision==='REJECT'&&result.code===item.code});}
  const hardRuleRequestsUnchanged=calls===before.calls,hardRuleSignaturesUnchanged=signs===before.signs,privateJournalMode=statSync(dbPath).mode&0o777;
  const passed=rows.every(row=>(row as {passed:boolean}).passed)&&hardRuleResults.every(row=>row.passed)&&hardRuleRequestsUnchanged&&hardRuleSignaturesUnchanged&&privateJournalMode===0o600;
  save(passed?'PASS':'FAIL',{endedAt:new Date().toISOString(),hardRuleResults,hardRuleRequestsUnchanged,hardRuleSignaturesUnchanged,privateJournalMode:'0'+privateJournalMode.toString(8),summary:{planned:3,completed:rows.length,matchingDecisions:rows.filter(row=>(row as {checks:{expectedDecision:boolean}}).checks.expectedDecision).length}});
  assert.equal(passed,true,'APPLICATION_SMOKE_CHECK_FAILED');
  console.log(`Application review smoke PASS: ${calls} real requests; ${signs} local-only receipt; no requests/signatures on restart.`);
}catch{
  if(reserved){const current=JSON.parse(readFileSync(path,'utf8'));if(current.status==='IN_PROGRESS')save('FAIL',{endedAt:new Date().toISOString(),error:'APPLICATION_SMOKE_CHECK_FAILED'});console.error('APPLICATION_SMOKE_CHECK_FAILED (original results retained)');}
  else console.error('APPLICATION_SMOKE_RESERVATION_FAILED (no provider request)');process.exitCode=1;
}finally{store.close();rmSync(directory,{recursive:true,force:true});}
