import {createHash} from 'node:crypto';
import {z} from 'zod';
import {TaskPolicySchema,address,digest} from '../../protocol/src/schemas.js';
import {EvidenceDocumentsSchema} from '../../protocol/src/review-evidence.js';
import {JevResponseSchema,aggregateJev,type JevPort} from './jev-review.js';
export const evaluationSha=(text:string)=>createHash('sha256').update(text).digest('hex');
export const EvaluationStateSchema=z.object({policy:TaskPolicySchema,taskText:z.string().min(1).max(16000),currentQuote:z.object({quoteId:digest,seller:address,service:z.literal('dataset-report'),serviceTerms:z.string().max(16000)}).strict(),documents:EvidenceDocumentsSchema}).strict();
const decision=z.enum(['PASS','ABSTAIN','REJECT']);
export const EvaluationCasesSchema=z.array(z.object({id:z.string().regex(/^(dev|holdout)-[0-9]{3}$/),expected:decision,rationale:z.string(),state:EvaluationStateSchema}).strict()).refine(c=>new Set(c.map(v=>v.id)).size===c.length,'duplicate case ID');
export type EvaluationCase=z.infer<typeof EvaluationCasesSchema>[number];
export const ruleOnlyDefinition={version:1,name:'STRUCTURE_AND_SUBJECT_LABEL_ONLY',rules:['invalid-state-reject','no-documents-abstain','different-subject-label-reject','otherwise-pass'],limitations:['No natural-language license or provenance inference.','No authentication, quote signatures, balances, identity rules or financial execution.']} as const;
export function ruleOnly(input:unknown):'PASS'|'ABSTAIN'|'REJECT'{const r=EvaluationStateSchema.safeParse(input);if(!r.success)return 'REJECT';if(!r.data.documents.length)return 'ABSTAIN';if(r.data.documents.some(d=>d.subjectQuoteId.toLowerCase()!==r.data.currentQuote.quoteId.toLowerCase()))return 'REJECT';return 'PASS';}
export function evaluationArgs(args:string[]):{mode:'dev'|'holdout'|'critical';minConfidence:number}{
  const mode=args.length===0?'dev':args[0]==='--dev'?'dev':args[0]==='--holdout'?'holdout':args[0]==='--critical'?'critical':undefined;
  if(!mode||args.length>1&&!(mode==='dev'&&args.length===3&&args[1]==='--confidence'))throw new Error('USAGE_EVAL_REVIEW_DEV_HOLDOUT_CRITICAL');
  const minConfidence=args.length===3?Number(args[2]):.9;if(!Number.isFinite(minConfidence)||minConfidence<0||minConfidence>1||args.length===3&&!args[2].trim())throw new Error('CONFIDENCE_INVALID');return {mode,minConfidence};
}
export function evaluationPlan(input:unknown,mode:'dev'|'holdout'|'critical'){
  const cases=EvaluationCasesSchema.parse(input);if(mode!=='critical')return cases.map(c=>({...c,caseId:c.id,attempt:1}));
  const expected={ 'dev-001':'PASS','dev-005':'ABSTAIN','dev-009':'REJECT'} as const;
  return Object.entries(expected).flatMap(([id,label])=>{const c=cases.find(c=>c.id===id);if(!c||c.expected!==label)throw new Error('CRITICAL_CASES_INVALID');return [1,2,3].map(attempt=>({...c,id:`${id}#${attempt}`,caseId:id,attempt}));});
}
export type EvaluationPlan=ReturnType<typeof evaluationPlan>;
export function ruleOnlyComparison(plan:EvaluationPlan){const rows=plan.map(c=>({id:c.id,caseId:c.caseId,attempt:c.attempt,inputSha256:evaluationSha(JSON.stringify(c.state)),expected:c.expected,actual:ruleOnly(c.state)}));return {definition:ruleOnlyDefinition,definitionSha256:evaluationSha(JSON.stringify(ruleOnlyDefinition)),planned:plan.length,evaluated:rows.length,matches:rows.filter(r=>r.actual===r.expected).length,falsePass:rows.filter(r=>r.actual==='PASS'&&r.expected!=='PASS').length,results:rows};}
export async function runSemanticEvaluation(plan:EvaluationPlan,port:JevPort,minConfidence:number,onRow:(rows:EvaluationRow[])=>void=()=>{}){
  const rows:EvaluationRow[]=[];
  for(const c of plan){const start=performance.now();let actual:'PASS'|'ABSTAIN'|'REJECT'='ABSTAIN',raw:unknown=null,error:string|null=null;
    try{raw=JevResponseSchema.parse(await port.evaluate(structuredClone(c.state)));if((raw as z.infer<typeof JevResponseSchema>).model!==port.model)throw new Error();actual=aggregateJev(raw,minConfidence);}catch{raw=null;error='JEV_UNAVAILABLE_OR_INVALID';}
    rows.push({id:c.id,caseId:c.caseId,attempt:c.attempt,input:c.state,inputSha256:evaluationSha(JSON.stringify(c.state)),expected:c.expected,actual,raw,error,durationMs:Math.round(performance.now()-start),matches:actual===c.expected&&error===null});onRow([...rows]);
  }return rows;
}
export interface EvaluationRow {id:string;caseId:string;attempt:number;input:EvaluationCase['state'];inputSha256:string;expected:'PASS'|'ABSTAIN'|'REJECT';actual:'PASS'|'ABSTAIN'|'REJECT';raw:unknown;error:string|null;durationMs:number;matches:boolean;}
export function evaluationSummary(rows:EvaluationRow[],planned:number){return {planned,attempted:rows.length,evaluated:rows.filter(r=>r.error===null).length,errors:rows.filter(r=>r.error!==null).length,matches:rows.filter(r=>r.matches).length,falsePass:rows.filter(r=>r.actual==='PASS'&&r.expected!=='PASS').length};}
