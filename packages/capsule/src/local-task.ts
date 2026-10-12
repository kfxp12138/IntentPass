import {z} from 'zod';
import {MemoryPayloadSchema,type CapsulePayload} from './format.js';
import {createReport} from '../../protocol/src/report.js';
import {policyHash} from '../../protocol/src/typed-data.js';
import {purchaseEvidenceHash} from '../../protocol/src/review-evidence.js';
const fail=(code:string):never=>{throw Error('LOCAL_TASK_'+code);};
const memorySchema=MemoryPayloadSchema.superRefine((m,ctx)=>{
  if(!m.taskInput||m.evidence.schemaVersion!==2||createReport(m.taskInput.dataset).datasetHash.toLowerCase()!==m.policy.datasetHash.toLowerCase())ctx.addIssue({code:'custom',message:'ORIGINAL_TASK_INVALID'});
});
const bareSchema=MemoryPayloadSchema.omit({schemaVersion:true,kind:true});
const transferSchema=z.object({format:z.literal('IntentPass.LocalTask.v1'),memory:memorySchema}).strict();
export function originalMemoryTask(input:unknown){return memorySchema.parse({schemaVersion:1,kind:'memory',...(input&&typeof input==='object'?input:{})});}
/** Explicit clipboard transfer only. No storage, credentials, wallet material,
 * signatures, generated task ID, evidence salt, or financial authority. */
export function serializeLocalTask(input:unknown,locked:boolean){if(locked)fail('AUTHORIZATION_LOCKED');return JSON.stringify(transferSchema.parse({format:'IntentPass.LocalTask.v1',memory:originalMemoryTask(input)}),null,2);}
function objectEnd(text:string,start:number){let depth=0,quoted=false,escaped=false;for(let i=start;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0)return i+1;}return -1;}
function parseObject(raw:unknown){
  const wrapped=transferSchema.safeParse(raw);if(wrapped.success)return wrapped.data.memory;
  const bare=bareSchema.safeParse(raw);if(bare.success)return originalMemoryTask(bare.data);
  return undefined;
}
/** Also accepts a copy of the original visible policy panel/page. Only a strict
 * unsigned task object is extracted; surrounding text is never interpreted. */
export function parseLocalTask(text:string){
  if(typeof text!=='string'||text.length>1048576||!text.trim())return fail('INPUT_INVALID');
  try{const result=parseObject(JSON.parse(text));if(result)return result;}catch{}
  for(let start=text.indexOf('{');start>=0;){const end=objectEnd(text,start);if(end<0)break;try{const result=parseObject(JSON.parse(text.slice(start,end)));if(result)return result;}catch{}start=text.indexOf('{',end);}
  return fail('INPUT_INVALID');
}
export function localTaskFingerprint(input:unknown){
  const m=originalMemoryTask(input);return JSON.stringify({policy:policyHash(m.policy),taskInput:m.taskInput,evidence:purchaseEvidenceHash(m.evidence)});
}
export function restoreLocalTask(text:string,current:unknown,locked:boolean){
  if(locked)fail('AUTHORIZATION_LOCKED');const incoming=parseLocalTask(text),existing=current==null?undefined:originalMemoryTask(current);
  if(existing&&localTaskFingerprint(existing)!==localTaskFingerprint(incoming))fail('EXISTING_TASK_MISMATCH');
  return {memory:incoming,alreadyPresent:!!existing};
}
export function confirmedFromMemory(memory:Extract<CapsulePayload,{kind:'memory'}>){const m=memorySchema.parse(memory);return {policy:m.policy,taskInput:m.taskInput!,evidence:m.evidence};}
