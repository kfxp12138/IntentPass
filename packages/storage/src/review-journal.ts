import {createHmac,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {digest,uint} from '../../protocol/src/schemas.js';
import {ReviewResultSchema} from '../../protocol/src/purchase-api.js';
export type ReviewResult=z.infer<typeof ReviewResultSchema>;
export const ReviewRecordSchema=z.object({
  key:digest,contextHash:digest,status:z.enum(['PENDING','EVALUATED','COMPLETE','UNKNOWN']),
  startedAt:uint,evaluatedAt:uint.nullable(),finishedAt:uint.nullable(),
  evaluation:ReviewResultSchema.nullable(),result:ReviewResultSchema.nullable(),
}).strict().superRefine((r,ctx)=>{
  const evaluated=r.evaluation!==null,finished=r.result!==null;
  if(evaluated!==(r.evaluatedAt!==null)||finished!==(r.finishedAt!==null)
    ||evaluated&&(r.evaluation!.source!=='JEV'||r.evaluation!.executable||r.evaluation!.code!==undefined)
    ||r.evaluatedAt!==null&&BigInt(r.evaluatedAt)<BigInt(r.startedAt)
    ||r.finishedAt!==null&&BigInt(r.finishedAt)<BigInt(r.evaluatedAt??r.startedAt)
    ||r.status==='PENDING'&&(evaluated||finished)
    ||r.status==='EVALUATED'&&(!evaluated||finished)
    ||r.status==='COMPLETE'&&(!evaluated||!finished||r.result!.source!=='JEV')
    ||r.status==='UNKNOWN'&&(!finished||r.result!.source!=='DEPENDENCY'))ctx.addIssue({code:'custom',message:'REVIEW_RECORD_INVALID'});
  if(r.status==='COMPLETE'&&r.result?.source==='JEV'&&r.evaluation?.source==='JEV'){
    const result=r.result,evaluation=r.evaluation;
    if(result.modelId!==evaluation.modelId||result.questionConfigHash.toLowerCase()!==evaluation.questionConfigHash.toLowerCase()
      ||JSON.stringify(result.answers)!==JSON.stringify(evaluation.answers)||JSON.stringify(result.usage)!==JSON.stringify(evaluation.usage)
      ||result.executable&&(evaluation.decision!=='PASS'||result.receipt.contextHash.toLowerCase()!==r.contextHash.toLowerCase())
      ||!result.executable&&(result.code===undefined?result.decision!==evaluation.decision:result.decision!=='ABSTAIN'||!['REVIEW_EXPIRED','REVIEWER_UNAVAILABLE'].includes(result.code)))ctx.addIssue({code:'custom',message:'REVIEW_RESULT_CONFLICT'});
  }
});
export type ReviewRecord=z.infer<typeof ReviewRecordSchema>;
export interface ReviewJournal {
  key(input:unknown):string;
  get(key:string):ReviewRecord|undefined;
  reserve(key:string,contextHash:string,startedAt:string):boolean;
  evaluated(key:string,evaluation:ReviewResult,at:string):void;
  finish(key:string,result:ReviewResult,at:string):void;
}
function canonical(input:unknown):string{
  if(input===null||typeof input!=='object')return JSON.stringify(input);
  if(Array.isArray(input))return '['+input.map(canonical).join(',')+']';
  return '{'+Object.keys(input).sort().map(key=>JSON.stringify(key)+':'+canonical((input as Record<string,unknown>)[key])).join(',')+'}';
}
/** Private keyed digest only; never log or expose this key or its input. */
export function reviewJournalKey(secret:Uint8Array,input:unknown){return '0x'+createHmac('sha256',secret).update(canonical(input)).digest('hex');}
export function evaluatedRecord(old:ReviewRecord,evaluation:ReviewResult,at:string){
  if(old.status!=='PENDING')throw new Error('REVIEW_RECORD_CONFLICT');
  return ReviewRecordSchema.parse({...old,status:'EVALUATED',evaluation,evaluatedAt:at});
}
export function completedRecord(old:ReviewRecord,result:ReviewResult,at:string){
  if(!['PENDING','EVALUATED'].includes(old.status))throw new Error('REVIEW_RECORD_CONFLICT');
  return ReviewRecordSchema.parse({...old,status:result.source==='DEPENDENCY'?'UNKNOWN':'COMPLETE',result,finishedAt:at});
}
/** Local constructor fallback only. Configured HTTP services require a durable ReviewStore. */
export class MemoryReviewJournal implements ReviewJournal {
  private readonly secret=randomBytes(32);
  private readonly rows=new Map<string,ReviewRecord>();
  key(input:unknown){return reviewJournalKey(this.secret,input);}
  get(key:string){const row=this.rows.get(digest.parse(key).toLowerCase());return row&&ReviewRecordSchema.parse(row);}
  reserve(key:string,contextHash:string,startedAt:string){key=digest.parse(key).toLowerCase();if(this.rows.has(key))return false;this.rows.set(key,ReviewRecordSchema.parse({key,contextHash,status:'PENDING',startedAt,evaluatedAt:null,finishedAt:null,evaluation:null,result:null}));return true;}
  evaluated(key:string,evaluation:ReviewResult,at:string){const old=this.get(key);if(!old)throw new Error('REVIEW_RECORD_CONFLICT');this.rows.set(old.key,evaluatedRecord(old,evaluation,at));}
  finish(key:string,result:ReviewResult,at:string){const old=this.get(key);if(!old)throw new Error('REVIEW_RECORD_CONFLICT');this.rows.set(old.key,completedRecord(old,result,at));}
}
