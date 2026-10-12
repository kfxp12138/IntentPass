import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {JevHttp,questionConfigHash} from '../packages/adapters/src/jev-review.js';
import {loadReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {evaluationArgs,evaluationSha,evaluationPlan,ruleOnlyComparison,runSemanticEvaluation,evaluationSummary,type EvaluationRow} from './review-evaluation.js';
const {mode,minConfidence:candidate}=evaluationArgs(process.argv.slice(2)),startedAt=new Date().toISOString(),split=mode,base='artifacts/acceptance',path=`${base}/review-${split}.json`;
// A new development cohort needs an explicit new version; never overwrite the
// source run behind an already frozen rule after inspecting independent results.
if(mode==='dev'&&existsSync(`${base}/review-policy.json`)){console.error('DEVELOPMENT_POLICY_ALREADY_FROZEN');process.exit(1);}
if(existsSync('.env'))loadEnvFile('.env');mkdirSync(base,{recursive:true});
if(existsSync(path)){const dir=`${base}/history/${startedAt.replaceAll(':','-')}-review-${split}`;mkdirSync(dir,{recursive:true});copyFileSync(path,`${dir}/result.json`);}
const manifest=JSON.parse(readFileSync('fixtures/review-manifest.json','utf8')),fixtureMode=mode==='holdout'?'holdout':'dev',file=manifest.files.find((f:{path:string})=>f.path===`fixtures/${fixtureMode}/review-cases.json`),text=readFileSync(file.path,'utf8');
if(evaluationSha(text)!==file.sha256)throw new Error('FROZEN_CASES_CHANGED');const cases=JSON.parse(text);if(cases.length!==(fixtureMode==='dev'?12:24)||file.count!==cases.length)throw new Error('FROZEN_CASE_COUNT_INVALID');
const plan=evaluationPlan(cases,mode),comparison=ruleOnlyComparison(plan),key=process.env.TYPESAFE_API_KEY,model=process.env.JEV_MODEL;let minConfidence=candidate,blocked:string|undefined;
if(mode!=='dev'){if(!process.env.REVIEW_POLICY_PATH)blocked='FROZEN_DEVELOPMENT_POLICY_REQUIRED';else try{minConfidence=loadReviewPolicy(process.env.REVIEW_POLICY_PATH,model??'').minConfidence;}catch{blocked='FROZEN_DEVELOPMENT_POLICY_INVALID';}}
if(!key||!model)blocked='TYPESAFE_API_KEY_AND_PINNED_JEV_MODEL_REQUIRED';
const metadata={split,model:model??null,minConfidence,questionConfigHash:questionConfigHash(minConfidence),fixtureSha256:file.sha256,startedAt,ruleOnly:comparison,limitations:['Public synthetic semantic inputs only; no asset transfer, authentication, quote signature or funding claim.','Rule-only uses identical states and case IDs; structural PASS is not evidence sufficiency.','Finite inputs and repeated calls do not prove production safety.']};
let rows:EvaluationRow[]=[];
if(!blocked){let port:JevHttp|undefined;try{port=new JevHttp(key!,model!);}catch{blocked='JEV_PINNED_MODEL_REQUIRED';}
  if(port)rows=await runSemanticEvaluation(plan,port,minConfidence,results=>{writeFileSync(path,JSON.stringify({...metadata,scope:'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',status:'NOT_STARTED',runState:'IN_PROGRESS',summary:evaluationSummary(results,plan.length),results},null,2)+'\n');const r=results.at(-1)!;console.log(`${r.id}: ${r.actual}${r.error?' (provider failure)':''}`);});
}
const summary=evaluationSummary(rows,plan.length),status=blocked?'BLOCKED':summary.attempted===summary.planned&&summary.errors===0&&summary.matches===summary.planned?'PASS':'FAIL';
writeFileSync(path,JSON.stringify({...metadata,scope:blocked?'NO_REAL_MODEL_REQUESTS':'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',status,confidenceRule:blocked?'NOT_VALIDATED_NOT_RUN':mode==='dev'?'DEVELOPMENT_CANDIDATE_NOT_PRODUCTION_FROZEN':'FROZEN_DEVELOPMENT_RULE',endedAt:new Date().toISOString(),summary,results:rows,blocked:blocked??null},null,2)+'\n');
console.log(`Review ${split}: ${status}; ${summary.evaluated}/${summary.planned} real judgments; rule-only ${comparison.matches}/${comparison.planned} matches, ${comparison.falsePass} false PASS.`);process.exitCode=status==='PASS'?0:1;
