import {toHex} from 'viem';
import {DraftSchema} from './draft.js';
import {EvidenceDocumentsSchema,purchaseEvidenceHash} from './review-evidence.js';
import {digest} from './schemas.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Keep every catalog document. Identical restored copies may be deduplicated;
 * conflicting labels and supplements for another quote cannot replace them. */
export function mergeQuoteEvidence(catalog:unknown,supplied:unknown,quoteId:string){
  digest.parse(quoteId);const documents=EvidenceDocumentsSchema.parse(catalog),extra=EvidenceDocumentsSchema.parse(supplied),merged=structuredClone(documents);
  for(const doc of extra){const previous=merged.find(d=>d.id===doc.id);
    if(previous){if(previous.text!==doc.text||!eq(previous.subjectQuoteId,doc.subjectQuoteId))throw new Error('EVIDENCE_DOCUMENT_CONFLICT');continue;}
    if(!eq(doc.subjectQuoteId,quoteId))throw new Error('EVIDENCE_SUBJECT_MISMATCH');
    if(!doc.text.trim())throw new Error('EVIDENCE_TEXT_REQUIRED');merged.push(structuredClone(doc));
  }
  return EvidenceDocumentsSchema.parse(merged);
}
/** A new unsigned candidate only. Never edits policy, quote, roles, salt or deadlines. */
export function supplementDraftEvidence(input:unknown,document:unknown){
  const draft=DraftSchema.parse(input);if(draft.evidence.schemaVersion!==2)throw new Error('EVIDENCE_SALT_REQUIRED');
  const [doc]=EvidenceDocumentsSchema.parse([document]);if(draft.evidence.documents.some(d=>d.id===doc.id))throw new Error('EVIDENCE_DOCUMENT_ALREADY_INCLUDED');
  const evidence={...draft.evidence,documents:mergeQuoteEvidence(draft.evidence.documents,[doc],draft.quote.quoteId)},orderId=toHex(crypto.getRandomValues(new Uint8Array(32)));
  if(BigInt(orderId)===0n||eq(orderId,draft.intent.orderId))throw new Error('EVIDENCE_VERSION_ID_INVALID');
  return DraftSchema.parse({...draft,evidence,intent:{...draft.intent,orderId,attempt:(BigInt(draft.intent.attempt)+1n).toString(),purchaseEvidenceCommitment:purchaseEvidenceHash(evidence)}});
}
