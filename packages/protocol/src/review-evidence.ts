import {z} from 'zod';
import {hashStruct,keccak256,toHex,type Hex} from 'viem';
import {digest} from './schemas.js';
export const EvidenceDocumentsSchema=z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),subjectQuoteId:digest,text:z.string().min(1).max(16000)}).strict()).max(12).refine(d=>new Set(d.map(v=>v.id)).size===d.length,'duplicate evidence ID');
export const EvidenceSaltSchema=digest.refine(v=>!/^0x0{64}$/i.test(v),'nonzero evidence salt');
const body={taskText:z.string().min(1).max(16000),documents:EvidenceDocumentsSchema};
export const LegacyEvidenceBundleSchema=z.object({schemaVersion:z.literal(1),...body}).strict();
export const SaltedEvidenceBundleSchema=z.object({schemaVersion:z.literal(2),salt:EvidenceSaltSchema,...body}).strict();
export const EvidenceBundleSchema=z.discriminatedUnion('schemaVersion',[LegacyEvidenceBundleSchema,SaltedEvidenceBundleSchema]);
/** Generated once for a new task. Never use a public ID or deterministic text as salt. */
export function createEvidenceSalt():Hex{const bytes=crypto.getRandomValues(new Uint8Array(32));try{return EvidenceSaltSchema.parse(toHex(bytes)) as Hex;}finally{bytes.fill(0);}}
export type EvidenceBundle=z.infer<typeof EvidenceBundleSchema>;
/** EIP-712 struct commitment; binds exact UTF-8, labels, quoted subject and array order. */
export function purchaseEvidenceHash(input:unknown):Hex {
  const b=EvidenceBundleSchema.parse(input),hash=(text:string)=>keccak256(toHex(text));
  const evidenceHash=hashStruct({primaryType:'PurchaseEvidence',types:{PurchaseEvidence:[{name:'schemaVersion',type:'uint256'},{name:'taskTextHash',type:'bytes32'},{name:'documents',type:'Document[]'}],Document:[{name:'idHash',type:'bytes32'},{name:'subjectQuoteId',type:'bytes32'},{name:'textHash',type:'bytes32'}]},data:{schemaVersion:1n,taskTextHash:hash(b.taskText),documents:b.documents.map(d=>({idHash:hash(d.id),subjectQuoteId:d.subjectQuoteId as Hex,textHash:hash(d.text)}))}});
  return b.schemaVersion===1?evidenceHash:hashStruct({primaryType:'SaltedPurchaseEvidence',types:{SaltedPurchaseEvidence:[{name:'schemaVersion',type:'uint256'},{name:'salt',type:'bytes32'},{name:'evidenceHash',type:'bytes32'}]},data:{schemaVersion:2n,salt:b.salt as Hex,evidenceHash}});
}
