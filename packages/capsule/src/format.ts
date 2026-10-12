import {z} from 'zod';
import {IntentCapsuleSchema,digest,address,TaskPolicySchema,IntentEnvelopeSchema,SignedQuoteSchema,DecisionReceiptSchema,CapabilityGrantSchema} from '../../protocol/src/schemas.js';
import {EvidenceBundleSchema} from '../../protocol/src/review-evidence.js';
export const NamespaceSchema=z.tuple([z.literal('intentpass'),z.literal('v1'),z.enum(['memory','authorization']),z.string().regex(/^[A-Za-z0-9_-]{1,128}$|^0x[a-f0-9]{64}$/)]);
export const KeyReferenceSchema=z.object({rpId:z.string().max(253).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),credentialId:z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/)}).strict();
export const CapsuleFileSchema=z.object({format:z.literal('IntentPass.Capsule.v1'),keyReference:KeyReferenceSchema,capsule:IntentCapsuleSchema}).strict().superRefine((value,ctx)=>{
  const n=NamespaceSchema.safeParse(value.capsule.namespace);
  if(!n.success)ctx.addIssue({code:'custom',message:'CAPSULE_NAMESPACE_INVALID'});
  else if(n.data[2]==='authorization'&&(value.capsule.revision!=='1'||n.data[3]!==value.capsule.objectId.toLowerCase()))ctx.addIssue({code:'custom',message:'AUTHORIZATION_CAPSULE_IMMUTABLE'});
  try{decodeBase64(value.capsule.iv);decodeBase64(value.capsule.ciphertext);const id=value.keyReference.credentialId;const canonical=encodeBase64(decodeBase64(id.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-id.length%4)%4))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');if(canonical!==id)throw new Error();}catch{ctx.addIssue({code:'custom',message:'CAPSULE_ENCODING_INVALID'});}
});
export type CapsuleFile=z.infer<typeof CapsuleFileSchema>;
export const TaskInputSchema=z.object({dataset:z.array(z.number().int().refine(Number.isSafeInteger)).min(1).max(10000),buyer:address,seller:address}).strict();
export const MemoryPayloadSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('memory'),policy:TaskPolicySchema,evidence:EvidenceBundleSchema,taskInput:TaskInputSchema.optional()}).strict();
export const AuthorizationPayloadSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('authorization'),policy:TaskPolicySchema,evidence:EvidenceBundleSchema,intent:IntentEnvelopeSchema,quote:SignedQuoteSchema,receipt:DecisionReceiptSchema,grant:CapabilityGrantSchema,ownerSignature:z.string().regex(/^0x[a-fA-F0-9]{130}$/),preparationHash:digest}).strict();
export const CapsulePayloadSchema=z.discriminatedUnion('kind',[MemoryPayloadSchema,AuthorizationPayloadSchema]);
export type CapsulePayload=z.infer<typeof CapsulePayloadSchema>;
export function encodeBase64(bytes:Uint8Array):string {let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return btoa(s);}
export function decodeBase64(text:string):Uint8Array<ArrayBuffer> {
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw new Error('CAPSULE_ENCODING_INVALID');
  const raw=atob(text),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));if(encodeBase64(bytes)!==text)throw new Error('CAPSULE_ENCODING_INVALID');return bytes;
}
export function capsuleAAD(input:unknown):Uint8Array<ArrayBuffer> {
  const f=CapsuleFileSchema.parse(input),c=f.capsule;
  return new TextEncoder().encode(JSON.stringify(['IntentPass.Capsule',1,c.namespace,c.objectId.toLowerCase(),c.revision,f.keyReference.rpId,f.keyReference.credentialId]));
}
export function memoryNamespace(agentId:string){return NamespaceSchema.parse(['intentpass','v1','memory',agentId]);}
export function authorizationNamespace(orderId:string){return NamespaceSchema.parse(['intentpass','v1','authorization',digest.parse(orderId).toLowerCase()]);}
