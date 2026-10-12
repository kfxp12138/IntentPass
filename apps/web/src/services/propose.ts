import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {TaskPolicySchema,SignedQuoteSchema,IntentEnvelopeSchema,address,digest,positiveUint,uint} from '../../../../packages/protocol/src/schemas.js';
import {EvidenceBundleSchema,purchaseEvidenceHash} from '../../../../packages/protocol/src/review-evidence.js';
import {mergeQuoteEvidence} from '../../../../packages/protocol/src/evidence-version.js';
import {policyHash,termsHash,verifyQuoteSignature} from '../../../../packages/protocol/src/typed-data.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from '../../../../packages/protocol/src/escrow.js';
import type {EscrowDeployment} from '../../../../packages/protocol/src/escrow-read.js';
import type {Principal} from '../../../../packages/adapters/src/privy-auth.js';
import {PlannerSelectionSchema,type PlannerPort} from '../../../../packages/adapters/src/planner.js';
import {ProposeRequestSchema,CatalogEntrySchema} from '../../../../packages/protocol/src/purchase-api.js';
export {ProposeRequestSchema,CatalogEntrySchema};
export interface QuoteCatalog {get(quoteId:string):Promise<unknown|undefined>;}
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export class ProposalService {
  private readonly bond:string;private readonly deliverySeconds:bigint;private readonly settlementSeconds:bigint;private readonly startedAt:bigint|undefined;
  constructor(private readonly planner:PlannerPort,private readonly catalog:QuoteCatalog,private readonly deployment:EscrowDeployment,config:{bond:string;deliverySeconds:string;settlementSeconds:string;startedAt?:string},private readonly clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000))) {
    this.bond=uint.parse(config.bond);this.deliverySeconds=BigInt(positiveUint.parse(config.deliverySeconds));this.settlementSeconds=BigInt(positiveUint.parse(config.settlementSeconds));if(this.settlementSeconds<=this.deliverySeconds)throw new Error('PROPOSAL_CONFIG_INVALID');
    this.startedAt=config.startedAt===undefined?undefined:BigInt(positiveUint.parse(config.startedAt));
  }
  async propose(input:unknown,principal:Principal) {
    const parsed=ProposeRequestSchema.safeParse(input),reject=(code:string)=>({status:'REJECT' as const,code});
    if(!parsed.success)return reject('INPUT_INVALID');
    const {policy,taskText,buyer,quoteRefs}=parsed.data;
    if(!principal.wallets.some(w=>eq(w,buyer)))return reject('OWNER_MISMATCH');
    if(!eq(policy.allowedAsset,this.deployment.asset))return reject('ASSET_MISMATCH');
    const requestStarted=this.clock(),now=this.startedAt??requestStarted,domain={chainId:this.deployment.chainId,arbiter:this.deployment.arbiter};
    if(now>requestStarted||requestStarted>=now+this.deliverySeconds)return {status:'ABSTAIN' as const,code:'TASK_DELIVERY_WINDOW_UNAVAILABLE'};
    const entries:z.infer<typeof CatalogEntrySchema>[]=[];
    try{for(const ref of quoteRefs){const result=await this.catalog.get(ref);if(result===undefined)return reject('QUOTE_NOT_FOUND');const entry=CatalogEntrySchema.safeParse(result);if(!entry.success)return reject('CATALOG_INVALID');const q=entry.data.quote;
      if(!eq(q.quoteId,ref)||!eq(q.asset,policy.allowedAsset)||!eq(termsHash(q.serviceTerms),q.serviceTermsHash)||!await verifyQuoteSignature(q,domain))return reject('QUOTE_INVALID');
      if(requestStarted<0n||BigInt(q.expiresAt)<=requestStarted)return reject('QUOTE_EXPIRED');
      if(BigInt(q.amount)+BigInt(this.bond)>BigInt(policy.budget))return reject('OVER_BUDGET');
      // Parse the complete bundle now, including duplicate evidence labels.
      if(!EvidenceBundleSchema.safeParse({schemaVersion:1,taskText,documents:entry.data.documents}).success)return reject('CATALOG_INVALID');entries.push(entry.data);
    }}catch{return {status:'ABSTAIN' as const,code:'CATALOG_UNAVAILABLE'};}
    let selection:z.infer<typeof PlannerSelectionSchema>;
    try{selection=PlannerSelectionSchema.parse(await this.planner.select({policy,taskText,catalog:entries}));}catch{return {status:'ABSTAIN' as const,code:'PLANNER_UNAVAILABLE_OR_INVALID'};}
    const selected=entries.find(entry=>eq(entry.quote.quoteId,selection.quoteId));if(!selected)return reject('UNKNOWN_QUOTE_REFERENCE');
    if(selection.evidenceIds.some(id=>!selected.documents.some(d=>d.id===id)))return reject('UNKNOWN_EVIDENCE_REFERENCE');
    const q=selected.quote,current=this.clock();if(current<requestStarted||current>=BigInt(q.expiresAt))return {status:'ABSTAIN' as const,code:'QUOTE_EXPIRED_DURING_PLANNING'};
    if(current>=now+this.deliverySeconds)return {status:'ABSTAIN' as const,code:'DELIVERY_WINDOW_EXPIRED_DURING_PLANNING'};
    let documents;try{documents=mergeQuoteEvidence(selected.documents,parsed.data.additionalEvidence??[],q.quoteId);}catch{return reject('ADDITIONAL_EVIDENCE_INVALID');}
    // Citations do not filter the evidence sent for review; all supplied documents remain bound.
    const evidence=EvidenceBundleSchema.parse({schemaVersion:2,salt:parsed.data.evidenceSalt??`0x${randomBytes(32).toString('hex')}`,taskText,documents});
    const intent=IntentEnvelopeSchema.parse({schemaVersion:1,chainId:this.deployment.chainId,arbiter:this.deployment.arbiter,orderId:`0x${randomBytes(32).toString('hex')}`,taskId:policy.taskId,attempt:'1',buyer,seller:q.seller,payee:q.payee,asset:q.asset,price:q.amount,bond:this.bond,datasetHash:policy.datasetHash,serviceTermsHash:q.serviceTermsHash,purchaseEvidenceCommitment:purchaseEvidenceHash(evidence),policyHash:policyHash(policy),reviewer:this.deployment.reviewer,committeeHash:this.deployment.committeeHash,threshold:2,deliverySchemaHash:DELIVERY_SCHEMA,deliveryDeadline:String(now+this.deliverySeconds),settlementDeadline:String(now+this.settlementSeconds),allocationPolicyHash:ALLOCATION_POLICY,intentReleasePolicyHash:RELEASE_POLICY,pactPaymentPublicKeyHash:ZERO_HASH});
    return {status:'DRAFT' as const,modelId:this.planner.model,policy,quote:q,evidence,intent,citations:selection.evidenceIds};
  }
}
