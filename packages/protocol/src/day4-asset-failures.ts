import {encodeFunctionData,encodeAbiParameters,encodeEventTopics,parseAbi,parseAbiParameters,keccak256,stringToHex,type Address,type Hex} from 'viem';
import {z} from 'zod';
import {digest,address,uint} from './schemas.js';
import {Day4AssetFailureConfigSchema,Day4AssetFailureRequestSchema,Day4AssetFailureProofSchema,day4AssetFailureIds,
  type Day4AssetFailurePort,type Day4AssetFailureProof,type Day4AssetFailureObservation,type Day4FailureTraceNode,
  type Day4FailureTransaction,type Day4FailureReceipt,type Day4AssetFailureConfig,type Day4AssetFailureRequest} from './day4-asset-failure-types.js';
import {inspectDay4CreationPair} from './day4-creation-pair.js';
import {Day4ChainBlockSchema} from './day4-chain-flow-types.js';
import type {Day4CreationPairProof} from './day4-origin-types.js';
import {verifyOriginalAuthorization} from '../../capsule/src/recovery.js';
import {fundingCalldata} from './funding.js';
import {allocationCalldata,allocationOrder} from './allocation.js';
import {withdrawalCalldata,withdrawalLedger,allocatedAmount} from './withdrawal.js';
import {reportDelivery} from './fulfillment.js';
import {OrderSnapshotSchema} from './escrow-read.js';
import {ZERO_HASH} from './escrow.js';

