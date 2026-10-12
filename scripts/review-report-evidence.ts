import {readFileSync,statSync,existsSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {resolve} from 'node:path';
import {loadReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {JevResponseSchema,aggregateJev} from '../packages/adapters/src/jev-review.js';
import {evaluationSha,evaluationPlan,ruleOnlyComparison,evaluationSummary,type EvaluationRow} from './review-evaluation.js';
const timestamp=z.iso.datetime(),hash=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative(),decision=z.enum(['PASS','ABSTAIN','REJECT']);
const summary=z.object({planned:count,attempted:count,evaluated:count,errors:count,matches:count,falsePass:count}).strict();
const ReportSchema=z.object({split:z.enum(['holdout','critical']),model:z.string().nullable(),minConfidence:z.number().min(0).max(1),questionConfigHash:z.string(),fixtureSha256:hash,startedAt:timestamp,endedAt:timestamp.optional(),scope:z.enum(['NO_REAL_MODEL_REQUESTS','REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION']),status:z.enum(['PASS','FAIL','BLOCKED','NOT_STARTED']),runState:z.literal('IN_PROGRESS').optional(),confidenceRule:z.enum(['NOT_VALIDATED_NOT_RUN','FROZEN_DEVELOPMENT_RULE']).optional(),ruleOnly:z.unknown(),limitations:z.array(z.string()),summary,results:z.array(z.unknown()),blocked:z.string().nullable().optional()}).strict();
const RowSchema=z.object({id:z.string(),caseId:z.string(),attempt:z.number().int().min(1).max(3),input:z.unknown(),inputSha256:hash,expected:decision,actual:decision,raw:z.unknown(),error:z.literal('JEV_UNAVAILABLE_OR_INVALID').nullable(),durationMs:count,matches:z.boolean()}).strict();
function read(path:string){const s=statSync(path);if(!s.isFile()||s.size<=0||s.size>4000000)throw new Error('INVALID_EVIDENCE_FILE');return readFileSync(path,'utf8');}
export interface EvaluationEvidence {status:'PASS'|'FAIL'|'BLOCKED';reason:string;scope:'OPERATOR_REPORT_INTEGRITY_NOT_PROVIDER_ATTESTATION';quality?:'PASS'|'FAIL';reportSha256?:string;planned?:number;attempted?:number;evaluated?:number;errors?:number;matches?:number;falsePass?:number;}
/** A trusted operator's report is checked, never an independent network provenance attestation. */
export function inspectEvaluationReport(mode:'holdout'|'critical',path:string,config:{model?:string;policyPath?:string;now?:Date;root?:string}):EvaluationEvidence{
  const root=config.root??process.cwd(),absolute=resolve(root,path),scope='OPERATOR_REPORT_INTEGRITY_NOT_PROVIDER_ATTESTATION' as const;if(!existsSync(absolute))return {status:'BLOCKED',reason:'REAL_EVALUATION_REPORT_REQUIRED',scope};
  try{
    const text=read(absolute),r=ReportSchema.parse(JSON.parse(text)),reportSha256=evaluationSha(text),fixtureMode=mode==='holdout'?'holdout':'dev',fixturePath=`fixtures/${fixtureMode}/review-cases.json`,raw=read(resolve(root,fixturePath)),manifest=JSON.parse(read(resolve(root,'fixtures/review-manifest.json'))),entry=manifest.files.find((e:{path:string})=>e.path===fixturePath),cases=JSON.parse(raw);
    if(r.split!==mode||!entry||evaluationSha(raw)!==entry.sha256||r.fixtureSha256!==entry.sha256||cases.length!==(mode==='holdout'?24:12)||entry.count!==cases.length)throw new Error();
    const plan=evaluationPlan(cases,mode);if(!isDeepStrictEqual(r.ruleOnly,ruleOnlyComparison(plan))||r.summary.planned!==plan.length||r.summary.attempted!==r.results.length||r.summary.evaluated+r.summary.errors!==r.summary.attempted||r.summary.attempted>plan.length)throw new Error();
    const meta={scope,reportSha256,...r.summary};if(r.scope==='NO_REAL_MODEL_REQUESTS'){if(r.status!=='BLOCKED'||r.results.length!==0||!isDeepStrictEqual(r.summary,evaluationSummary([],plan.length)))throw new Error();return {...meta,status:'BLOCKED',reason:'NO_REAL_MODEL_REQUESTS'};}
    if(!config.model||!config.policyPath||!existsSync(resolve(root,config.policyPath)))return {...meta,status:'BLOCKED',reason:'FROZEN_MODEL_AND_DEVELOPMENT_POLICY_REQUIRED'};
    const rule=loadReviewPolicy(config.policyPath,config.model,root),policy=JSON.parse(read(resolve(root,config.policyPath))),dev=JSON.parse(read(resolve(root,policy.developmentReportPath)));
    if(r.model!==rule.model||r.minConfidence!==rule.minConfidence||r.questionConfigHash!==rule.questionConfigHash||Date.parse(r.startedAt)<Date.parse(timestamp.parse(dev.endedAt))||Date.parse(r.startedAt)>(config.now??new Date()).getTime())throw new Error();
    if(r.status==='NOT_STARTED'&&r.runState==='IN_PROGRESS')return {...meta,status:'BLOCKED',reason:'EVALUATION_IN_PROGRESS_NOT_COMPLETE'};
    if(!r.endedAt||Date.parse(r.endedAt)<Date.parse(r.startedAt)||Date.parse(r.endedAt)>(config.now??new Date()).getTime()||r.confidenceRule!=='FROZEN_DEVELOPMENT_RULE'||r.blocked!==null||r.runState!==undefined||!['PASS','FAIL'].includes(r.status)||r.results.length!==plan.length)throw new Error();
    const rows=r.results.map((value,i)=>{const row=RowSchema.parse(value),c=plan[i];if(row.id!==c.id||row.caseId!==c.caseId||row.attempt!==c.attempt||row.expected!==c.expected||!isDeepStrictEqual(row.input,c.state)||row.inputSha256!==evaluationSha(JSON.stringify(c.state)))throw new Error();
      if(row.error!==null){if(row.raw!==null||row.actual!=='ABSTAIN'||row.matches)throw new Error();}else{const judgment=JevResponseSchema.parse(row.raw),actual=aggregateJev(judgment,rule.minConfidence);if(judgment.model!==rule.model||actual!==row.actual||row.matches!==(actual===c.expected))throw new Error();}return row as EvaluationRow;});
    const computed=evaluationSummary(rows,plan.length);if(!isDeepStrictEqual(r.summary,computed))throw new Error();const perfect=computed.errors===0&&computed.matches===plan.length;if(r.status!==(perfect?'PASS':'FAIL'))throw new Error();
    // D6-02 asks for honest complete measurement, not a promise of zero model errors.
    const passed=mode==='holdout'?computed.errors===0:perfect;return {...meta,quality:perfect?'PASS':'FAIL',status:passed?'PASS':'FAIL',reason:mode==='holdout'&&passed?'COMPLETE_HOLDOUT_MEASUREMENT_QUALITY_REPORTED':passed?'COMPLETE_CRITICAL_EVALUATION_REPORT_VALIDATED':'REAL_EVALUATION_HAS_ERRORS_OR_CRITICAL_MISMATCHES'};
  }catch{return {status:'FAIL',reason:'EVALUATION_EVIDENCE_INVALID',scope};}
}
