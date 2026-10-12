import {resolve} from 'node:path';
import {z} from 'zod';
import {digest,uint} from '../../../packages/protocol/src/schemas.js';
import {readPrivateServiceJson} from '../../../scripts/create-privy-service-wallets.js';

const completion=z.object({status:z.literal('CONFIRMED'),orderId:digest,payoutHash:digest}).strict();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const VerifiedProcurementCompletionSchema=completion.extend({jobId:z.uuid(),taskId:digest,scopeHash:hash,proofHash:hash,finalizedBlock:uint}).strict();
/** Historical completion projection only. Never rewrites the failed queue event
 * or releases a dispatch slot. New projections require a bound verification record. */
export function readProcurementCompletion(directory:string,jobId:string){
  if(!z.uuid().safeParse(jobId).success)return undefined;
  const parent=resolve(directory,'procurements',jobId);
  let legacy:z.infer<typeof completion>|undefined,verified:z.infer<typeof completion>|undefined;
  try{const path=resolve(parent,'review-namespace-recovery-v1'),result=completion.parse(readPrivateServiceJson(resolve(path,'recovery-result.json'))),reserved=readPrivateServiceJson(resolve(path,'recovery-reserved.json')) as {jobId?:unknown};if(reserved.jobId===jobId)legacy=result;}catch{/* Absent or invalid evidence is not completion. */}
  try{
    const path=resolve(parent,'evidence-continuation-v1'),record=VerifiedProcurementCompletionSchema.parse(readPrivateServiceJson(resolve(path,'verified-result.json'))),result=completion.parse(readPrivateServiceJson(resolve(path,'continuation-result.json')));
    const reserved=z.object({jobId:z.uuid(),taskId:digest,scopeHash:hash}).passthrough().parse(readPrivateServiceJson(resolve(path,'continuation-reserved.json')));
    if(record.jobId===jobId&&reserved.jobId===jobId&&record.taskId===reserved.taskId&&record.scopeHash===reserved.scopeHash&&record.orderId===result.orderId&&record.payoutHash===result.payoutHash)verified=result;
  }catch{/* An unverified runtime response is not enough. */}
  if(legacy&&verified&&(legacy.orderId!==verified.orderId||legacy.payoutHash!==verified.payoutHash))return undefined;
  return verified??legacy;
}