const eq=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const fail=(code:string):never=>{throw Error('DAY4_ASSET_FAILURE_'+code);};
const abi=parseAbi(['function canTransfer(address,address,address,uint256,bytes32) view returns(bool)',
  'function policy() view returns(address)','function isRegistered(address) view returns(bool)',
  'function complianceVerify(address,address) view returns(bool)','function canTransfer(address,address,address,uint256) view returns(bool)',
  'function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)',
  'event Funded(bytes32 indexed orderId,bytes32 contextHash,address buyer,uint256 amount)',
  'event Allocated(bytes32 indexed orderId,uint8 state,uint256 buyerCredit,uint256 payeeCredit)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const word=(n:bigint)=>encodeAbiParameters(parseAbiParameters('uint256'),[n]);
const falseWord=word(0n),trueWord=word(1n),identityError='0x349cf84c',amountError='0xb0a6ea29';
const boundedBytes=(v:unknown,max=65536):v is Hex=>typeof v==='string'&&/^0x(?:[a-fA-F0-9]{2})*$/.test(v)&&v.length<=2+max*2;
const bigUint=(v:unknown):v is bigint=>typeof v==='bigint'&&uint.safeParse(String(v)).success;
const freeze=<T>(v:T):T=>{if(v!==null&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
const validIndex=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function block(raw:unknown){
  const b=raw as {number?:unknown;hash?:unknown;timestamp?:unknown}|null;
  if(!b||!bigUint(b.number)||!bigUint(b.timestamp)||!digest.safeParse(b.hash).success)return fail('BLOCK_INVALID');
  return Day4ChainBlockSchema.parse({number:String(b.number),hash:b.hash,timestamp:String(b.timestamp)});
}
const before=(a:{block:{number:string};transactionIndex:number},b:{block:{number:string};transactionIndex:number})=>
  BigInt(a.block.number)<BigInt(b.block.number)||a.block.number===b.block.number&&a.transactionIndex<b.transactionIndex;

/** Independently validate the normalized port tree before copying or recursively
 * hashing it. Raw transport limits are separately enforced by the live adapter. */
function traceTree(raw:unknown):Day4FailureTraceNode|null{
  const seen=new Set<object>(),pending=[{raw,depth:0}];let total=0;
  while(pending.length){
    const item=pending.pop()!,v=item.raw as Day4FailureTraceNode|null;
    if(!v||typeof v!=='object'||seen.has(v)||item.depth>63||seen.size>=1024)return null;
    seen.add(v);
    if(!['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'].includes(v.type)
      ||!address.safeParse(v.from).success||v.to!==null&&!address.safeParse(v.to).success||!bigUint(v.value)
      ||!bigUint(v.gas)||v.gas>2n**64n-1n||!bigUint(v.gasUsed)||v.gasUsed>2n**64n-1n
      ||!boundedBytes(v.input)||!boundedBytes(v.output)||typeof v.failed!=='boolean'||!Array.isArray(v.calls))return null;
    total+=(v.input.length+v.output.length-4)/2;if(total>262144||v.calls.length>1024)return null;
    for(const child of v.calls)pending.push({raw:child,depth:item.depth+1});
  }
  try{return freeze(structuredClone(raw)) as Day4FailureTraceNode;}catch{return null;}
}
function frame(node:Day4FailureTraceNode,type:'CALL'|'STATICCALL',from:string,to:string,data:Hex){
  return node.type===type&&eq(node.from,from)&&eq(node.to,to)&&node.value===0n&&eq(node.input,data);
}
function numeric(node:Day4FailureTraceNode|undefined,config:Day4AssetFailureConfig,owner:string):bigint|null{
  if(!node||!frame(node,'STATICCALL',config.pool,config.asset,encodeFunctionData({abi,functionName:'balanceOf',args:[owner as Address]}))
    ||node.failed||!/^0x[a-fA-F0-9]{64}$/.test(node.output))return null;
  return BigInt(node.output);
}
function gate(node:Day4FailureTraceNode|undefined,c:Day4AssetFailureConfig,beneficiary:string,amount:bigint,context:string){
  if(!node||!frame(node,'STATICCALL',c.pool,c.gate,encodeFunctionData({abi,functionName:'canTransfer',args:[c.asset as Address,c.pool as Address,
    beneficiary as Address,amount,context as Hex]}))||node.failed||![falseWord,trueWord].some(x=>eq(x,node.output)))return null;
  const queries=[{to:c.asset,data:encodeFunctionData({abi,functionName:'policy'}),expected:encodeAbiParameters(parseAbiParameters('address'),[c.policy as Address]),id:null},
    {to:c.validator,data:encodeFunctionData({abi,functionName:'isRegistered',args:[c.pool as Address]}),expected:trueWord,id:'POOL_REGISTERED' as const},
    {to:c.validator,data:encodeFunctionData({abi,functionName:'complianceVerify',args:[c.pool as Address,c.pool as Address]}),expected:trueWord,id:'FROM_COMPLIANT' as const},
    {to:c.validator,data:encodeFunctionData({abi,functionName:'complianceVerify',args:[c.pool as Address,beneficiary as Address]}),expected:trueWord,id:'TO_COMPLIANT' as const},
    {to:c.policy,data:encodeFunctionData({abi,functionName:'canTransfer',args:[c.asset as Address,c.pool as Address,beneficiary as Address,amount]}),expected:trueWord,id:'POLICY_CAN_TRANSFER' as const}];
  for(const [i,q] of queries.entries()){
    const leaf=node.calls[i];if(!leaf||!frame(leaf,'STATICCALL',c.gate,q.to,q.data)||leaf.failed)return null;
    // Proxy/internal children are allowed; only the precise gate-owned outer query
    // and its actual returned ABI word are evidence for this short-circuit path.
    if(eq(leaf.output,q.expected))continue;
    if(q.id!==null&&eq(leaf.output,falseWord)&&node.calls.length===i+1&&eq(node.output,falseWord))return {allowed:false as const,rejectAt:q.id};
    return null;
  }
  return node.calls.length===5&&eq(node.output,trueWord)?{allowed:true as const,rejectAt:null}:null;
}
function fingerprint(root:Day4FailureTraceNode){return keccak256(stringToHex(JSON.stringify(root,(_,v)=>typeof v==='bigint'?String(v):v)));}
function classify(root:Day4FailureTraceNode,c:Day4AssetFailureConfig,id:typeof day4AssetFailureIds[number],order:z.infer<typeof OrderSnapshotSchema>,beneficiary?:string){
  const base={fingerprint:fingerprint(root),rootOutputHash:keccak256(root.output),rootGas:String(root.gas),rootGasUsed:String(root.gasUsed),directCalls:root.calls.length};
  const gates=id==='REFUND'?[[order.buyer,BigInt(order.price)+BigInt(order.bond)]] as const
    :id==='SETTLEMENT'?[[order.buyer,BigInt(order.bond)],[order.payee,BigInt(order.price)]] as const
    :[[beneficiary!,BigInt(order.credits[eq(beneficiary,order.buyer)?'buyer':'payee'])]] as const;
  let at=0;
  for(const [actor,amount] of gates){
    if(amount===0n)continue;
    const g=gate(root.calls[at++],c,actor,amount,order.contextHash);if(!g)return null;
    if(!g.allowed){
      if(root.calls.length!==at||!eq(root.output,identityError))return null;
      return {...base,condition:'QUALIFICATION_FALSE' as const,beneficiary:actor,amount:String(amount),qualificationRejectAt:g.rejectAt,creditWritesReached:false,balances:null};
    }
  }
  if(id!=='WITHDRAWAL')return null;
  const actor=beneficiary!,amount=BigInt(order.credits[eq(actor,order.buyer)?'buyer':'payee']);
  const poolBefore=numeric(root.calls[at++],c,c.pool),beneficiaryBefore=numeric(root.calls[at++],c,actor);
  const transfer=root.calls[at++];
  if(poolBefore===null||beneficiaryBefore===null||!transfer||!frame(transfer,'CALL',c.pool,c.asset,
    encodeFunctionData({abi,functionName:'transfer',args:[actor as Address,amount]}))||transfer.failed)return null;
  const balances={poolBefore:String(poolBefore),beneficiaryBefore:String(beneficiaryBefore),poolAfter:null as string|null,beneficiaryAfter:null as string|null};
  const extra={...base,beneficiary:actor,amount:String(amount),qualificationRejectAt:null,creditWritesReached:true,balances};
  const transferError=('0x5274afe7'+encodeAbiParameters(parseAbiParameters('address'),[c.asset as Address]).slice(2)) as Hex;
  if(eq(transfer.output,falseWord))return root.calls.length===at&&eq(root.output,transferError)?{...extra,condition:'TRANSFER_FALSE' as const}:null;
  if(!eq(transfer.output,trueWord)||!eq(root.output,amountError))return null;
  // Strictly accept a canonical true return; an empty return needs a code-existence
  // observation inside SafeERC20 that a callTracer alone cannot supply.
  const poolAfter=numeric(root.calls[at++],c,c.pool);if(poolAfter===null||poolAfter>poolBefore)return null;
  balances.poolAfter=String(poolAfter);
  if(poolBefore-poolAfter===amount){
    const recipientAfter=numeric(root.calls[at++],c,actor);if(recipientAfter===null||recipientAfter<beneficiaryBefore||recipientAfter-beneficiaryBefore===amount)return null;
    balances.beneficiaryAfter=String(recipientAfter);
  }
  return root.calls.length===at?{...extra,condition:'TRANSFER_AMOUNT_MISMATCH' as const}:null;
}

/** Original finalized failed transactions only: no simulation, signing, sending,
 * new reservation or inferred H-1→H transaction balance delta. */
export async function inspectDay4AssetFailures(requestInput:unknown,configInput:unknown,artifacts:{gate:unknown;escrow:unknown},port:Day4AssetFailurePort):Promise<Day4AssetFailureProof>{
  let request:Day4AssetFailureRequest,config:Day4AssetFailureConfig,saved:{gate:unknown;escrow:unknown};
  try{request=freeze(Day4AssetFailureRequestSchema.parse(structuredClone(requestInput)));config=freeze(Day4AssetFailureConfigSchema.parse(structuredClone(configInput)));
    saved=freeze(structuredClone(artifacts));}catch{return fail('INPUT_INVALID');}
  if(port.blockTag!=='finalized')return fail('FINALIZED_REQUIRED');
  const p=Object.freeze({blockTag:'finalized' as const,chainId:port.chainId.bind(port),block:port.block.bind(port),transaction:port.transaction.bind(port),
    receipt:port.receipt.bind(port),code:port.code.bind(port),gateConfiguration:port.gateConfiguration.bind(port),escrowConfiguration:port.escrowConfiguration.bind(port),
    orderAt:port.orderAt.bind(port),traceTransaction:port.traceTransaction.bind(port)});
  const read=async<T>(call:()=>Promise<T>):Promise<T>=>{try{return freeze(structuredClone(await call()));}catch{return fail('READ_UNAVAILABLE');}};
  const deployment={chainId:config.chainId,arbiter:config.pool,asset:config.asset,reviewer:config.reviewer,committee:config.committee,executor:config.executor};
  for(const item of [request.settlement,request.refund,request.withdrawal]){
    try{await verifyOriginalAuthorization(item.payload,[item.payload.intent.buyer],deployment);reportDelivery(item.payload,item.dataset,item.report);}catch{return fail('AUTHORIZATION_INVALID');}
  }
  if(await read(()=>p.chainId())!==10143)return fail('CHAIN_MISMATCH');
  const anchor=block(await read(()=>p.block())),observed=new Map([[anchor.number,anchor]]),creations=new Map<string,Day4CreationPairProof>();
  const observe=async(number:bigint)=>{
    if(!bigUint(number)||number>BigInt(anchor.number))return fail('BLOCK_NOT_FINALIZED');
    const b=block(await read(()=>p.block(number))),previous=observed.get(String(number));
    if(b.number!==String(number))return fail('BLOCK_INVALID');
    if(previous&&JSON.stringify(previous)!==JSON.stringify(b))return fail('SNAPSHOT_CHANGED');
    observed.set(b.number,b);return b;
  };
  const sourceAt=async(b:ReturnType<typeof block>)=>{
    if(creations.has(b.number))return;
    const {executor,...creationConfig}=config;
    const proof=await inspectDay4CreationPair(request.creations,creationConfig,saved,{...p,
      block:async(n?:bigint)=>n===undefined?{number:BigInt(b.number),hash:b.hash as Hex,timestamp:BigInt(b.timestamp)}:p.block(n)});
    creations.set(b.number,proof);
    for(const original of [proof.gate,proof.escrow])if(JSON.stringify(await observe(BigInt(original.receiptBlock.number)))!==JSON.stringify(original.receiptBlock))return fail('SNAPSHOT_CHANGED');
  };
  const records=new Map<string,{tx:Day4FailureTransaction;receipt:Day4FailureReceipt;public:z.infer<typeof Day4AssetFailureObservationSchemaShim>}>();
  // Keep selected metadata and exact original receipt logs; never raw RPC errors.
  async function transaction(hash:Hex,from:string,data:Hex,status:'success'|'reverted'){
    const previous=records.get(hash.toLowerCase());
    if(previous){if(!eq(previous.tx.from,from)||!eq(previous.tx.input,data)||previous.receipt.status!==status)return fail('TRANSACTION_BINDING_INVALID');return previous;}
    const [rawTx,rawReceipt]=await Promise.all([read(()=>p.transaction(hash)),read(()=>p.receipt(hash))]);
    if(!rawTx||!rawReceipt)return fail('PENDING');
    let tx:Day4FailureTransaction,receipt:Day4FailureReceipt;
    try{tx=freeze(structuredClone({hash:rawTx.hash,from:rawTx.from,to:rawTx.to,input:rawTx.input,value:rawTx.value,nonce:rawTx.nonce,gas:rawTx.gas,
      blockNumber:rawTx.blockNumber,blockHash:rawTx.blockHash,transactionIndex:rawTx.transactionIndex,chainId:rawTx.chainId}));
      if(!Array.isArray(rawReceipt.logs)||rawReceipt.logs.length>1024)return fail('RECEIPT_INVALID');
      receipt=freeze(structuredClone({transactionHash:rawReceipt.transactionHash,from:rawReceipt.from,to:rawReceipt.to,status:rawReceipt.status,
        contractAddress:rawReceipt.contractAddress,blockNumber:rawReceipt.blockNumber,blockHash:rawReceipt.blockHash,
        transactionIndex:rawReceipt.transactionIndex,gasUsed:rawReceipt.gasUsed,logs:rawReceipt.logs}));
    }catch{return fail('RECEIPT_INVALID');}
    if(!eq(tx.hash,hash)||!eq(tx.from,from)||!eq(tx.to,config.pool)||tx.chainId!==10143||tx.value!==0n||!eq(tx.input,data)
      ||!bigUint(tx.gas)||tx.gas===0n||tx.gas>2n**64n-1n||!validIndex(tx.nonce)||!bigUint(tx.blockNumber)
      ||!digest.safeParse(tx.blockHash).success||!validIndex(tx.transactionIndex))return fail('TRANSACTION_INVALID');
    if(!eq(receipt.transactionHash,hash)||!eq(receipt.from,from)||!eq(receipt.to,config.pool)||receipt.contractAddress!==null||receipt.status!==status
      ||receipt.blockNumber!==tx.blockNumber||!eq(receipt.blockHash,tx.blockHash)||receipt.transactionIndex!==tx.transactionIndex
      ||!bigUint(receipt.gasUsed)||receipt.gasUsed>tx.gas||!Array.isArray(receipt.logs)||receipt.logs.length>1024
      ||status==='reverted'&&receipt.logs.length!==0)return fail('RECEIPT_INVALID');
    const b=await observe(tx.blockNumber);if(!eq(b.hash,tx.blockHash))return fail('RECEIPT_INVALID');
    await sourceAt(b);
    const proof=creations.get(b.number)!;
    if(BigInt(proof.escrow.receiptBlock.number)>tx.blockNumber||proof.escrow.receiptBlock.number===b.number&&proof.escrow.transactionIndex>=tx.transactionIndex)return fail('CREATION_ORDER_INVALID');
    const result={tx:freeze(structuredClone(tx)),receipt:freeze(structuredClone(receipt)),public:{hash:hash.toLowerCase(),from:tx.from,to:config.pool,calldataHash:keccak256(data),
      gas:String(tx.gas),gasUsed:String(receipt.gasUsed),nonce:tx.nonce,block:b,transactionIndex:tx.transactionIndex}};
    records.set(hash.toLowerCase(),result);return result;
  }
  const event=(r:Day4FailureReceipt,target:string,topics:readonly Hex[],data:Hex)=>{
    let found=0;const indices=new Set<number>();
    for(const l of r.logs){
      if(!address.safeParse(l.address).success||!Array.isArray(l.topics)||l.topics.length>4||l.topics.some(x=>!digest.safeParse(x).success)
        ||!boundedBytes(l.data)||l.removed!==false||!eq(l.transactionHash,r.transactionHash)||!eq(l.blockHash,r.blockHash)
        ||l.blockNumber!==r.blockNumber||l.transactionIndex!==r.transactionIndex||!validIndex(l.logIndex)||indices.has(l.logIndex))return fail('EVENT_INVALID');
      indices.add(l.logIndex);
      if(eq(l.address,target)&&eq(l.topics[0],topics[0])){
        if(l.topics.length!==topics.length||l.topics.some((x,i)=>!eq(x,topics[i]))||!eq(l.data,data))return fail('EVENT_INVALID');found++;
      }
    }
    if(found!==1)return fail('EVENT_INVALID');
  };
  const observations:Day4AssetFailureObservation[]=[];
  for(const [index,item] of [request.settlement,request.refund,request.withdrawal].entries()){
    const id=day4AssetFailureIds[index],e=item.payload.intent;
    const fund=await transaction(item.fundingTransaction as Hex,config.executor,fundingCalldata(item.payload),'success');
    const amount=BigInt(e.price)+BigInt(e.bond);
    event(fund.receipt,config.pool,encodeEventTopics({abi,eventName:'Funded',args:{orderId:e.orderId as Hex}}) as Hex[],
      encodeAbiParameters(parseAbiParameters('bytes32,address,uint256'),[item.payload.grant.contextHash as Hex,e.buyer as Address,amount]));
    event(fund.receipt,config.asset,encodeEventTopics({abi,eventName:'Transfer',args:{from:e.buyer as Address,to:config.pool as Address}}) as Hex[],word(amount));
    const w=request.withdrawal,actor=id==='WITHDRAWAL'?w.beneficiary:config.executor;
    const data=id==='WITHDRAWAL'?withdrawalCalldata({payload:item.payload,beneficiary:actor}):allocationCalldata({payload:item.payload},id==='SETTLEMENT'?'settle':'timeout');
    const failed=await transaction(item.failedTransaction as Hex,actor,data,'reverted');
    if(!before(fund.public,failed.public))return fail('TRANSACTION_ORDER_INVALID');
    let o;
    try{o=allocationOrder({payload:item.payload},await read(()=>p.orderAt(e.orderId as Hex,BigInt(failed.public.block.number))));}catch(error){
      if(error instanceof Error&&error.message==='DAY4_ASSET_FAILURE_READ_UNAVAILABLE')throw error;return fail('LEDGER_INVALID');}
    if(JSON.stringify(o.block)!==JSON.stringify(failed.public.block))return fail('LEDGER_BLOCK_INVALID');
    const expectedEvidence=reportDelivery(item.payload,item.dataset,item.report).evidenceHash;
    if(o.state==='ALLOCATED_REFUND'){
      // A FUNDED timeout refund has no delivery; frozen-evidence refunds retain
      // the original delivery. Neither path requires a new delivery to withdraw.
      if(eq(o.evidenceHash,ZERO_HASH)?o.voteMask!==0:!eq(o.evidenceHash,expectedEvidence))return fail('EVIDENCE_INVALID');
    }else if(o.state!=='FUNDED'&&!eq(o.evidenceHash,expectedEvidence))return fail('EVIDENCE_INVALID');
    let allocation:typeof failed|null=null;
    if(id==='WITHDRAWAL'){
      if(!o.state.startsWith('ALLOCATED_'))return fail('BUSINESS_CASE_INVALID');
      const ledger=withdrawalLedger({payload:item.payload,beneficiary:actor},o);
      if(BigInt(ledger.amount)===0n||BigInt(ledger.amount)!==allocatedAmount(o,actor)||ledger.withdrawn!=='0')return fail('CREDIT_NOT_PRESERVED');
      allocation=await transaction(w.allocationTransaction as Hex,config.executor,allocationCalldata({payload:item.payload},w.allocationAction),'success');
      if(!before(fund.public,allocation.public)||!before(allocation.public,failed.public)
        ||(w.allocationAction==='settle')!==(o.state==='ALLOCATED_PAID'))return fail('ALLOCATION_ORDER_INVALID');
      const [state,buyerCredit,payeeCredit]=o.state==='ALLOCATED_PAID'?[4,BigInt(e.bond),BigInt(e.price)]
        :o.state==='ALLOCATED_REFUND'?[5,amount,0n]:[6,BigInt(e.price),BigInt(e.bond)];
      event(allocation.receipt,config.pool,encodeEventTopics({abi,eventName:'Allocated',args:{orderId:e.orderId as Hex}}) as Hex[],
        encodeAbiParameters(parseAbiParameters('uint8,uint256,uint256'),[state,buyerCredit,payeeCredit]));
    }else if(id==='SETTLEMENT'?(o.state!=='CERTIFIED'||BigInt(o.block.timestamp)>BigInt(o.settlementDeadline))
      :!['FUNDED','EVIDENCE_FROZEN'].includes(o.state)||BigInt(o.block.timestamp)<=BigInt(o.settlementDeadline))return fail('BUSINESS_CASE_INVALID');
    // Trace frames need their own iterative limit/cycle check before recursive
    // freeze. Consume and capture them synchronously before another await.
    let result;try{result=await p.traceTransaction(item.failedTransaction as Hex);}catch{return fail('READ_UNAVAILABLE');}
    let reason:Day4AssetFailureObservation['reason']='TRACE_UNAVAILABLE',matched:Day4AssetFailureObservation['trace']=null;
    if(result?.status==='AVAILABLE'){
      const t=traceTree(result.trace);
      if(!t)reason='TRACE_INVALID';
      else if(!frame(t,'CALL',actor,config.pool,data)||!t.failed||t.gas!==failed.tx.gas||t.gasUsed!==failed.receipt.gasUsed)reason='FAILURE_CAUSE_UNCLASSIFIED';
      else{matched=classify(t,config,id,o,id==='WITHDRAWAL'?actor:undefined);reason=matched?'EXACT_ORIGINAL_FAILURE_PATH':'FAILURE_CAUSE_UNCLASSIFIED';}
    }else if(result?.status==='UNAVAILABLE')reason=result.reason==='TRACE_INVALID'?'TRACE_INVALID':result.reason==='TRACE_LIMIT_EXCEEDED'?'TRACE_LIMIT_EXCEEDED':'TRACE_UNAVAILABLE';
    observations.push({id,status:matched?'VERIFIED':'BLOCKED',reason,funding:fund.public,failure:failed.public,allocation:allocation?.public??null,order:o,trace:matched,
      transactionEffectsUncommitted:true,ledgerScope:'FAILURE_HEIGHT_BLOCK_END_NOT_TRANSACTION_PRESTATE_OR_BALANCE_DELTA'});
  }
  for(const original of observed.values())if(JSON.stringify(await observe(BigInt(original.number)))!==JSON.stringify(original))return fail('SNAPSHOT_CHANGED');
  const tip=block(await read(()=>p.block()));if(BigInt(tip.number)<BigInt(anchor.number)||tip.number===anchor.number&&JSON.stringify(tip)!==JSON.stringify(anchor)
    ||port.blockTag!=='finalized'||await read(()=>p.chainId())!==10143)return fail('SNAPSHOT_CHANGED');
  try{return freeze(Day4AssetFailureProofSchema.parse({schemaVersion:1,
    scope:'FINALIZED_ORIGINAL_FAILURE_TRACES_AND_BLOCK_END_LEDGER_NOT_OFFICIAL_ASSET_PROVENANCE_OR_FULL_D4',status:observations.every(o=>o.status==='VERIFIED')?'COMPLETE':'BLOCKED',
    config,finalizedAnchor:anchor,creations:[...creations.values()],observations,officialIntegrationVerified:false,financialAcceptanceStatus:'BLOCKED',canExecute:false,
    signaturesRequested:0,transactionsSent:0,limits:['Original failed transaction effects are uncommitted; native gas and nonce are not zero-change claims.',
      'H ledger is block-end state; no transaction prestate, storage-write trace or H-1 to H balance-delta attribution.',
      'Geth-compatible root gas/receipt equality is a strict consumer requirement; actual Monad trace-provider support remains unverified.',
      'Only canonical qualification false, transfer false, and traced amount mismatch are classified; unknown token reverts and empty returns remain blocked.',
      'Configured historical CREATE/runtime and current RPC observations do not establish official CVA/CVI provenance or full D4 acceptance.']}));}catch{return fail('PROOF_INVALID');}
}

// Metadata shape is kept identical to the public observation schema without
// importing private payloads into public evidence.
const Day4AssetFailureObservationSchemaShim=z.object({hash:digest,from:address,to:address,calldataHash:digest,gas:uint,gasUsed:uint,
  nonce:z.number(),block:Day4ChainBlockSchema,transactionIndex:z.number()});
