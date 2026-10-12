import {decodeEventLog,encodeAbiParameters,encodeEventTopics,toEventSelector,keccak256,parseAbi,type AbiEvent,type Address,type Hex} from 'viem';
import {verifyOriginalAuthorization} from '../../capsule/src/recovery.js';
import {fundingCalldata} from './funding.js';
import {allocationCalldata,allocationOrder} from './allocation.js';
import {withdrawalCalldata,withdrawalLedger,allocatedAmount} from './withdrawal.js';
import {reportDelivery} from './fulfillment.js';
import {address,digest,uint} from './schemas.js';
import {Day4ChainFlowRequestSchema,Day4ChainFlowDeploymentSchema,Day4ChainFlowProofSchema,
  type Day4ChainFlowPort,type Day4ChainFlowProof,type Day4ChainReceipt,type Day4ChainTransaction} from './day4-chain-flow-types.js';

const fundedAbi=parseAbi(['event Funded(bytes32 indexed orderId,bytes32 contextHash,address buyer,uint256 amount)']);
const allocatedAbi=parseAbi(['event Allocated(bytes32 indexed orderId,uint8 state,uint256 buyerCredit,uint256 payeeCredit)']);
const withdrawnAbi=parseAbi(['event Withdrawn(bytes32 indexed orderId,address indexed beneficiary,uint256 amount)']);
const transferAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const equal=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const fail=(code:string):never=>{throw Error('DAY4_FLOW_'+code);};

/** Independently re-read the original public transactions and historical balances.
 * This proves configured chain effects only; provider/official origin remain separate gates. */
