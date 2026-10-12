import {z} from 'zod';
import {encodeFunctionData,encodeAbiParameters,parseAbi,parseAbiParameters,keccak256,type Address,type Hex,type Transaction,type TransactionReceipt} from 'viem';
import {address,digest,uint} from './schemas.js';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
import {datasetSchema,reportSchema} from './report.js';
import {OrderSnapshotSchema,type OrderSnapshot} from './escrow-read.js';
import {Day4ChainBlockSchema} from './day4-chain-flow-types.js';
import {Day4CreationPairConfigSchema,Day4CreationPairRequestSchema,Day4CreationPairProofSchema,type Day4CreationPairPort} from './day4-origin-types.js';

const nonzero=address.refine(value=>!/^0x0{40}$/i.test(value));
export const day4AssetFailureIds=['SETTLEMENT','REFUND','WITHDRAWAL'] as const;
export const Day4AssetFailureConfigSchema=Day4CreationPairConfigSchema.safeExtend({executor:nonzero});
const originalCase=z.object({payload:AuthorizationPayloadSchema,dataset:datasetSchema,report:reportSchema,
  fundingTransaction:digest,failedTransaction:digest}).strict();
export const Day4AssetFailureRequestSchema=z.object({schemaVersion:z.literal(1),creations:Day4CreationPairRequestSchema,
  settlement:originalCase,refund:originalCase,withdrawal:originalCase.extend({beneficiary:nonzero,
    allocationTransaction:digest,allocationAction:z.enum(['settle','timeout'])}).strict()}).strict().superRefine((v,c)=>{
  const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  const failures=[v.settlement.failedTransaction,v.refund.failedTransaction,v.withdrawal.failedTransaction];
  const success=[v.creations.gateTransaction,v.creations.escrowTransaction,v.settlement.fundingTransaction,
    v.refund.fundingTransaction,v.withdrawal.fundingTransaction,v.withdrawal.allocationTransaction];
  if(eq(v.settlement.payload.intent.orderId,v.refund.payload.intent.orderId)||new Set(failures.map(x=>x.toLowerCase())).size!==3
    ||failures.some(x=>success.some(y=>eq(x,y))))c.addIssue({code:'custom',message:'DISTINCT_ORIGINAL_FAILURE_CASES_REQUIRED'});
});
export type Day4AssetFailureConfig=z.infer<typeof Day4AssetFailureConfigSchema>;
export type Day4AssetFailureRequest=z.infer<typeof Day4AssetFailureRequestSchema>;

/** Sanitized, bounded callTracer frames. Textual error/revertReason is excluded. */
export interface Day4FailureTraceNode{
  type:'CALL'|'STATICCALL'|'DELEGATECALL'|'CALLCODE'|'CREATE'|'CREATE2'|'SELFDESTRUCT';
  from:Address;to:Address|null;value:bigint;gas:bigint;gasUsed:bigint;input:Hex;output:Hex;failed:boolean;
  calls:readonly Day4FailureTraceNode[];
}
export type Day4FailureTraceResult={status:'AVAILABLE';trace:Day4FailureTraceNode}
  |{status:'UNAVAILABLE';reason:'RPC_UNAVAILABLE'|'TRACE_INVALID'|'TRACE_LIMIT_EXCEEDED'};
export type Day4FailureTransaction=Pick<Transaction,'hash'|'from'|'to'|'input'|'value'|'nonce'|'gas'|'blockNumber'|'blockHash'|'transactionIndex'>&{chainId?:number};
export type Day4FailureReceipt=Pick<TransactionReceipt,'transactionHash'|'from'|'to'|'status'|'contractAddress'|'blockNumber'|'blockHash'|'transactionIndex'|'logs'|'gasUsed'>;
export interface Day4AssetFailurePort extends Day4CreationPairPort{
  transaction(hash:Hex):Promise<Day4FailureTransaction|null>;
  receipt(hash:Hex):Promise<Day4FailureReceipt|null>;
  orderAt(id:Hex,number:bigint):Promise<OrderSnapshot>;
  traceTransaction(hash:Hex):Promise<Day4FailureTraceResult>;
}
const originalTransaction=z.object({hash:digest,from:nonzero,to:nonzero,calldataHash:digest,gas:uint,
  gasUsed:uint,nonce:z.number().int().nonnegative().safe(),block:Day4ChainBlockSchema,
  transactionIndex:z.number().int().nonnegative().safe()}).strict();
