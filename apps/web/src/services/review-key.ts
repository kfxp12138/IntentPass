import type {z} from 'zod';
import type {ReviewRequestSchema} from '../../../../packages/protocol/src/draft.js';
/** Preserve exact text/labels/order and payment scope. Omit only request randomness,
 * receipt deadlines and the seller's signature bytes, not signed quote content. */
export function reviewSemanticInput(request:z.infer<typeof ReviewRequestSchema>,model:string,questionConfigHash:string){
  const {policy:p,intent:e,quote:q,evidence}=request;
  return {version:1,model,questionConfigHash:questionConfigHash.toLowerCase(),policy:{...p,taskId:p.taskId.toLowerCase(),datasetHash:p.datasetHash.toLowerCase(),allowedAsset:p.allowedAsset.toLowerCase()},
    quote:{schemaVersion:q.schemaVersion,quoteId:q.quoteId.toLowerCase(),service:q.service,seller:q.seller.toLowerCase(),payee:q.payee.toLowerCase(),asset:q.asset.toLowerCase(),amount:q.amount,serviceTerms:q.serviceTerms,serviceTermsHash:q.serviceTermsHash.toLowerCase(),expiresAt:q.expiresAt},
    taskText:evidence.taskText,documents:evidence.documents.map(d=>({...d,subjectQuoteId:d.subjectQuoteId.toLowerCase()})),
    scope:{chainId:e.chainId,arbiter:e.arbiter.toLowerCase(),buyer:e.buyer.toLowerCase(),seller:e.seller.toLowerCase(),payee:e.payee.toLowerCase(),asset:e.asset.toLowerCase(),price:e.price,bond:e.bond,reviewer:e.reviewer.toLowerCase(),committeeHash:e.committeeHash.toLowerCase()}};
}
