import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {calibrateDevelopment} from '../scripts/review-calibration.js';
import {EvaluationCasesSchema,evaluationSha,evaluationPlan,evaluationSummary,ruleOnlyComparison} from '../scripts/review-evaluation.js';
import {aggregateJev,questionConfigHash} from '../packages/adapters/src/jev-review.js';

const fixtureText=readFileSync('fixtures/dev/review-cases.json','utf8'),cases=EvaluationCasesSchema.parse(JSON.parse(fixtureText));
// Explicit local response doubles test recomposition and integrity, never provider provenance.
function development() {
  const answer=(choice:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT',confidence=.75)=>({type:'choice',choice,confidence,
    probabilities:{SUPPORTED:choice==='SUPPORTED'?.9:.05,CONTRADICTED:choice==='CONTRADICTED'?.9:.05,INSUFFICIENT:choice==='INSUFFICIENT'?.9:.05}});
  const rows=cases.map(c=>{
    const raw={model:'jev-1.13.0',answers:{service:answer('SUPPORTED'),purpose:answer(c.expected==='PASS'?'SUPPORTED':c.expected==='REJECT'?'CONTRADICTED':'INSUFFICIENT'),provenance:answer('SUPPORTED')},usage:{input_tokens:100,output_tokens:10}};
    const actual=aggregateJev(raw,.9);return {id:c.id,caseId:c.id,attempt:1,input:c.state,inputSha256:evaluationSha(JSON.stringify(c.state)),expected:c.expected,actual,raw,error:null,durationMs:1,matches:actual===c.expected};
  });
  return {split:'dev',model:'jev-1.13.0',minConfidence:.9,questionConfigHash:questionConfigHash(.9),fixtureSha256:evaluationSha(fixtureText),
    startedAt:'2026-10-02T12:00:00.000Z',endedAt:'2026-10-02T12:00:01.000Z',scope:'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',status:'FAIL',
    confidenceRule:'DEVELOPMENT_CANDIDATE_NOT_PRODUCTION_FROZEN',blocked:null,ruleOnly:ruleOnlyComparison(evaluationPlan(cases,'dev')),summary:evaluationSummary(rows,12),results:rows};
}
test('development calibration reuses all original responses and chooses the highest successful boundary',()=>{
  const original=development(),before=JSON.stringify(original),calibrated=calibrateDevelopment(original,fixtureText,evaluationSha(fixtureText));
  assert.equal(calibrated.minConfidence,.75);assert.equal(calibrated.summary.matches,12);assert.equal(calibrated.summary.falsePass,0);
  assert.equal(calibrated.calibration.providerRequestsAdded,0);assert.equal(calibrated.calibration.originalSummary.matches,8);
  assert.equal(JSON.stringify(original),before);assert.deepEqual(calibrated.results.map(r=>r.raw),original.results.map(r=>r.raw));
  assert.deepEqual(calibrated.results.map(r=>r.input),original.results.map(r=>r.input));
});
test('calibration refuses corrupted or incomplete real reports and cannot repair a wrong semantic label with confidence',()=>{
  for(const change of [(r:ReturnType<typeof development>)=>{(r.results[0] as {input:unknown}).input={};},(r:ReturnType<typeof development>)=>{r.results[0].raw.model='jev-1.12.0';},
    (r:ReturnType<typeof development>)=>{r.results.pop();},(r:ReturnType<typeof development>)=>{r.summary.matches=12;}]) {
    const r=development();change(r);assert.throws(()=>calibrateDevelopment(r,fixtureText,evaluationSha(fixtureText)));
  }
  const wrong=development(),row=wrong.results[0];row.raw.answers.purpose={type:'choice',choice:'INSUFFICIENT',confidence:.75,probabilities:{SUPPORTED:.05,CONTRADICTED:.05,INSUFFICIENT:.9}};
  assert.throws(()=>calibrateDevelopment(wrong,fixtureText,evaluationSha(fixtureText)),/DEVELOPMENT_QUALITY_INSUFFICIENT/);
});
test('frozen development CLI refuses reevaluation before reading secrets or changing source evidence',()=>{
  const root=mkdtempSync(join(tmpdir(),'intentpass-frozen-dev-'));try {
    mkdirSync(join(root,'artifacts/acceptance'),{recursive:true});const source='PRESERVE_ORIGINAL_SOURCE_BYTES';
    writeFileSync(join(root,'artifacts/acceptance/review-dev.json'),source);writeFileSync(join(root,'artifacts/acceptance/review-policy.json'),'{}');
    const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),resolve('scripts/eval-review.ts'),'--dev','--confidence','0.5'],{cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(result.status,1);assert.match(result.stderr,/DEVELOPMENT_POLICY_ALREADY_FROZEN/);assert.equal(result.stdout,'');
    assert.equal(readFileSync(join(root,'artifacts/acceptance/review-dev.json'),'utf8'),source);
  }finally{rmSync(root,{recursive:true,force:true});}
});
