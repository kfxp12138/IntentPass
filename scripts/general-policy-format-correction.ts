import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {readPrivateServiceJson,writePrivateServiceJsonOnce} from './create-privy-service-wallets.js';
import {semanticPrivyPolicyRules} from '../packages/adapters/src/privy-policy.js';
import {originalGeneralPolicyRequestHash} from './reconcile-general-policy.js';
/** Only the provider-confirmed invalid calldata syntax permits a fresh corrected
 * request. Preserve the original slot/key and quorum; no unknown is released. */
export function correctedGeneralPolicyRequest(journal:string,role:'buyer'|'seller',request:Record<string,unknown>,profileHash:string){
  const original=resolve(journal,role+'-policy-reserved.json');if(!existsSync(original))return {step:role+'-policy',request};
  const saved=z.object({profileHash:z.string(),request:z.record(z.string(),z.unknown())}).strict().parse(readPrivateServiceJson(original));if(isDeepStrictEqual(saved,{profileHash,request}))return {step:role+'-policy',request};
  const result=z.object({status:z.literal('ORIGINAL_HTTP_REJECTION'),httpStatus:z.literal(400),requestHash:z.string(),providerError:z.object({code:z.literal('invalid_policy_format'),error:z.string().includes('Function params does not exist on the provided abi')}).passthrough()}).strict().parse(readPrivateServiceJson(resolve(journal,role+'-policy-reconciliation-result.json')));
  if(saved.profileHash!==profileHash||result.requestHash!==originalGeneralPolicyRequestHash(saved.request))throw Error('GENERAL_CONNECTION_CORRECTION_CHANGED');
  const rules=saved.request.rules as {conditions:Record<string,unknown>[]}[],fixed=rules.map(r=>({...r,conditions:r.conditions.map(c=>({...c,field:({'params.spender':'approve.spender','params.amount':'approve.amount','params.memberIndex':'accept.memberIndex'} as Record<string,string>)[String(c.field)]??c.field}))}));
  const previous={...saved.request,rules:semanticPrivyPolicyRules(fixed as never)},next={...request,rules:semanticPrivyPolicyRules(request.rules as never)};if(!isDeepStrictEqual(previous,next))throw Error('GENERAL_CONNECTION_CORRECTION_SCOPE_CHANGED');
  const step=role+'-policy-calldata-v2',intent=resolve(journal,step+'-intent.json');if(!existsSync(intent))writePrivateServiceJsonOnce(intent,{profileHash,request:{...request,idempotency_key:randomUUID()}});
  const correction=z.object({profileHash:z.string(),request:z.record(z.string(),z.unknown())}).strict().parse(readPrivateServiceJson(intent));if(correction.profileHash!==profileHash||!isDeepStrictEqual({...correction.request,idempotency_key:request.idempotency_key},request))throw Error('GENERAL_CONNECTION_CORRECTION_CHANGED');return {step,request:correction.request};
}
