import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {BackgroundVault} from '../../../packages/storage/src/background-vault.js';
import {readPrivateServiceJson} from '../../../scripts/create-privy-service-wallets.js';
import {DraftSchema,ProposeResultSchema,ReviewResultSchema} from '../../../packages/protocol/src/purchase-api.js';
import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {checkWithdrawalReceipt} from '../../../packages/protocol/src/withdrawal.js';
import {reportDelivery} from '../../../packages/protocol/src/fulfillment.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import {checkExpiredUnfunded} from './expired-procurement.js';
const code=z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/);
/** Owner-authenticated projection of immutable encrypted records. Reading never
 * creates a key, signs, submits, or infers completion from a progress label. */
export function readProcurementProgress(directory:string){
  const referencePath=resolve(directory,'job-reference.json'),path=resolve(directory,'vault');
  if(!existsSync(referencePath)||!existsSync(resolve(path,'key.json')))return {events:[],completion:null};
  const reference=z.object({scopeHash:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough().parse(readPrivateServiceJson(referencePath)),binding=reference.scopeHash;
  const vault=new BackgroundVault(path),hash=(s:string)=>createHash('sha256').update(`${binding}:${s}`).digest('hex');
  const read=(id:string)=>existsSync(resolve(path,`checkpoint-${id}.json`))?vault.open('checkpoint',id,binding):undefined;
  try{
    const events:{stage:string;at:string}[]=[];
    for(let i=0;i<128;i++){const raw=read(hash(String(i)));if(!raw)break;const value=z.object({stage:code,at:z.string().regex(/^\d+$/)}).passthrough().parse(raw);events.push({stage:value.stage,at:value.at});}
    const prep=read(hash('trace:preparation'))??read(hash('original-preparation-stop'));
    const p=prep&&typeof prep==='object'?prep as Record<string,unknown>:{};
    const candidate=DraftSchema.safeParse(p.candidate),review=ReviewResultSchema.safeParse(p.review),proposal=ProposeResultSchema.safeParse(p.proposal);
    const preflight=z.object({blockers:z.array(code)}).passthrough().safeParse(p.preflight);
    const failure=z.object({code}).strict().safeParse(read(hash('trace:failure')));
    const funding=z.object({status:code,error:code.optional(),funding:z.object({error:code.optional(),record:z.object({hash:digest.nullish(),status:code}).passthrough()}).passthrough().optional()}).passthrough().safeParse(read(hash('trace:funding')));
    // Recover the selected offer even while its JEV request is in flight.
    let selected=candidate.success?candidate.data:undefined;
    if(!selected)for(let i=0;i<events.length;i++){const c=DraftSchema.safeParse((read(hash(String(i))) as {candidate?:unknown})?.candidate);if(c.success)selected=c.data;}
    let expiration:unknown=null;
    const expired=read(hash('trace:expired-unfunded'));
    if(expired&&selected){const original=z.object({payload:AuthorizationPayloadSchema,dataset:z.array(z.number())}).strict().parse(vault.open('authorization',selected.intent.orderId.slice(2).toLowerCase(),binding));expiration=checkExpiredUnfunded(original.payload,expired)??null;}
    let completion:unknown=null;
    const final=read(hash('trace:completion'));
    if(final){
      if(!selected)throw Error('PROCUREMENT_TRACE_CANDIDATE_REQUIRED');
      const saved=z.object({payload:AuthorizationPayloadSchema,dataset:z.array(z.number())}).strict().parse(vault.open('authorization',selected.intent.orderId.slice(2).toLowerCase(),binding));
      const delivered=reportDelivery(saved.payload,saved.dataset),raw=final as {receipt:{hash:string};report:unknown;evidenceHash:string};
      if(JSON.stringify(raw.report)!==JSON.stringify(delivered.report)||raw.evidenceHash!==delivered.evidenceHash)throw Error('PROCUREMENT_TRACE_REPORT_MISMATCH');
      const receipt=checkWithdrawalReceipt({payload:saved.payload,beneficiary:saved.payload.intent.payee,hash:raw.receipt.hash},raw.receipt);
      if(receipt.status!=='CONFIRMED'||receipt.order.state!=='ALLOCATED_PAID'||receipt.order.evidenceHash.toLowerCase()!==delivered.evidenceHash.toLowerCase()||receipt.transferredAmount!==saved.payload.intent.price)throw Error('PROCUREMENT_TRACE_PAYOUT_UNPROVEN');
      completion={...delivered,receipt};
    }
    return {events,candidate:selected??null,review:review.success?review.data:null,proposal:proposal.success?proposal.data:null,
      blockers:preflight.success?preflight.data.blockers:[],failure:failure.success?failure.data.code:null,expiration,
      funding:funding.success?{status:funding.data.status,error:funding.data.funding?.error??funding.data.error??null,record:funding.data.funding?.record?{status:funding.data.funding.record.status,hash:funding.data.funding.record.hash??null}:null}:null,completion};
  }finally{vault.dispose();}
}
