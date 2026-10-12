import {z} from 'zod';
import {createHash} from 'node:crypto';
import {address,digest,positiveUint} from '../../protocol/src/schemas.js';
import {AuthorizationPayloadSchema,MemoryPayloadSchema} from '../../capsule/src/format.js';
import {RecoveryDeploymentSchema} from '../../capsule/src/recovery.js';
import {createReport} from '../../protocol/src/report.js';
import {GeneralAutomationProfileSchema,generalProfileHash,type GeneralAutomationProfile} from './general-profile.js';

export const BackgroundScopeSchema=z.object({
  version:z.literal(1),mode:z.literal('single-report-background'),chainId:z.literal('10143'),
  deployment:RecoveryDeploymentSchema,taskId:digest,datasetHash:digest,quoteId:digest,
  buyer:address,seller:address,payee:address,maxTotalUnits:positiveUint,maxOrders:z.literal(1),
  expiresAt:positiveUint,backup:z.literal('server-local-aes256gcm'),
}).strict().superRefine((s,c)=>{
  if(s.deployment.chainId!==s.chainId||BigInt(s.maxTotalUnits)>10n||s.seller.toLowerCase()!==s.payee.toLowerCase()||s.buyer.toLowerCase()===s.seller.toLowerCase()
    ||![s.buyer,s.seller].every(a=>s.deployment.committee.some(m=>m.toLowerCase()===a.toLowerCase())))c.addIssue({code:'custom',message:'BACKGROUND_SCOPE_INVALID'});
});
export type BackgroundScope=z.infer<typeof BackgroundScopeSchema>;
export const GeneralJobScopeSchema=z.object({version:z.literal(1),mode:z.literal('general-job'),chainId:z.literal('10143'),deployment:RecoveryDeploymentSchema,
  taskId:digest,datasetHash:digest,quoteId:digest.nullable(),buyer:address,seller:address,payee:address,maxTotalUnits:positiveUint,maxOrders:z.literal(1),expiresAt:positiveUint,
  backup:z.literal('server-local-aes256gcm'),profile:GeneralAutomationProfileSchema,profileHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().superRefine((s,c)=>{
    if(s.profileHash!==generalProfileHash(s.profile)||JSON.stringify(s.deployment)!==JSON.stringify(s.profile.deployment)||s.chainId!==s.deployment.chainId||s.buyer.toLowerCase()!==s.profile.buyer.toLowerCase()||s.seller.toLowerCase()!==s.profile.seller.toLowerCase()||s.payee.toLowerCase()!==s.seller.toLowerCase()||s.profile.maxUnitsPerOrder!==null&&BigInt(s.maxTotalUnits)>BigInt(s.profile.maxUnitsPerOrder)||s.profile.expiresAt!==null&&BigInt(s.expiresAt)>BigInt(s.profile.expiresAt))c.addIssue({code:'custom',message:'GENERAL_JOB_PROFILE_MISMATCH'});
});
export const ExecutionScopeSchema=z.union([BackgroundScopeSchema,GeneralJobScopeSchema]);
export type ExecutionScope=z.infer<typeof ExecutionScopeSchema>;
export function executionScopeHash(input:unknown){return createHash('sha256').update(JSON.stringify(ExecutionScopeSchema.parse(input))).digest('hex');}
export function generalJobScope(input:unknown,memory:unknown,now:bigint){const profile=GeneralAutomationProfileSchema.parse(input),m=MemoryPayloadSchema.parse(memory);if(!profile.enabled)throw Error('GENERAL_PROFILE_NOT_ENABLED');if(!m.taskInput||m.taskInput.buyer.toLowerCase()!==profile.buyer.toLowerCase()||m.taskInput.seller.toLowerCase()!==profile.seller.toLowerCase())throw Error('GENERAL_ROLE_CONFIGURATION_REQUIRED');
  const end=now+BigInt(profile.settlementSeconds);if(profile.expiresAt!==null&&BigInt(profile.expiresAt)<end)throw Error('GENERAL_PROFILE_EXPIRES_BEFORE_SETTLEMENT');const expiresAt=String(end);
  return GeneralJobScopeSchema.parse({version:1,mode:'general-job',chainId:profile.deployment.chainId,deployment:profile.deployment,taskId:m.policy.taskId,datasetHash:m.policy.datasetHash,quoteId:null,buyer:profile.buyer,seller:profile.seller,payee:profile.seller,maxTotalUnits:m.policy.budget,maxOrders:1,expiresAt,backup:'server-local-aes256gcm',profile,profileHash:generalProfileHash(profile)});
}
export function backgroundScopeHash(input:unknown){return createHash('sha256').update(JSON.stringify(BackgroundScopeSchema.parse(input))).digest('hex');}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function assertBackgroundTask(scope:ExecutionScope,input:unknown,now:bigint){
  const s=ExecutionScopeSchema.parse(scope),m=MemoryPayloadSchema.parse(input);
  if(now>=BigInt(s.expiresAt)||s.mode==='single-report-background'&&BigInt(s.expiresAt)>now+86400n||!m.taskInput||!eq(m.policy.taskId,s.taskId)||!eq(m.policy.datasetHash,s.datasetHash)||!eq(m.policy.allowedAsset,s.deployment.asset)
    ||BigInt(m.policy.budget)>BigInt(s.maxTotalUnits)||!eq(m.taskInput.buyer,s.buyer)||!eq(m.taskInput.seller,s.seller)||!eq(createReport(m.taskInput.dataset).datasetHash,s.datasetHash))throw Error('BACKGROUND_TASK_SCOPE_REJECTED');
  return m;
}
export function assertBackgroundUnsignedAuthorization(scope:ExecutionScope,input:unknown,now:bigint){
  const s=ExecutionScopeSchema.parse(scope),p=AuthorizationPayloadSchema.omit({ownerSignature:true}).parse(input),e=p.intent,g=p.grant;
  if(now>=BigInt(s.expiresAt)||s.mode==='single-report-background'&&BigInt(s.expiresAt)>now+86400n||!eq(p.policy.taskId,s.taskId)||!eq(e.datasetHash,s.datasetHash)||s.quoteId!==null&&!eq(p.quote.quoteId,s.quoteId)
    ||e.chainId!==s.chainId||!eq(e.arbiter,s.deployment.arbiter)||!eq(e.asset,s.deployment.asset)||!eq(e.buyer,s.buyer)||!eq(e.seller,s.seller)||!eq(e.payee,s.payee)
    ||!eq(g.executor,s.deployment.executor)||BigInt(g.amount)>BigInt(s.maxTotalUnits)||BigInt(e.price)+BigInt(e.bond)!==BigInt(g.amount)
    ||g.maxUses!==1||BigInt(g.deadline)>BigInt(s.expiresAt)||BigInt(e.settlementDeadline)>BigInt(s.expiresAt))throw Error('BACKGROUND_ORDER_SCOPE_REJECTED');
  return p;
}
export function assertBackgroundAuthorization(scope:ExecutionScope,input:unknown,now:bigint){const p=AuthorizationPayloadSchema.parse(input);const {ownerSignature:_signature,...unsigned}=p;assertBackgroundUnsignedAuthorization(scope,unsigned,now);return p;}