export const day4AssetFailureConditions=['QUALIFICATION_FALSE','TRANSFER_FALSE','TRANSFER_AMOUNT_MISMATCH'] as const;
export const day4QualificationRejectIds=['POOL_REGISTERED','FROM_COMPLIANT','TO_COMPLIANT','POLICY_CAN_TRANSFER'] as const;
export const Day4AssetFailureTraceObservationSchema=z.object({fingerprint:digest,rootOutputHash:digest,rootGas:uint,rootGasUsed:uint,
  directCalls:z.number().int().min(1).max(6),condition:z.enum(day4AssetFailureConditions),beneficiary:nonzero,amount:uint,
  qualificationRejectAt:z.enum(day4QualificationRejectIds).nullable(),creditWritesReached:z.boolean(),
  balances:z.object({poolBefore:uint,beneficiaryBefore:uint,poolAfter:uint.nullable(),beneficiaryAfter:uint.nullable()}).strict().nullable()}).strict().superRefine((v,c)=>{
  if(v.amount==='0'||(v.condition==='QUALIFICATION_FALSE')!==(v.qualificationRejectAt!==null)
    ||(v.condition==='QUALIFICATION_FALSE')!==(v.balances===null)
    ||v.condition==='QUALIFICATION_FALSE'&&v.creditWritesReached
    ||v.condition!=='QUALIFICATION_FALSE'&&!v.creditWritesReached
    ||v.condition==='TRANSFER_FALSE'&&(v.directCalls!==4||v.balances?.poolAfter!==null||v.balances?.beneficiaryAfter!==null))
    c.addIssue({code:'custom',message:'FAILURE_TRACE_OBSERVATION_INCONSISTENT'});
  if(v.condition==='TRANSFER_AMOUNT_MISMATCH'&&v.balances){
    const b=v.balances;
    if(![v.amount,b.poolBefore,b.beneficiaryBefore,...(b.poolAfter===null?[]:[b.poolAfter]),...(b.beneficiaryAfter===null?[]:[b.beneficiaryAfter])].every(x=>uint.safeParse(x).success))return;
    if(b.poolAfter===null||BigInt(b.poolAfter)>BigInt(b.poolBefore))c.addIssue({code:'custom',message:'FAILURE_BALANCE_MISMATCH_UNPROVEN'});
    else if(BigInt(b.poolBefore)-BigInt(b.poolAfter)!==BigInt(v.amount)){
      if(b.beneficiaryAfter!==null||v.directCalls!==5)c.addIssue({code:'custom',message:'FAILURE_BALANCE_SHORT_CIRCUIT_INVALID'});
    }else if(b.beneficiaryAfter===null||BigInt(b.beneficiaryAfter)<BigInt(b.beneficiaryBefore)
      ||BigInt(b.beneficiaryAfter)-BigInt(b.beneficiaryBefore)===BigInt(v.amount)||v.directCalls!==6)c.addIssue({code:'custom',message:'FAILURE_BALANCE_MISMATCH_UNPROVEN'});
  }
});
export const Day4AssetFailureObservationSchema=z.object({id:z.enum(day4AssetFailureIds),status:z.enum(['VERIFIED','BLOCKED']),
  reason:z.enum(['EXACT_ORIGINAL_FAILURE_PATH','TRACE_UNAVAILABLE','TRACE_INVALID','TRACE_LIMIT_EXCEEDED','FAILURE_CAUSE_UNCLASSIFIED']),
  funding:originalTransaction,failure:originalTransaction,allocation:originalTransaction.nullable(),order:OrderSnapshotSchema,
  trace:Day4AssetFailureTraceObservationSchema.nullable(),
  transactionEffectsUncommitted:z.literal(true),ledgerScope:z.literal('FAILURE_HEIGHT_BLOCK_END_NOT_TRANSACTION_PRESTATE_OR_BALANCE_DELTA')}).strict().superRefine((v,c)=>{
  if((v.status==='VERIFIED')!==(v.trace!==null)||(v.status==='VERIFIED')!==(v.reason==='EXACT_ORIGINAL_FAILURE_PATH')
    ||(v.id==='WITHDRAWAL')!==(v.allocation!==null))c.addIssue({code:'custom',message:'FAILURE_OBSERVATION_INCONSISTENT'});
});
export const Day4AssetFailureProofSchema=z.object({schemaVersion:z.literal(1),
  scope:z.literal('FINALIZED_ORIGINAL_FAILURE_TRACES_AND_BLOCK_END_LEDGER_NOT_OFFICIAL_ASSET_PROVENANCE_OR_FULL_D4'),
  status:z.enum(['COMPLETE','BLOCKED']),config:Day4AssetFailureConfigSchema,finalizedAnchor:Day4ChainBlockSchema,
  creations:z.array(Day4CreationPairProofSchema).min(1).max(7),observations:z.array(Day4AssetFailureObservationSchema).length(3),
  officialIntegrationVerified:z.literal(false),financialAcceptanceStatus:z.literal('BLOCKED'),canExecute:z.literal(false),
  signaturesRequested:z.literal(0),transactionsSent:z.literal(0),limits:z.array(z.string())}).strict().superRefine((v,c)=>{
  const bad=()=>c.addIssue({code:'custom',message:'ASSET_FAILURE_PROOF_BINDING_INVALID'}),eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(v.observations.length!==3)return;
  if(![v.finalizedAnchor.number,...v.creations.flatMap(x=>[x.finalizedAnchor.number,x.escrow.receiptBlock.number]),
    ...v.observations.flatMap(o=>[o.failure.block.number,o.failure.block.timestamp,o.funding.block.number,o.order.price,o.order.bond,
      o.order.settlementDeadline,o.order.accounting.balance,o.order.accounting.locked,o.order.accounting.outstanding])].every(x=>uint.safeParse(x).success))return;
  const {executor,...creationConfig}=v.config;
  const anchors=new Map(v.creations.map(x=>[x.finalizedAnchor.number,x]));
  if(anchors.size!==v.creations.length||v.creations.some(x=>JSON.stringify(x.config)!==JSON.stringify(creationConfig)
    ||BigInt(x.finalizedAnchor.number)>BigInt(v.finalizedAnchor.number)
    ||JSON.stringify(x.gate)!==JSON.stringify(v.creations[0].gate)||JSON.stringify(x.escrow)!==JSON.stringify(v.creations[0].escrow)))bad();
  const before=(a:z.infer<typeof originalTransaction>,b:z.infer<typeof originalTransaction>)=>BigInt(a.block.number)<BigInt(b.block.number)
    ||a.block.number===b.block.number&&a.transactionIndex<b.transactionIndex;
  for(const [i,o] of v.observations.entries()){
    const order=o.order,p=BigInt(order.price),b=BigInt(order.bond),quorum=[3,5,6,7].includes(order.voteMask);
    const certified=['CERTIFIED','ALLOCATED_PAID','ALLOCATED_COMPENSATION'].includes(order.state);
    const zeroEvidence=/^0x0{64}$/i.test(order.evidenceHash);
    if(order.state==='UNREGISTERED'||quorum!==certified||order.state==='FUNDED'&&(order.voteMask!==0||!zeroEvidence)
      ||['EVIDENCE_FROZEN','CERTIFIED','ALLOCATED_PAID','ALLOCATED_COMPENSATION'].includes(order.state)&&zeroEvidence
      ||order.state==='ALLOCATED_REFUND'&&zeroEvidence&&order.voteMask!==0
      ||BigInt(order.accounting.balance)<BigInt(order.accounting.locked)+BigInt(order.accounting.outstanding))bad();
    if(order.state.startsWith('ALLOCATED_')){
      if(eq(order.buyer,order.payee)&&(order.credits.buyer!==order.credits.payee||order.withdrawn.buyer!==order.withdrawn.payee))bad();
      const amounts=order.state==='ALLOCATED_PAID'?[b,p]:order.state==='ALLOCATED_REFUND'?[p+b,0n]:[p,b];
      let credit=0n;
      for(const [actor,slot] of [[order.buyer,'buyer'],[order.payee,'payee']] as const){
        if(slot==='payee'&&eq(order.buyer,order.payee))continue;
        const expected=(eq(actor,order.buyer)?amounts[0]:0n)+(eq(actor,order.payee)?amounts[1]:0n);
        if(![order.credits[slot],order.withdrawn[slot]].every(x=>uint.safeParse(x).success))return;
        const actual=BigInt(order.credits[slot]),withdrawn=BigInt(order.withdrawn[slot]);credit+=actual;
        if(actual+withdrawn!==expected||withdrawn!==0n&&withdrawn!==expected)bad();
      }
      if(credit>BigInt(order.accounting.outstanding))bad();
    }else if([order.credits.buyer,order.credits.payee,order.withdrawn.buyer,order.withdrawn.payee].some(x=>x!=='0')||BigInt(order.accounting.locked)<p+b)bad();
    if(o.id==='SETTLEMENT'&&(order.state!=='CERTIFIED'||BigInt(o.failure.block.timestamp)>BigInt(order.settlementDeadline))
      ||o.id==='REFUND'&&(!['FUNDED','EVIDENCE_FROZEN'].includes(order.state)||BigInt(o.failure.block.timestamp)<=BigInt(order.settlementDeadline))
      ||o.id==='WITHDRAWAL'&&(!order.state.startsWith('ALLOCATED_')||![order.buyer,order.payee].some(actor=>eq(actor,o.failure.from))))bad();
    if(o.id!==day4AssetFailureIds[i]||!eq(o.order.chainId,v.config.chainId)||!eq(o.order.arbiter,v.config.pool)
      ||!eq(o.order.asset,v.config.asset)||JSON.stringify(o.order.block)!==JSON.stringify(o.failure.block)
      ||!before(o.funding,o.failure)||!eq(o.funding.from,executor)||!eq(o.funding.to,v.config.pool)
      ||!eq(o.failure.to,v.config.pool)||!eq(o.failure.from,o.id==='WITHDRAWAL'?o.trace?.beneficiary??o.failure.from:executor))bad();
    for(const tx of [o.funding,o.failure,...(o.allocation?[o.allocation]:[])]){
      const a=anchors.get(tx.block.number);
      if(!a||JSON.stringify(a.finalizedAnchor)!==JSON.stringify(tx.block)||BigInt(tx.block.number)>BigInt(v.finalizedAnchor.number)
        ||BigInt(a.escrow.receiptBlock.number)>BigInt(o.funding.block.number)
        ||a.escrow.receiptBlock.number===o.funding.block.number&&a.escrow.transactionIndex>=o.funding.transactionIndex)bad();
    }
    if(o.allocation&&(!before(o.funding,o.allocation)||!before(o.allocation,o.failure)||!eq(o.allocation.from,executor)||!eq(o.allocation.to,v.config.pool)))bad();
    if(o.status==='VERIFIED'&&o.trace){
      const t=o.trace;
      const callAbi=parseAbi(['function settle(bytes32)','function timeout(bytes32)','function withdraw(bytes32)']);
      const data=encodeFunctionData({abi:callAbi,functionName:o.id==='SETTLEMENT'?'settle':o.id==='REFUND'?'timeout':'withdraw',args:[o.order.orderId as Hex]});
      const output=(t.condition==='QUALIFICATION_FALSE'?'0x349cf84c':t.condition==='TRANSFER_AMOUNT_MISMATCH'?'0xb0a6ea29'
        :'0x5274afe7'+encodeAbiParameters(parseAbiParameters('address'),[v.config.asset as Address]).slice(2)) as Hex;
      if(o.failure.calldataHash!==keccak256(data)||t.rootOutputHash!==keccak256(output)||t.rootGas!==o.failure.gas||t.rootGasUsed!==o.failure.gasUsed
        ||t.condition==='QUALIFICATION_FALSE'&&(t.directCalls>(o.id==='SETTLEMENT'?2:1)))bad();
      if(o.id==='SETTLEMENT'&&(o.order.state!=='CERTIFIED'||BigInt(o.failure.block.timestamp)>BigInt(o.order.settlementDeadline)
        ||t.condition!=='QUALIFICATION_FALSE'||!(eq(t.beneficiary,o.order.buyer)&&BigInt(t.amount)===b||eq(t.beneficiary,o.order.payee)&&BigInt(t.amount)===p)))bad();
      if(o.id==='REFUND'&&(!['FUNDED','EVIDENCE_FROZEN'].includes(o.order.state)||BigInt(o.failure.block.timestamp)<=BigInt(o.order.settlementDeadline)
        ||t.condition!=='QUALIFICATION_FALSE'||!eq(t.beneficiary,o.order.buyer)||BigInt(t.amount)!==p+b))bad();
      if(o.id!=='WITHDRAWAL'&&([o.order.credits.buyer,o.order.credits.payee,o.order.withdrawn.buyer,o.order.withdrawn.payee].some(x=>x!=='0')
        ||BigInt(o.order.accounting.locked)<p+b))bad();
      if(o.id==='WITHDRAWAL'){
        const slot=eq(t.beneficiary,o.order.buyer)?'buyer':eq(t.beneficiary,o.order.payee)?'payee':null;
        if(!slot||!o.order.state.startsWith('ALLOCATED_')||t.amount!==o.order.credits[slot]||o.order.withdrawn[slot]!=='0')bad();
      }
      if(o.allocation){
        const data=encodeFunctionData({abi:callAbi,functionName:o.order.state==='ALLOCATED_PAID'?'settle':'timeout',args:[o.order.orderId as Hex]});
        if(o.allocation.calldataHash!==keccak256(data))bad();
      }
      if(BigInt(o.order.accounting.balance)<BigInt(o.order.accounting.locked)+BigInt(o.order.accounting.outstanding))bad();
    }
  }
  const successes=v.observations.flatMap(o=>[o.funding.hash,...(o.allocation?[o.allocation.hash]:[])]);
  const creationsHashes=v.creations.flatMap(x=>[x.gate.hash,x.escrow.hash]);
  if(v.observations.some(o=>[...successes,...creationsHashes].some(hash=>eq(hash,o.failure.hash))))bad();
  const immutable=['chainId','arbiter','asset','orderId','contextHash','buyer','seller','payee','price','bond','deliveryDeadline',
    'settlementDeadline','datasetHash','serviceTermsHash'] as const;
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++){
    const a=v.observations[i],b=v.observations[j];
    if(eq(a.funding.hash,b.funding.hash)||eq(a.order.orderId,b.order.orderId)){
      if(!eq(a.funding.hash,b.funding.hash)||JSON.stringify(a.funding)!==JSON.stringify(b.funding)
        ||immutable.some(key=>!eq(a.order[key],b.order[key])))bad();
    }
  }
  if(eq(v.observations[0].order.orderId,v.observations[1].order.orderId)
    ||new Set(v.observations.map(o=>o.failure.hash.toLowerCase())).size!==3
    ||v.status!==(v.observations.every(o=>o.status==='VERIFIED')?'COMPLETE':'BLOCKED'))bad();
});
export type Day4AssetFailureProof=z.infer<typeof Day4AssetFailureProofSchema>;
export type Day4AssetFailureObservation=z.infer<typeof Day4AssetFailureObservationSchema>;
