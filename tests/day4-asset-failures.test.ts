import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters,encodeEventTopics,parseAbi,parseAbiParameters,type Address,type Hex} from 'viem';
import {day4AssetFailureFixture,failureWord} from './support/day4-asset-failure-fixture.js';
import {readTestHash as h,readTestAddress as a} from './support/original-authorization.js';
import {Day4AssetFailureProofSchema} from '../packages/protocol/src/day4-asset-failure-types.js';
import {allocationCalldata} from '../packages/protocol/src/allocation.js';
import {withdrawalCalldata} from '../packages/protocol/src/withdrawal.js';

test('local doubles: original failures require distinct orders, historical CREATE runtimes, exact traces and preserved H credit',async()=>{
  const f=await day4AssetFailureFixture(),p=await f.run();assert.equal(p.status,'COMPLETE');assert.equal(f.counts.trace,3);
  assert.equal(p.creations.length,6);assert.deepEqual(p.observations.map(o=>o.trace?.condition),['QUALIFICATION_FALSE','QUALIFICATION_FALSE','TRANSFER_FALSE']);
  assert.equal(p.financialAcceptanceStatus,'BLOCKED');assert.equal(p.officialIntegrationVerified,false);assert.equal(p.transactionsSent,0);
  assert.equal(p.observations[2].order.credits.payee,'10');assert.equal(p.observations[2].trace?.creditWritesReached,true);
  assert.equal(p.observations[0].trace?.creditWritesReached,false);
  assert.ok(Object.isFrozen(p));assert.ok(!JSON.stringify(p).includes('LOCAL PRIVATE'));assert.equal(Day4AssetFailureProofSchema.safeParse(p).success,true);
});

for(const [label,mutate] of [
  ['top business-state revert',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.output='0xbaf3f0f7';f.traces.get(h(301))!.calls=[];}],
  ['same selector with query OOG',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.calls[0].calls[3].failed=true;}],
  ['noncanonical query bool',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.calls[0].calls[3].output=failureWord(2n);} ],
  ['missing query returns',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.calls[0].calls[3].output='0x';}],
  ['wrong policy address',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.calls[0].calls[0].output=encodeAbiParameters(parseAbiParameters('address'),[a(999)]);}],
  ['extra gate call after false',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{(f.traces.get(h(301))!.calls[0].calls as unknown[]).push(f.traces.get(h(301))!.calls[0].calls[0]);}],
  ['wrong root from',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.from=a(123);} ],
  ['root trace gas differs from original limit',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.gas-=1n;}],
  ['root trace gasUsed differs from receipt',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(301))!.gasUsed-=1n;}],
  ['unknown transfer revert',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(303))!.calls[3].failed=true;f.traces.get(h(303))!.calls[3].output='0xdeadbeef';f.traces.get(h(303))!.output='0xdeadbeef';}],
  ['root does not revert',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(303))!.failed=false;}],
  ['transfer false error for another token',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(303))!.output=('0x5274afe7'+encodeAbiParameters(parseAbiParameters('address'),[a(999)]).slice(2)) as Hex;}],
  ['empty transfer return not proven by callTracer',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.traces.get(h(303))!.calls[3].output='0x';}],
] as const)test('local double rejects cause classification: '+label,async()=>{
  const f=await day4AssetFailureFixture();mutate(f);const p=await f.run();assert.equal(p.status,'BLOCKED');
  assert.ok(p.observations.some(o=>o.status==='BLOCKED'&&o.trace===null));assert.equal(p.financialAcceptanceStatus,'BLOCKED');
});

test('local doubles: second settlement gate may reject only after canonical bond gate succeeds',async()=>{
  const f=await day4AssetFailureFixture(),e=f.request.settlement.payload.intent;
  f.traces.get(h(301))!.calls=[f.gate(e.buyer,5n,f.request.settlement.payload.grant.contextHash),f.gate(e.payee,10n,f.request.settlement.payload.grant.contextHash,2)];
  const p=await f.run();assert.equal(p.observations[0].status,'VERIFIED');assert.equal(p.observations[0].trace?.amount,'10');
});

test('local doubles: withdrawal gate denial happens before credit writes',async()=>{
  const f=await day4AssetFailureFixture(),w=f.request.withdrawal;
  f.traces.get(h(303))!.calls=[f.gate(w.beneficiary,10n,w.payload.grant.contextHash,3)];f.traces.get(h(303))!.output='0x349cf84c';
  const p=await f.run();assert.equal(p.status,'COMPLETE');assert.equal(p.observations[2].trace?.creditWritesReached,false);
});

