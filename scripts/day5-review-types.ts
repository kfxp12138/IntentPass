import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {isIP} from 'node:net';
import {NamespaceSchema} from '../packages/capsule/src/format.js';
import {orderStates} from '../packages/protocol/src/escrow-read.js';
import {releaseEvidencePathPattern} from './release-evidence-types.js';
import {auditBytes} from './public-audit.js';

export const day5ReviewScope='OPERATOR_RECORDED_MANUAL_D5_BROWSER_CHECKS' as const;
export const day5Assertions={
  'D5-01':['TWO_NON_WALLET_NAMESPACES_CREATED_ON_A','ONLY_CIPHERTEXT_AND_METADATA_PERSISTED','REPEATED_PLAINTEXT_USES_DISTINCT_IVS'],
  'D5-02':['SAME_PASSKEY_AND_RPID_ON_INDEPENDENT_CONTEXT','SAME_ORIGINAL_CONTENTS_RECOVERED','NO_KEY_PRF_OR_LOCAL_SESSION_COPIED','REAL_HUMAN_CEREMONY_NO_VIRTUAL_AUTHENTICATOR'],
  'D5-03':['NAMESPACE_CHANGE_REJECTED','DIFFERENT_PASSKEY_REJECTED','CIPHERTEXT_AND_AAD_TAMPER_REJECTED','NO_PLAINTEXT_FALLBACK'],
  'D5-04':['FUNDED_OR_PAID_ORIGINAL_ORDER_RESTORED','ORIGINAL_ORDER_ID_AND_CONTEXT_PRESERVED','LATEST_FINALIZED_ORDER_READ_BEFORE_CONTINUE','NO_REPEAT_FUNDING_OR_NEW_PAYMENT_AUTHORIZATION'],
  'D5-05':['PAYEE_OR_CONTEXT_TAMPER_REJECTED','ORIGINAL_SIGNATURE_OR_CHAIN_COMMITMENT_RECHECKED','NO_NEW_VALID_PAYMENT_GRANTED'],
  'D5-06':['NETWORK_STORAGE_LOG_EXPORT_REVIEWED','NO_PERSISTED_PRF_OR_DERIVED_KEYS','NO_UNAUTHORIZED_PRIVATE_PLAINTEXT','SERVER_CIPHERTEXT_AND_MINIMAL_METADATA_ONLY'],
  'D5-07':['ALL_FOUR_PAGES_WALKED','NORMAL_PAUSE_REJECT_BLOCK_CANCEL_RESTORE_OPERABLE','REAL_AUTH_BROWSER_CHAIN_CONTEXT_USED'],
} as const;
export type Day5CheckId=keyof typeof day5Assertions;
export const day5CheckIds=Object.keys(day5Assertions) as Day5CheckId[];
const id=z.enum(day5CheckIds as [Day5CheckId,...Day5CheckId[]]);
const status=z.enum(['PASS','FAIL','BLOCKED']),sha=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/),time=z.iso.datetime();
const digest=z.string().regex(/^0x[a-f0-9]{64}$/),address=z.string().regex(/^0x[a-fA-F0-9]{40}$/).refine(v=>!/^0x0{40}$/.test(v));
const alias=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** Public origin and RP declarations only; their existence is not a reachability proof. */
export const Day5PublicConfigurationSchema=z.object({
  publicUrl:z.string().max(2048).refine(value=>{try{const u=new URL(value);return u.href===value&&u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!u.port&&!isIP(u.hostname)&&u.hostname.includes('.')&&!['localhost','localhost.localdomain'].includes(u.hostname)&&!/[.](?:localhost|local|internal)$/.test(u.hostname);}catch{return false;}}),
  rpId:z.string().max(253).regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/),
}).strict().superRefine((value,ctx)=>{try{const host=new URL(value.publicUrl).hostname;if(host!==value.rpId&&!host.endsWith('.'+value.rpId)||!value.rpId.includes('.'))ctx.addIssue({code:'custom',message:'RP_HOST_MISMATCH'});}catch{ctx.addIssue({code:'custom',message:'PUBLIC_URL_INVALID'});}if(auditBytes('day5-public-configuration.json',Buffer.from(JSON.stringify(value))).length)ctx.addIssue({code:'custom',message:'PUBLIC_CONFIGURATION_UNSAFE'});});
const namespaceObject=z.object({namespace:NamespaceSchema,objectId:digest,revision:z.string().regex(/^[1-9][0-9]*$/).max(20)}).strict();
export const Day5BrowserContextSchema=z.object({
  configuration:Day5PublicConfigurationSchema,
  observationsStartedAt:time,observationsEndedAt:time,
  primaryContext:alias,
  secondaryContext:z.object({id:alias,kind:z.enum(['PHYSICAL_DEVICE','NEW_BROWSER_PROFILE'])}).strict().nullable(),
  namespaces:z.tuple([namespaceObject,namespaceObject]),
  originalOrder:z.object({chainId:z.literal(10143),escrow:address,taskId:digest,orderId:digest,contextHash:digest,
    finalizedObservation:z.object({blockNumber:z.string().regex(/^(?:0|[1-9][0-9]*)$/),blockHash:digest,state:z.enum(orderStates).exclude(['UNREGISTERED']),evidenceSha256:sha}).strict().nullable(),
  }).strict().nullable(),
}).strict().superRefine((value,ctx)=>{
  const [memory,authorization]=value.namespaces;
  if(memory.namespace[2]!=='memory'||authorization.namespace[2]!=='authorization'||authorization.revision!=='1'||authorization.namespace[3]!==authorization.objectId)ctx.addIssue({code:'custom',message:'NAMESPACE_BINDING_INVALID'});
  if(value.secondaryContext?.id===value.primaryContext)ctx.addIssue({code:'custom',message:'SECONDARY_CONTEXT_NOT_INDEPENDENT'});
  if(Date.parse(value.observationsEndedAt)<Date.parse(value.observationsStartedAt))ctx.addIssue({code:'custom',message:'OBSERVATION_TIME_INVALID'});
  if(value.originalOrder&&(authorization.objectId!==value.originalOrder.orderId||memory.objectId!==value.originalOrder.taskId))ctx.addIssue({code:'custom',message:'ORIGINAL_ORDER_NAMESPACE_MISMATCH'});
});
export const Day5PublicEvidenceSchema=z.object({path:z.string().max(4096).regex(releaseEvidencePathPattern),bytes:z.number().int().positive().max(536870912),sha256:sha}).strict();
const privateEvidence=Day5PublicEvidenceSchema.extend({path:z.string().max(4096).refine(isAbsolute)}).strict();
const assertions=(check:Day5CheckId)=>z.object(Object.fromEntries(day5Assertions[check].map(key=>[key,z.boolean()]))).strict();
const checkSchema=(check:Day5CheckId,privateRecord:boolean)=>z.object({id:z.literal(check),status,assertions:assertions(check),evidence:z.array(privateRecord?privateEvidence:Day5PublicEvidenceSchema).max(64),...(privateRecord?{reviewer:alias}:{})}).strict();
const checks=(privateRecord:boolean)=>z.union(day5CheckIds.map(check=>checkSchema(check,privateRecord)) as [ReturnType<typeof checkSchema>,ReturnType<typeof checkSchema>,...ReturnType<typeof checkSchema>[]]);
export const Day5ReviewSchema=z.object({schemaVersion:z.literal(1),scope:z.literal(day5ReviewScope),sourceCommit:commit,reviewedAt:time,context:Day5BrowserContextSchema,checks:z.array(checks(true)).max(7)}).strict().superRefine((record,ctx)=>{if(new Set(record.checks.map(check=>check.id)).size!==record.checks.length)ctx.addIssue({code:'custom',message:'DUPLICATE_CHECK'});});
export const day5ReviewLimits=[
  'Operator-record format, fixed assertions, source/time/context and current public evidence bytes are checked; this is not independent provider or human attestation.',
  'A record cannot independently establish a real passkey ceremony, separate device/profile, secure reachable origin, authentication or finalized public-chain observation.',
  'No passkey ceremonies, provider calls, wallet actions, funds transfers or retries are performed by this validator.',
  'Only explicitly public redacted evidence is read; byte heuristics do not decode media or prove absence of arbitrary private content.',
  'Private record paths and reviewer aliases are omitted; the input digest binds validated record bytes, not provenance. No other stage or release profile inherits PASS.',
] as const;
export const Day5ReviewManifestSchema=z.object({schemaVersion:z.literal(1),scope:z.literal(day5ReviewScope),status,sha256:sha.nullable(),sourceCommit:commit.nullable(),reviewedAt:time.nullable(),context:Day5BrowserContextSchema.nullable(),
  timeWindow:z.object({sourceCommittedAt:time.nullable(),startedAt:time,checkedAt:time}).strict(),checks:z.array(checks(false)).length(7),
  issues:z.array(z.object({code:z.string().regex(/^[A-Z_]+$/),id:id.optional(),evidenceIndex:z.number().int().min(0).max(63).optional()}).strict()),limits:z.array(z.string()),
}).strict().superRefine((record,ctx)=>{if(record.checks.some((check,index)=>check.id!==day5CheckIds[index]))ctx.addIssue({code:'custom',message:'CHECK_ORDER_INVALID'});});
export type Day5ReviewManifest=z.infer<typeof Day5ReviewManifestSchema>;
export interface Day5ReviewContext {root:string;commit:string|null;sourceCommittedAt:string|null;startedAt:string;checkedAt:string;worktreeDirty:boolean;localPassed:boolean;expectedPublicConfiguration:z.infer<typeof Day5PublicConfigurationSchema>|null;}
