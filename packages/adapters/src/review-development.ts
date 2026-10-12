import {isDeepStrictEqual} from 'node:util';
import {JevResponseSchema,aggregateJev,questionConfigHash,type ReviewQuestionVersion} from './jev-review.js';
import {EvaluationCasesSchema,evaluationSha,evaluationSummary,ruleOnlyComparison,evaluationPlan,type EvaluationRow} from './review-evaluation.js';

/** Recompose one completed development run. No inference, input changes or holdout data. */
export function calibrateDevelopment(input:unknown,fixtureText:string,fixtureSha256:string,questionVersion:ReviewQuestionVersion=1) {
  const cases=EvaluationCasesSchema.parse(JSON.parse(fixtureText));
  if(cases.length!==12||evaluationSha(fixtureText)!==fixtureSha256)throw Error('FROZEN_DEVELOPMENT_INPUT_INVALID');
  const r=input as Record<string,unknown>;
  if(!r||r.split!=='dev'||r.scope!=='REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION'||!['PASS','FAIL'].includes(String(r.status))
    ||typeof r.model!=='string'||!/^jev-\d+\.\d+\.\d+$/.test(r.model)||typeof r.minConfidence!=='number'
    ||r.questionConfigHash!==questionConfigHash(r.minConfidence,questionVersion)||r.fixtureSha256!==fixtureSha256
    ||questionVersion===2&&r.questionVersion!==2||questionVersion===1&&r.questionVersion!==undefined&&r.questionVersion!==1
    ||typeof r.startedAt!=='string'||typeof r.endedAt!=='string'||!Number.isFinite(Date.parse(r.startedAt))
    ||!Number.isFinite(Date.parse(r.endedAt))||r.startedAt>r.endedAt||r.blocked!==null
    ||r.confidenceRule!=='DEVELOPMENT_CANDIDATE_NOT_PRODUCTION_FROZEN'||!Array.isArray(r.results)||r.results.length!==12
    ||!isDeepStrictEqual(r.ruleOnly,ruleOnlyComparison(evaluationPlan(cases,'dev'))))throw Error('REAL_DEVELOPMENT_REPORT_INVALID');
  const rows:EvaluationRow[]=r.results.map((value,i)=>{
    const row=value as EvaluationRow,c=cases[i],judgment=JevResponseSchema.parse(row.raw);
    if(row.id!==c.id||row.caseId!==c.id||row.attempt!==1||row.expected!==c.expected||row.error!==null
      ||!isDeepStrictEqual(row.input,c.state)||row.inputSha256!==evaluationSha(JSON.stringify(c.state))
      ||judgment.model!==r.model||!Number.isInteger(row.durationMs)||row.durationMs<0
      ||row.actual!==aggregateJev(judgment,r.minConfidence as number)||row.matches!==(row.actual===c.expected))throw Error('REAL_DEVELOPMENT_ROW_INVALID');
    return {...row,raw:judgment};
  });
  const originalSummary=evaluationSummary(rows,12);
  if(!isDeepStrictEqual(r.summary,originalSummary)||r.status!==(originalSummary.matches===12?'PASS':'FAIL'))throw Error('REAL_DEVELOPMENT_SUMMARY_INVALID');
  const thresholds=[...new Set([1,...rows.flatMap(row=>Object.values(JevResponseSchema.parse(row.raw).answers).map(a=>a.confidence))])].sort((a,b)=>b-a);
  const candidates=thresholds.map(minConfidence=>({minConfidence,results:rows.map(row=>{
    const actual=aggregateJev(row.raw,minConfidence);return {...row,actual,matches:actual===row.expected};
  })}));
  const selected=candidates.find(candidate=>evaluationSummary(candidate.results,12).matches===12);
  if(!selected)throw Error('DEVELOPMENT_QUALITY_INSUFFICIENT');
  return {...r,model:r.model,minConfidence:selected.minConfidence,questionConfigHash:questionConfigHash(selected.minConfidence,questionVersion),status:'PASS',
    summary:evaluationSummary(selected.results,12),results:selected.results,
    calibration:{method:'HIGHEST_OBSERVED_CONFIDENCE_THRESHOLD_MATCHING_ALL_DEVELOPMENT_LABELS',providerRequestsAdded:0,
      originalMinConfidence:r.minConfidence,originalSummary,candidates:candidates.map(c=>({minConfidence:c.minConfidence,...evaluationSummary(c.results,12)})),
      limits:['Same original real responses recomposed; no response, fixture or question modified.','Development selection only; independent cases must use this frozen rule.','Twelve public synthetic cases do not establish production safety or correctness probability.']}};
}