export async function inspectDay4ChainFlow(input:unknown,deploymentInput:unknown,port:Day4ChainFlowPort):Promise<Day4ChainFlowProof>{
  let request,deployment;
  try{request=freeze(structuredClone(Day4ChainFlowRequestSchema.parse(input)));deployment=freeze(structuredClone(Day4ChainFlowDeploymentSchema.parse(deploymentInput)));}
  catch{return fail('INPUT_INVALID');}
  const p=request.payload,e=p.intent;
  if(port.blockTag!=='finalized')return fail('FINALIZED_PORT_REQUIRED');
  const reads=Object.freeze({chainId:port.chainId.bind(port),block:port.block.bind(port),transaction:port.transaction.bind(port),receipt:port.receipt.bind(port),orderAt:port.orderAt.bind(port),balance:port.balance.bind(port)});
  const {gate:_gate,...authorizationDeployment}=deployment;
  try{await verifyOriginalAuthorization(p,[e.buyer],authorizationDeployment);}catch{return fail('ORIGINAL_AUTHORIZATION_INVALID');}
  let delivery;
  try{delivery=reportDelivery(p,request.dataset,request.report);}catch{return fail('REPORT_INVALID');}
  const fixedCalls=freeze({funding:fundingCalldata(p),allocation:allocationCalldata({payload:p},'settle'),withdrawal:withdrawalCalldata({payload:p,beneficiary:e.payee})});
  const observed=new Map<bigint,{number:bigint;hash:Hex;timestamp:bigint}>();
  const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{try{return await operation();}catch{return fail('READ_UNAVAILABLE');}};
  const observe=async(number?:bigint)=>{
    const raw=await read(()=>reads.block(number));
    if(!raw||typeof raw.number!=='bigint'||!uint.safeParse(String(raw.number)).success||typeof raw.timestamp!=='bigint'
      ||!uint.safeParse(String(raw.timestamp)).success||!digest.safeParse(raw.hash).success||number!==undefined&&raw.number!==number)return fail('BLOCK_INVALID');
    const block=freeze({number:raw.number,hash:raw.hash!.toLowerCase() as Hex,timestamp:raw.timestamp});
    const previous=observed.get(block.number);
    if(previous&&(!equal(previous.hash,block.hash)||previous.timestamp!==block.timestamp))return fail('SNAPSHOT_CHANGED');
    observed.set(block.number,block);return block;
  };
  if(await read(()=>reads.chainId())!==10143)return fail('CHAIN_MISMATCH');
  const anchor=await observe();
  const mined={} as Record<'funding'|'allocation'|'withdrawal',{tx:Day4ChainTransaction;receipt:Day4ChainReceipt;block:Awaited<ReturnType<typeof observe>>}>;
  for(const step of ['funding','allocation','withdrawal'] as const){
    const hash=request.transactions[step] as Hex;
    // Clone each response at its own boundary, before another read can mutate it.
    const immutable=async<T>(operation:()=>Promise<T>)=>read(async()=>freeze(structuredClone(await operation())));
    const [tx,r]=await Promise.all([immutable(()=>reads.transaction(hash)),immutable(()=>reads.receipt(hash))]);
    if(!tx||!r)return fail('TRANSACTION_PENDING');
    const from=step==='withdrawal'?e.payee:deployment.executor;
    if(!equal(tx.hash,hash)||!equal(r.transactionHash,hash)||!equal(tx.from,from)||!equal(r.from,from)||!tx.to||!r.to
      ||!equal(tx.to,deployment.arbiter)||!equal(r.to,deployment.arbiter)||tx.chainId!==10143||tx.value!==0n||!equal(tx.input,fixedCalls[step])
      ||tx.blockNumber!==r.blockNumber||tx.blockHash===null||!equal(tx.blockHash,r.blockHash)||tx.transactionIndex!==r.transactionIndex
      ||!Number.isSafeInteger(r.transactionIndex)||r.transactionIndex<0||typeof r.blockNumber!=='bigint'||r.blockNumber<=0n||r.blockNumber>anchor.number
      ||r.status!=='success'||!Array.isArray(r.logs))return fail('TRANSACTION_MISMATCH');
    const block=await observe(r.blockNumber);if(!equal(block.hash,r.blockHash))return fail('RECEIPT_NOT_CANONICAL');
    const indexes=new Set<number>();let previousIndex=-1;
    if(r.logs.some(log=>{
      if(!log||log.removed!==false||!address.safeParse(log.address).success||typeof log.data!=='string'||!/^0x(?:[a-fA-F0-9]{2})*$/.test(log.data)
        ||!Array.isArray(log.topics)||log.topics.some(topic=>!digest.safeParse(topic).success)||log.blockNumber!==r.blockNumber||!equal(log.blockHash,r.blockHash)
        ||!equal(log.transactionHash,hash)||log.transactionIndex!==r.transactionIndex||typeof log.logIndex!=='number'||!Number.isSafeInteger(log.logIndex)||log.logIndex<0
        ||indexes.has(log.logIndex)||log.logIndex<=previousIndex)return true;
      indexes.add(log.logIndex);previousIndex=log.logIndex;return false;
    }))return fail('LOG_LOCATION_INVALID');
    mined[step]={tx,receipt:r,block};
  }
  const ordered=['funding','allocation','withdrawal'] as const;
  for(let index=1;index<ordered.length;index++){
    const previous=mined[ordered[index-1]],next=mined[ordered[index]];
    if(next.block.number<previous.block.number||next.block.number===previous.block.number&&next.receipt.transactionIndex<=previous.receipt.transactionIndex)return fail('TRANSACTION_ORDER_INVALID');
  }
  if(mined.funding.block.timestamp>BigInt(p.grant.deadline)||mined.funding.block.timestamp>BigInt(p.receipt.expiresAt)
    ||mined.funding.block.timestamp>BigInt(p.quote.expiresAt)||mined.funding.block.timestamp>=BigInt(e.deliveryDeadline)
    ||mined.allocation.block.timestamp>BigInt(e.settlementDeadline))return fail('TRANSACTION_TIME_INVALID');
  // Strictly decode the one expected event, rather than accept a recorded receipt summary.
  const decode=<T>(receipt:Day4ChainReceipt,target:string,abi:readonly unknown[]):T[]=>receipt.logs.flatMap(log=>{
    const event=abi[0] as AbiEvent;
    if(!equal(log.address,target)||!equal(log.topics[0],toEventSelector(event)))return [];
    try{
      const args=decodeEventLog({abi:abi as never,data:log.data,topics:log.topics,strict:true}).args as unknown as Record<string,unknown>;
      const topics=encodeEventTopics({abi:[event],eventName:event.name,args:args as never});
      const parameters=event.inputs.filter(input=>!input.indexed),data=encodeAbiParameters(parameters,parameters.map(input=>args[input.name!]));
      if(!equal(data,log.data)||topics.length!==log.topics.length||topics.some((topic,index)=>!equal(topic,log.topics[index])))return fail('EVENT_ENCODING_INVALID');
      return [args as T];
    }catch{return fail('EVENT_ENCODING_INVALID');}
  });
  const funded=decode<{orderId:Hex;contextHash:Hex;buyer:Address;amount:bigint}>(mined.funding.receipt,e.arbiter,fundedAbi);
  const fundingTransfers=decode<{from:Address;to:Address;value:bigint}>(mined.funding.receipt,e.asset,transferAbi);
  if(funded.length!==1||!equal(funded[0].orderId,e.orderId)||!equal(funded[0].contextHash,p.grant.contextHash)
    ||!equal(funded[0].buyer,e.buyer)||funded[0].amount!==BigInt(p.grant.amount)||fundingTransfers.length!==1
    ||!equal(fundingTransfers[0].from,e.buyer)||!equal(fundingTransfers[0].to,e.arbiter)||fundingTransfers[0].value!==BigInt(p.grant.amount))return fail('FUNDING_EFFECT_UNPROVEN');
  const allocated=decode<{orderId:Hex;state:number;buyerCredit:bigint;payeeCredit:bigint}>(mined.allocation.receipt,e.arbiter,allocatedAbi);
  if(allocated.length!==1||!equal(allocated[0].orderId,e.orderId)||allocated[0].state!==4||allocated[0].buyerCredit!==BigInt(e.bond)
    ||allocated[0].payeeCredit!==BigInt(e.price)||decode(mined.allocation.receipt,e.asset,transferAbi).length!==0)return fail('ALLOCATION_EFFECT_UNPROVEN');
  let final;
  try{final=freeze(allocationOrder({payload:p},await read(async()=>freeze(structuredClone(await reads.orderAt(e.orderId as Hex,anchor.number))))));}
  catch(error){if(error instanceof Error&&error.message==='DAY4_FLOW_READ_UNAVAILABLE')throw error;return fail('FINAL_ORDER_MISMATCH');}
  if(final.block.number!==String(anchor.number)||!equal(final.block.hash,anchor.hash)||final.block.timestamp!==String(anchor.timestamp)
    ||final.state!=='ALLOCATED_PAID'||!equal(final.evidenceHash,delivery.evidenceHash))return fail('FINAL_ORDER_MISMATCH');
  let ledger;const amount=allocatedAmount(final,e.payee);
  try{ledger=withdrawalLedger({payload:p,beneficiary:e.payee},final);}catch{return fail('WITHDRAWAL_LEDGER_UNPROVEN');}
  if(amount<=0n||ledger.amount!=='0'||ledger.withdrawn!==String(amount))return fail('WITHDRAWAL_LEDGER_UNPROVEN');
  const withdrawn=decode<{orderId:Hex;beneficiary:Address;amount:bigint}>(mined.withdrawal.receipt,e.arbiter,withdrawnAbi);
  const withdrawalTransfers=decode<{from:Address;to:Address;value:bigint}>(mined.withdrawal.receipt,e.asset,transferAbi);
  if(withdrawn.length!==1||!equal(withdrawn[0].orderId,e.orderId)||!equal(withdrawn[0].beneficiary,e.payee)||withdrawn[0].amount!==amount
    ||withdrawalTransfers.length!==1||!equal(withdrawalTransfers[0].from,e.arbiter)||!equal(withdrawalTransfers[0].to,e.payee)||withdrawalTransfers[0].value!==amount)return fail('WITHDRAWAL_EFFECT_UNPROVEN');
  const serialize=(block:Awaited<ReturnType<typeof observe>>)=>({number:String(block.number),hash:block.hash,timestamp:String(block.timestamp)});
  const balanceObservation=async(step:'funding'|'withdrawal')=>{
    const after=mined[step].block,before=await observe(after.number-1n),actors={buyer:e.buyer,payee:e.payee,escrow:e.arbiter};
    const balances=async(number:bigint)=>{
      const distinct=new Map<string,Promise<bigint>>();
      const entries=await Promise.all(Object.entries(actors).map(async([role,owner])=>{
        const key=owner.toLowerCase();if(!distinct.has(key))distinct.set(key,read(()=>reads.balance(e.asset as Address,owner as Address,number)));
        const value=await distinct.get(key)!;
        if(typeof value!=='bigint'||!uint.safeParse(String(value)).success)return fail('BALANCE_INVALID');return [role,String(value)] as const;
      }));return Object.fromEntries(entries) as {buyer:string;payee:string;escrow:string};
    };
    const [beforeBalances,afterBalances]=await Promise.all([balances(before.number),balances(after.number)]);
    const wholeBlockNetChange=Object.fromEntries((['buyer','payee','escrow'] as const).map(role=>[role,String(BigInt(afterBalances[role])-BigInt(beforeBalances[role]))])) as {buyer:string;payee:string;escrow:string};
    return {scope:'WHOLE_BLOCK_ENDPOINT_BALANCES_NOT_TRANSACTION_LEVEL_DELTAS' as const,before:serialize(before),after:serialize(after),beforeBalances,afterBalances,wholeBlockNetChange};
  };
  const observations={funding:await balanceObservation('funding'),withdrawal:await balanceObservation('withdrawal')};
  // Re-read each original height; a naturally advancing finalized tip is harmless.
  for(const [number,expected] of observed){const actual=await read(()=>reads.block(number));if(!actual||actual.number!==number||!equal(actual.hash,expected.hash)||actual.timestamp!==expected.timestamp)return fail('SNAPSHOT_CHANGED');}
  if(port.blockTag!=='finalized'||await read(()=>reads.chainId())!==10143)return fail('SNAPSHOT_CHANGED');
  const transactionProof=(step:typeof ordered[number],amount:string)=>({hash:request.transactions[step],from:mined[step].tx.from,to:mined[step].tx.to!,
    calldataHash:keccak256(fixedCalls[step]),block:serialize(mined[step].block),transactionIndex:mined[step].receipt.transactionIndex,status:'success' as const,amount});
  return freeze(Day4ChainFlowProofSchema.parse({schemaVersion:1,scope:'FINALIZED_CONFIGURED_ORIGINAL_PAID_CHAIN_FLOW_NOT_OFFICIAL_OR_PROVIDER_PROVENANCE',status:'CHAIN_FLOW_VERIFIED',
    chainId:'10143',arbiter:e.arbiter,asset:e.asset,orderId:e.orderId,contextHash:p.grant.contextHash,deliveryEvidenceHash:delivery.evidenceHash,finalizedAnchor:serialize(anchor),
    transactions:{funding:transactionProof('funding',p.grant.amount),allocation:transactionProof('allocation',e.price),withdrawal:transactionProof('withdrawal',String(amount))},
    balanceObservations:observations,finalOrder:final,originalAuthorizationVerified:true,reportRecomputed:true,canExecute:false,signaturesRequested:0,transactionsSent:0,
    officialIntegrationVerified:false,privyOriginVerified:false,deploymentCreationVerified:false,financialAcceptanceStatus:'BLOCKED',
    limits:['Configured chain effects, original signatures and recomputed delivery only; no independent official deployment, Privy origin or real JEV attestation.',
      'Historical balances are whole-block endpoints and net changes; precise target-transaction transfers are proved separately by its original receipt events.',
      'No current eligibility check is substituted for the historical successful transaction. No trace-level balance delta or failed-transfer cause is claimed.',
      'This proof alone cannot make D4-01 or any other external acceptance PASS. No signature, send, retry or new permission is available.']}));
}
