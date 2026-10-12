import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluationArgs,evaluationPlan,ruleOnly,ruleOnlyComparison,runSemanticEvaluation,evaluationSummary} from '../scripts/review-evaluation.js';
const cases=JSON.parse(readFileSync('fixtures/dev/review-cases.json','utf8')),holdout=JSON.parse(readFileSync('fixtures/holdout/review-cases.json','utf8')),model='jev-1.13.0';
function judgment(choice:'SUPPORTED'|'INSUFFICIENT'|'CONTRADICTED') {const answer={type:'choice' as const,choice,confidence:1,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0}};return {model,answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:1,output_tokens:1}};}
test('rule-only never reads gold labels or interprets license text and includes every frozen holdout input',()=>{
  const plan=evaluationPlan(holdout,'holdout'),baseline=ruleOnlyComparison(plan);assert.equal(baseline.planned,24);assert.equal(baseline.results.length,24);assert.ok(baseline.falsePass>0);assert.ok(baseline.matches<24);
  for(let i=0;i<plan.length;i++){const row=baseline.results[i];assert.equal(row.id,plan[i].id);assert.equal(row.actual,ruleOnly(plan[i].state));}
  const state=structuredClone(cases[8].state);assert.equal(ruleOnly(state),'PASS');assert.equal(ruleOnly({...state,expected:'REJECT'}),'REJECT');assert.equal(ruleOnly({...state,documents:[]}), 'ABSTAIN');assert.equal(ruleOnly({...state,documents:[{...state.documents[0],subjectQuoteId:'0x'+'0'.repeat(64)}]}),'REJECT');
});
test('critical plan fixes three cases times three without best-of selection and forbids threshold tuning',()=>{
  const plan=evaluationPlan(cases,'critical');assert.equal(plan.length,9);assert.deepEqual(plan.map(c=>c.id),['dev-001#1','dev-001#2','dev-001#3','dev-005#1','dev-005#2','dev-005#3','dev-009#1','dev-009#2','dev-009#3']);
  assert.deepEqual(evaluationArgs(['--critical']),{mode:'critical',minConfidence:.9});assert.equal(evaluationArgs(['--dev','--confidence','.8']).minConfidence,.8);
  for(const args of [['--critical','--confidence','.1'],['--holdout','--confidence','.1'],['--dev','--confidence',''],['--dev','extra'],['--unknown']])assert.throws(()=>evaluationArgs(args));
  assert.throws(()=>evaluationPlan(cases.filter((c:any)=>c.id!=='dev-005'),'critical'));assert.throws(()=>evaluationPlan([...cases,cases[0]],'critical'));
});
test('semantic evaluation sends only immutable public state and keeps all nine attempts and sanitized failures',async()=>{
  const plan=evaluationPlan(cases,'critical'),sent:any[]=[],snapshots:number[]=[];const rows=await runSemanticEvaluation(plan,{model,evaluate:async(state:any)=>{sent.push(structuredClone(state));assert.equal('expected'in state,false);assert.equal('rationale'in state,false);assert.equal('id'in state,false);state.taskText='provider mutation';if(sent.length===2)throw new Error('private provider details');const index=sent.length-1;return judgment(index<3?'SUPPORTED':index<6?'INSUFFICIENT':'CONTRADICTED');}},.9,rows=>snapshots.push(rows.length));
  assert.equal(sent.length,9);assert.deepEqual(snapshots,[1,2,3,4,5,6,7,8,9]);assert.deepEqual(sent,plan.map(c=>c.state));assert.equal(rows[1].raw,null);assert.equal(rows[1].actual,'ABSTAIN');assert.equal(rows[1].error,'JEV_UNAVAILABLE_OR_INVALID');assert.equal(JSON.stringify(rows).includes('private provider details'),false);assert.deepEqual(evaluationSummary(rows,9),{planned:9,attempted:9,evaluated:8,errors:1,matches:8,falsePass:0});
});
test('malformed and drifting model responses count as errors without retry and missing results never become completed judgments',async()=>{
  const plan=evaluationPlan(cases,'critical');let calls=0;const rows=await runSemanticEvaluation(plan,{model,evaluate:async()=>{calls++;return calls%2?{} as any:{...judgment('SUPPORTED'),model:'different'};}},.9);assert.equal(calls,9);assert.equal(evaluationSummary(rows,9).errors,9);assert.equal(evaluationSummary([],9).attempted,0);assert.equal(evaluationSummary([],9).planned,9);assert.equal(evaluationSummary(rows.slice(0,8),9).attempted,8);
});
