import {createHash} from 'node:crypto';
import {existsSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {semanticPrivyPolicyRules} from '../packages/adapters/src/privy-policy.js';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';
import {readPrivateServiceJson,writePrivateServiceJsonOnce} from './create-privy-service-wallets.js';
export const OriginalGeneralPolicyRequestSchema=z.object({name:z.string(),version:z.literal('1.0'),chain_type:z.literal('ethereum'),owner_id:ProviderIdSchema,idempotency_key:z.uuid(),rules:z.array(z.unknown())}).strict();
export const originalGeneralPolicyRequestHash=(request:unknown)=>createHash('sha256').update(JSON.stringify(OriginalGeneralPolicyRequestSchema.parse(request))).digest('hex');

// Explicit original-response reconciliation; never called by the normal creator.
// Privy documents identical-body/key replay within 24h. Use a conservative 1h
// window, one durable replay slot and no SDK retries; quorum creates are excluded.
export async function reconcileGeneralPolicy(directory:string,role:'buyer'|'seller',port:{replay(request:unknown):Promise<unknown>;get(id:string):Promise<unknown>},now=Date.now()){
  const journal=resolve(directory,'connection-registration'),path=resolve(journal,role+'-policy-reserved.json'),saved=z.object({profileHash:z.string(),request:OriginalGeneralPolicyRequestSchema}).strict().parse(readPrivateServiceJson(path));
  const material=z.object({profileHash:z.string(),roles:z.array(z.object({role:z.enum(['buyer','seller']),policyKey:z.uuid()}).passthrough())}).passthrough().parse(readPrivateServiceJson(resolve(directory,'connection-material.json')));
  if(material.profileHash!==saved.profileHash||material.roles.find(r=>r.role===role)?.policyKey!==saved.request.idempotency_key)throw Error('GENERAL_CONNECTION_REPLAY_CHANGED');
  const originalResponse=resolve(journal,role+'-policy-response.json');if(existsSync(originalResponse))return {status:'ORIGINAL_RESPONSE_ALREADY_PRESENT' as const};
  const resultPath=resolve(journal,role+'-policy-reconciliation-result.json'),slot=resolve(journal,role+'-policy-reconciliation-reserved.json');
  if(existsSync(slot)){if(existsSync(resultPath))return z.object({status:z.string(),httpStatus:z.number().nullable(),requestHash:z.string()}).strip().parse(readPrivateServiceJson(resultPath));throw Error('GENERAL_CONNECTION_REPLAY_OUTCOME_UNKNOWN');}
  const created=Math.floor(statSync(path).birthtimeMs);if(!Number.isFinite(created)||created<=0||now<created||now-created>3600000)throw Error('GENERAL_CONNECTION_REPLAY_WINDOW_CLOSED');
  const requestHash=originalGeneralPolicyRequestHash(saved.request);writePrivateServiceJsonOnce(slot,{profileHash:saved.profileHash,requestHash,originalIdempotencyKey:saved.request.idempotency_key,originalReservationCreatedAt:created,replayedAt:now});
  let raw:unknown;
  try{raw=await port.replay(saved.request);}catch(error){
    const e=error as {status?:unknown;error?:unknown};const httpStatus=typeof e?.status==='number'?e.status:null;
    const record={status:httpStatus&&httpStatus>=400&&httpStatus<500?'ORIGINAL_HTTP_REJECTION':'UNKNOWN',httpStatus,requestHash,providerError:e?.error??null};writePrivateServiceJsonOnce(resultPath,record);
    return {status:record.status,httpStatus,requestHash};
  }
  const p=z.object({id:ProviderIdSchema,owner_id:z.literal(saved.request.owner_id),version:z.literal('1.0'),chain_type:z.literal('ethereum'),rules:z.array(z.unknown())}).passthrough().parse(raw);
  const sameRules=(candidate:unknown)=>{const value=z.object({id:z.literal(p.id),owner_id:z.literal(saved.request.owner_id),version:z.literal('1.0'),chain_type:z.literal('ethereum'),rules:z.array(z.unknown())}).passthrough().parse(candidate);if(!isDeepStrictEqual(semanticPrivyPolicyRules(value.rules as never),semanticPrivyPolicyRules(saved.request.rules as never)))throw Error('GENERAL_CONNECTION_POLICY_MISMATCH');};
  sameRules(raw);sameRules(await port.get(p.id));writePrivateServiceJsonOnce(originalResponse,{result:{id:p.id}});writePrivateServiceJsonOnce(resultPath,{status:'ORIGINAL_RESPONSE_VERIFIED',httpStatus:200,requestHash,policyId:p.id});return {status:'ORIGINAL_RESPONSE_VERIFIED',httpStatus:200,requestHash};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const role=z.enum(['buyer','seller']).parse(process.argv[2]),client=createPrivyClient({appId:process.env.PRIVY_APP_ID!,appSecret:process.env.PRIVY_APP_SECRET!}),policies=client.policies();const result=await reconcileGeneralPolicy(resolve(process.env.AUTOMATION_DATA_DIRECTORY??'.tools/general-automation'),role,{replay:request=>policies.create(request as Parameters<typeof policies.create>[0]),get:id=>policies.get(id)});console.log(JSON.stringify(result));if(result.status!=='ORIGINAL_RESPONSE_VERIFIED'&&result.status!=='ORIGINAL_RESPONSE_ALREADY_PRESENT')process.exitCode=1;}
  catch(error){console.error(JSON.stringify({status:'BLOCKED',code:error instanceof Error&&/^GENERAL_CONNECTION_[A-Z_]+$/.test(error.message)?error.message:'GENERAL_CONNECTION_RECONCILIATION_UNAVAILABLE'}));process.exitCode=1;}
}