for(const [label,poolAfter,recipientAfter,verified] of [
  ['pool delta wrong with short-circuit',6n,null,true],['recipient delta wrong',5n,9n,true],
  ['correct deltas cannot prove mismatch',5n,10n,false],['pool arithmetic would underflow',16n,null,false],
  ['recipient arithmetic would underflow',5n,-1n,false],['extra recipient read violates pool short-circuit',6n,9n,false]
] as const)test('local doubles: amount mismatch '+label,async()=>{
  const f=await day4AssetFailureFixture(),t=f.traces.get(h(303))!,w=f.request.withdrawal;
  t.output='0xb0a6ea29';t.calls=[f.gate(w.beneficiary,10n,w.payload.grant.contextHash),f.balance(f.config.pool,15n),f.balance(w.beneficiary,recipientAfter===-1n?10n:0n),
    f.transfer(10n,1n),f.balance(f.config.pool,poolAfter),...(recipientAfter===null?[]:[f.balance(w.beneficiary,recipientAfter===-1n?9n:recipientAfter)])];
  const p=await f.run();assert.equal(p.observations[2].status,verified?'VERIFIED':'BLOCKED');
  if(verified)assert.equal(p.observations[2].trace?.condition,'TRANSFER_AMOUNT_MISMATCH');
});

for(const [label,mutate,code] of [
  ['reverted receipt with persisted log',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.receipts.get(h(301))!.logs=f.receipts.get(h(101))!.logs;},'RECEIPT_INVALID'],
  ['foreign original funding calldata',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.transactions.get(h(101))!.input='0xdeadbeef';},'TRANSACTION_INVALID'],
  ['funding event context mismatch',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.receipts.get(h(101))!.logs[0].data='0x';},'EVENT_INVALID'],
  ['historical source code missing',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.port.code=async()=>undefined;},'DAY4_CREATIONS_CODE_MISSING'],
  ['cleared original withdrawal credit',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{const old=f.port.orderAt;f.port.orderAt=async(id,n)=>{const o=await old(id,n);return n===25n?{...o,credits:{buyer:'5',payee:'0'},withdrawn:{buyer:'0',payee:'10'}}:o;};},'CREDIT_NOT_PRESERVED'],
  ['certified compensation cannot be refund',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{const old=f.port.orderAt;f.port.orderAt=async(id,n)=>{const o=await old(id,n);return n===200n?{...o,state:'CERTIFIED',voteMask:3,evidenceHash:f.request.settlement.payload.intent.datasetHash as Hex}:o;};},'EVIDENCE_INVALID'],
  ['expired settle business case',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{const old=f.port.block;f.port.block=async(n)=>{const b=await old(n);return n===15n?{...b,timestamp:4000n}:b;};const order=f.port.orderAt;f.port.orderAt=async(id,n)=>{const o=await order(id,n);return n===15n?{...o,block:{...o.block,timestamp:'4000'}}:o;};},'BUSINESS_CASE_INVALID'],
  ['successful allocation after failed withdrawal',(f:Awaited<ReturnType<typeof day4AssetFailureFixture>>)=>{f.transactions.get(h(102))!.transactionIndex=1;f.transactions.get(h(102))!.blockNumber=25n;f.transactions.get(h(102))!.blockHash=h(25);const r=f.receipts.get(h(102))!;r.transactionIndex=1;r.blockNumber=25n;r.blockHash=h(25);},'ALLOCATION_ORDER_INVALID'],
] as const)test('local doubles: fail closed on '+label,async()=>{
  const f=await day4AssetFailureFixture();mutate(f);await assert.rejects(f.run(),new RegExp(code));
});

test('local doubles: missing trace cannot be replaced by H qualification or reverted receipt',async()=>{
  const f=await day4AssetFailureFixture();f.port.traceTransaction=async()=>({status:'UNAVAILABLE',reason:'RPC_UNAVAILABLE'});
  const p=await f.run();assert.equal(p.status,'BLOCKED');assert.ok(p.observations.every(o=>o.reason==='TRACE_UNAVAILABLE'));
});
test('local doubles: cycle and shared frame are invalid before recursive copy/hash',async()=>{
  const f=await day4AssetFailureFixture(),t=f.traces.get(h(301))!;(t.calls as unknown[]).push(t);
  const p=await f.run();assert.equal(p.observations[0].reason,'TRACE_INVALID');
});
test('local doubles: canonical history changes while trace is read invalidate all observations',async()=>{
  const f=await day4AssetFailureFixture(),old=f.port.traceTransaction;f.port.traceTransaction=async hash=>{const t=await old(hash);f.f.control.providerCalled=true;f.f.control.drift=true;return t;};
  await assert.rejects(f.run(),/SNAPSHOT_CHANGED|RECEIPT_INVALID/);
});
test('local doubles: methods and inputs are captured before awaits; execution is never exposed',async()=>{
  const f=await day4AssetFailureFixture(),old=f.port.chainId;f.port.chainId=async()=>{f.request.settlement.failedTransaction=h(999);f.port.traceTransaction=async()=>{throw Error('should never be used');};return old();};
  const p=await f.run();assert.equal(p.status,'COMPLETE');assert.equal(p.observations[0].failure.hash,h(301));
});
test('local doubles: repeat failures or same settlement/refund order are rejected before RPC',async()=>{
  const f=await day4AssetFailureFixture();f.request.refund=f.request.settlement;let reads=0;f.port.chainId=async()=>{reads++;return 10143;};
  await assert.rejects(f.run(),/INPUT_INVALID/);assert.equal(reads,0);
});

