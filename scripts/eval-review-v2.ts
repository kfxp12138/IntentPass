import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {JevHttp,questionConfigHash} from '../packages/adapters/src/jev-review.js';
import {loadReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {calibrateDevelopment} from './review-calibration.js';
import {evaluationSha,evaluationPlan,ruleOnlyComparison,runSemanticEvaluation,evaluationSummary} from './review-evaluation.js';
const mode=process.argv[2],base='artifacts/acceptance/review-v2',policyPath=`${base}/policy.json`,devPath=`${base}/dev.json`,calibratedPath=`${base}/dev-calibrated.json`;
if(process.argv.length!==3||!['--dev','--freeze','--holdout','--critical'].includes(mode)){console.error('USAGE_REVIEW_V2_DEV_FREEZE_HOLDOUT_CRITICAL');process.exit(1);}
const manifest=JSON.parse(readFileSync('fixtures/review-v2/manifest.json','utf8'));
if(manifest.questionVersion!==2||manifest.candidateQuestionConfigHash!==questionConfigHash(.9,2))throw new Error('FROZEN_V2_QUESTIONS_CHANGED');
const split=mode.slice(2) as 'dev'|'freeze'|'holdout'|'critical',fixturePath=`fixtures/review-v2/${split==='holdout'?'holdout':'dev'}.json`,entry=manifest.files.find((f:{path:string})=>f.path===fixturePath),fixtureText=readFileSync(fixturePath,'utf8');
if(!entry||evaluationSha(fixtureText)!==entry.sha256||entry.count!==(split==='holdout'?24:12))throw new Error('FROZEN_V2_COHORT_CHANGED');
mkdirSync(base,{recursive:true});
if(split==='freeze'){
  try{const source=readFileSync(devPath,'utf8'),dev=JSON.parse(source);
    if(existsSync(policyPath)){const old=JSON.parse(readFileSync(calibratedPath,'utf8'));loadReviewPolicy(policyPath,dev.model);if(old.calibration?.sourceReportSha256!==evaluationSha(source))throw new Error('FROZEN_V2_POLICY_SOURCE_CHANGED');console.log('Existing identical version 2 policy; provider requests 0.');}
    else{for(const name of ['holdout','critical'])if(existsSync(`${base}/${name}.json`))throw new Error('V2_INDEPENDENT_ALREADY_STARTED');const calibrated=calibrateDevelopment(dev,fixtureText,entry.sha256,2);calibrated.calibration={...calibrated.calibration,sourceReportPath:devPath,sourceReportSha256:evaluationSha(source)} as typeof calibrated.calibration;const text=JSON.stringify(calibrated,null,2)+'\n';writeFileSync(calibratedPath,text,{flag:'wx'});writeFileSync(policyPath,JSON.stringify({version:2,questionVersion:2,model:calibrated.model,minConfidence:calibrated.minConfidence,questionConfigHash:calibrated.questionConfigHash,developmentReportPath:calibratedPath,developmentReportSha256:evaluationSha(text)},null,2)+'\n',{flag:'wx'});loadReviewPolicy(policyPath,calibrated.model);console.log(`Version 2 frozen at ${calibrated.minConfidence}; 12/12 development; provider requests 0.`);}
  }catch(error){console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'V2_FREEZE_UNAVAILABLE');process.exitCode=1;}
}else{
  const path=`${base}/${split}.json`;
  if(existsSync(path)||split==='dev'&&existsSync(policyPath)){console.error('V2_RUN_ALREADY_RECORDED');process.exit(1);}
  if(existsSync('.env'))loadEnvFile('.env');const key=process.env.TYPESAFE_API_KEY,model=process.env.JEV_MODEL;
  if(!key||!model){console.error('V2_JEV_CONFIGURATION_REQUIRED');process.exit(1);}
  const rule=split==='dev'?{model,minConfidence:.9,questionConfigHash:questionConfigHash(.9,2),questionVersion:2}:loadReviewPolicy(policyPath,model);
  if(rule.questionVersion!==2)throw new Error('V2_RULE_REQUIRED');
  const plan=evaluationPlan(JSON.parse(fixtureText),split),startedAt=new Date().toISOString(),metadata={split,questionVersion:2,model,minConfidence:rule.minConfidence,questionConfigHash:rule.questionConfigHash,fixtureSha256:entry.sha256,startedAt,scope:'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',confidenceRule:split==='dev'?'DEVELOPMENT_CANDIDATE_NOT_PRODUCTION_FROZEN':'FROZEN_DEVELOPMENT_RULE',ruleOnly:ruleOnlyComparison(plan),limitations:['New public synthetic version 2 cohort; no authentication, signed quote or funding claim.','Known original application regression is development input only. Holdout fixed before any requests.','Single attempt per planned row. No retries or best-of; critical repetition is exactly three specified attempts.'],blocked:null};
  writeFileSync(path,JSON.stringify({...metadata,status:'NOT_STARTED',runState:'IN_PROGRESS',summary:evaluationSummary([],plan.length),results:[]},null,2)+'\n',{flag:'wx'});
  const rows=await runSemanticEvaluation(plan,new JevHttp(key,model,undefined,2),rule.minConfidence,results=>{writeFileSync(path,JSON.stringify({...metadata,status:'NOT_STARTED',runState:'IN_PROGRESS',summary:evaluationSummary(results,plan.length),results},null,2)+'\n');const row=results.at(-1)!;console.log(`${row.id}: ${row.actual}${row.error?' (provider error)':''}`);});
  const summary=evaluationSummary(rows,plan.length),status=summary.errors===0&&summary.matches===plan.length?'PASS':'FAIL';writeFileSync(path,JSON.stringify({...metadata,status,endedAt:new Date().toISOString(),summary,results:rows},null,2)+'\n');console.log(`Version 2 ${split}: ${status}; ${summary.matches}/${summary.planned}; false PASS ${summary.falsePass}; provider errors ${summary.errors}.`);process.exitCode=status==='PASS'?0:1;
}
