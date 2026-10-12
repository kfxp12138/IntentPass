import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {inspectEvaluationReport} from '../scripts/review-report-evidence.js';
import {evaluationPlan,evaluationSha,evaluationSummary,ruleOnlyComparison,runSemanticEvaluation} from '../scripts/review-evaluation.js';
import {questionConfigHash} from '../packages/adapters/src/jev-review.js';
const model='jev-1.13.0',now=new Date('2026-10-02T04:00:00Z'),dev=JSON.parse(readFileSync('fixtures/dev/review-cases.json','utf8'));
function judgment(choice:'SUPPORTED'|'INSUFFICIENT'|'CONTRADICTED'){const a={type:'choice' as const,choice,confidence:1,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0}};return {model,answers:{service:a,purpose:a,provenance:a},usage:{input_tokens:1,output_tokens:1}};}
/** Isolated synthetic report fixture. Never provider evidence or copied into acceptance artifacts. */
async function fixture(mode:'holdout'|'critical'){
  const dir=mkdtempSync(join(tmpdir(),'intentpass-evidence-unit-')),path=join(dir,'evaluation.json'),policyPath=join(dir,'policy.json'),devPath=join(dir,'dev.json');
  const build=async(cases:any[],mode:'dev'|'holdout'|'critical')=>{const plan=evaluationPlan(cases,mode);let i=0;const results=await runSemanticEvaluation(plan,{model,evaluate:async()=>judgment(plan[i++].expected==='PASS'?'SUPPORTED':plan[i-1].expected==='ABSTAIN'?'INSUFFICIENT':'CONTRADICTED')},.9);return {split:mode,model,minConfidence:.9,questionConfigHash:questionConfigHash(.9),fixtureSha256:evaluationSha(readFileSync(`fixtures/${mode==='holdout'?'holdout':'dev'}/review-cases.json`,'utf8')),startedAt:'2026-10-01T01:00:00Z',endedAt:'2026-10-01T01:01:00Z',scope:'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',status:'PASS',confidenceRule:'FROZEN_DEVELOPMENT_RULE',ruleOnly:ruleOnlyComparison(plan),limitations:['Synthetic unit test, not real model evidence.'],summary:evaluationSummary(results,plan.length),results,blocked:null};};
  const development={...await build(dev,'dev'),startedAt:'2026-10-01T00:00:00Z',endedAt:'2026-10-01T00:01:00Z'},raw=JSON.stringify(development);writeFileSync(devPath,raw);writeFileSync(policyPath,JSON.stringify({version:1,model,minConfidence:.9,questionConfigHash:questionConfigHash(.9),developmentReportPath:devPath,developmentReportSha256:evaluationSha(raw)}));
  const report=await build(mode==='holdout'?JSON.parse(readFileSync('fixtures/holdout/review-cases.json','utf8')):dev,mode),config={model,policyPath,now};const save=(value:unknown)=>writeFileSync(path,JSON.stringify(value));save(report);return {dir,path,report,config,save,check:()=>inspectEvaluationReport(mode,path,config),close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('complete same-input 24-case and nine-attempt reports validate only within explicit operator integrity scope',async()=>{
  for(const mode of ['holdout','critical'] as const){const f=await fixture(mode);try{const result=f.check();assert.equal(result.status,'PASS');assert.equal(result.quality,'PASS');assert.equal(result.planned,mode==='holdout'?24:9);assert.equal(result.scope,'OPERATOR_REPORT_INTEGRITY_NOT_PROVIDER_ATTESTATION');assert.match(result.reportSha256!,/^[a-f0-9]{64}$/);
    const r=structuredClone(f.report);r.results[0].raw=judgment('CONTRADICTED');r.results[0].actual='REJECT';r.results[0].matches=false;r.summary=evaluationSummary(r.results,r.results.length);r.status='FAIL';f.save(r);assert.equal(f.check().quality,'FAIL');assert.equal(f.check().status,mode==='holdout'?'PASS':'FAIL');assert.equal(f.check().matches,r.results.length-1);
  }finally{f.close();}}
});
test('report gate rejects omitted duplicated substituted inputs and fabricated counters baseline or judgments',async()=>{
  const f=await fixture('holdout');try{const changes=[(r:any)=>r.results.pop(),(r:any)=>r.results[1]=r.results[0],(r:any)=>r.results[0].input.taskText='changed',(r:any)=>r.results[0].inputSha256='0'.repeat(64),(r:any)=>r.summary.matches=0,(r:any)=>r.ruleOnly.falsePass=0,(r:any)=>r.minConfidence=.1,(r:any)=>r.results[0].raw.model='different',(r:any)=>r.results[0].raw.answers.purpose=judgment('CONTRADICTED').answers.purpose];for(const change of changes){const r=structuredClone(f.report);change(r);f.save(r);assert.equal(f.check().status,'FAIL');}}finally{f.close();}
});
test('critical gate blocks absent unconfigured or in-progress reports and fails incomplete best-of or future evidence',async()=>{
  const f=await fixture('critical');try{assert.equal(inspectEvaluationReport('critical',join(f.dir,'absent'),f.config).status,'BLOCKED');assert.equal(inspectEvaluationReport('critical',f.path,{now}).status,'BLOCKED');f.save({...f.report,status:'NOT_STARTED',runState:'IN_PROGRESS'});assert.equal(f.check().status,'BLOCKED');
    f.save({...f.report,endedAt:'2027-01-01T00:00:00Z'});assert.equal(f.check().status,'FAIL');f.save({...f.report,startedAt:'2025-01-01T00:00:00Z'});assert.equal(f.check().status,'FAIL');f.save({...f.report,results:f.report.results.filter(r=>r.attempt===1)});assert.equal(f.check().status,'FAIL');
  }finally{f.close();}
});
test('invalid report files fail safely and zero-request blocked reports never become evaluation success',async()=>{
  const f=await fixture('holdout');try{writeFileSync(f.path,'not-json');assert.deepEqual(inspectEvaluationReport('holdout',f.path,{}),{status:'FAIL',reason:'EVALUATION_EVIDENCE_INVALID',scope:'OPERATOR_REPORT_INTEGRITY_NOT_PROVIDER_ATTESTATION'});writeFileSync(f.path,'x'.repeat(4000001));assert.equal(f.check().status,'FAIL');
    const blocked={...f.report,scope:'NO_REAL_MODEL_REQUESTS',status:'BLOCKED',model:null,confidenceRule:'NOT_VALIDATED_NOT_RUN',results:[],summary:evaluationSummary([],24),blocked:'CONFIG_REQUIRED'};f.save(blocked);assert.equal(f.check().status,'BLOCKED');assert.equal(f.check().attempted,0);f.save({...blocked,status:'PASS'});assert.equal(f.check().status,'FAIL');
  }finally{f.close();}
});