test('local doubles: an undelivered original timeout refund can retain buyer credit after a failed withdrawal',async()=>{
  const f=await day4AssetFailureFixture(),r=f.request.refund,p=r.payload,actor=p.intent.buyer;
  f.request.withdrawal={...r,failedTransaction:h(303),beneficiary:actor,allocationTransaction:h(105),allocationAction:'timeout'};
  const oldAllocation=f.transactions.get(h(102))!,oldReceipt=f.receipts.get(h(102))!;
  f.transactions.set(h(105),{...oldAllocation,hash:h(105),input:allocationCalldata({payload:p},'timeout'),blockNumber:210n,blockHash:h(210)});
  const eventAbi=parseAbi(['event Allocated(bytes32 indexed orderId,uint8 state,uint256 buyerCredit,uint256 payeeCredit)']);
  const log={...oldReceipt.logs[0],transactionHash:h(105),blockHash:h(210),blockNumber:210n,
    topics:encodeEventTopics({abi:eventAbi,eventName:'Allocated',args:{orderId:p.intent.orderId as Hex}}) as [Hex,...Hex[]],
    data:encodeAbiParameters(parseAbiParameters('uint8,uint256,uint256'),[5,15n,0n])};
  f.receipts.set(h(105),{...oldReceipt,transactionHash:h(105),blockNumber:210n,blockHash:h(210),logs:[log]});
  const tx=f.transactions.get(h(303))!,receipt=f.receipts.get(h(303))!;
  Object.assign(tx,{from:actor,blockNumber:220n,blockHash:h(220),input:withdrawalCalldata({payload:p,beneficiary:actor})});
  Object.assign(receipt,{from:actor,blockNumber:220n,blockHash:h(220)});
  const original=f.port.orderAt;f.port.orderAt=async(id,n)=>n!==220n?original(id,n):{
    ...(await original(id,n)),state:'ALLOCATED_REFUND',voteMask:0,evidenceHash:h(0),credits:{buyer:'15',payee:'0'},withdrawn:{buyer:'0',payee:'0'},
    accounting:{locked:'0',outstanding:'15',balance:'15'}};
  f.traces.set(h(303),{...f.node('CALL',actor,f.config.pool,tx.input,('0x5274afe7'+encodeAbiParameters(parseAbiParameters('address'),[f.config.asset as Address]).slice(2)) as Hex,
    [f.gate(actor,15n,p.grant.contextHash),f.balance(f.config.pool,15n),f.balance(actor,85n),f.transfer(15n,0n,actor)],true),gas:tx.gas,gasUsed:receipt.gasUsed});
  const proof=await f.run();assert.equal(proof.status,'COMPLETE');assert.equal(proof.observations[2].trace?.amount,'15');
  assert.equal(proof.observations[2].order.evidenceHash,h(0));assert.equal(proof.financialAcceptanceStatus,'BLOCKED');
});

test('local doubles: public proof rejects altered gas, cause output, funding association and short-circuit balances',async()=>{
  const f=await day4AssetFailureFixture(),proof=await f.run();
  for(const change of [(p:typeof proof)=>{p.observations[0].trace!.rootGas='1';},
    (p:typeof proof)=>{p.observations[0].trace!.rootOutputHash=h(999);},
    (p:typeof proof)=>{p.observations[1].funding=p.observations[0].funding;},
    (p:typeof proof)=>{p.observations[2].order.credits.buyer='0';},
    (p:typeof proof)=>{p.observations[0].order.voteMask=0;},
    (p:typeof proof)=>{const o=p.observations[2];o.order.price='11';o.order.credits.payee='11';
      o.order.accounting.balance='16';o.order.accounting.outstanding='16';o.trace!.amount='11';},
    (p:typeof proof)=>{p.observations[2].trace!.condition='TRANSFER_AMOUNT_MISMATCH';p.observations[2].trace!.directCalls=6;
      p.observations[2].trace!.balances={poolBefore:'15',beneficiaryBefore:'0',poolAfter:'6',beneficiaryAfter:'9'};}]){
    const copy=structuredClone(proof);change(copy);assert.equal(Day4AssetFailureProofSchema.safeParse(copy).success,false);
  }
});

test('local doubles: unchanged tip hash/height with changed timestamp is rejected',async()=>{
  const f=await day4AssetFailureFixture(),old=f.port.block;let tips=0;
  f.port.block=async n=>{const b=await old(n);return n===undefined&&++tips>1?{...b,timestamp:b.timestamp+1n}:b;};
  await assert.rejects(f.run(),/SNAPSHOT_CHANGED/);
});
test('local doubles: first transaction response is captured before another response mutates it',async()=>{
  const f=await day4AssetFailureFixture(),oldTx=f.port.transaction,oldReceipt=f.port.receipt;
  const tx=structuredClone(f.transactions.get(h(101))!),data=tx.input;tx.input='0xdeadbeef';
  f.port.transaction=async hash=>hash===h(101)?tx:oldTx(hash);
  f.port.receipt=async hash=>{if(hash===h(101)){await Promise.resolve();tx.input=data;}return oldReceipt(hash);};
  await assert.rejects(f.run(),/TRANSACTION_INVALID/);
});
