import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {encodeFunctionData,keccak256,type Hex} from 'viem';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';
import type {ProviderSubmission} from '../packages/protocol/src/provider-submission.js';
import {FundingStore} from '../packages/storage/src/funding-store.js';
import {SettlementStore,type SettlementAction} from '../packages/storage/src/settlement-store.js';

const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const a=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const anchor=()=>({chainId:'10143',arbiter:a(1),asset:a(2),owner:a(3),executor:a(4),orderId:h(1),contextHash:h(2),nonce:'0',amount:'15',calldataHash:h(3)});
const order=()=>({chainId:'10143',arbiter:a(1),orderId:h(1),contextHash:h(2),buyer:a(3),seller:a(5),payee:a(6)});
const provider=(id='local_transaction',calldataHash=h(3)):ProviderSubmission=>({provider:'PRIVY',scope:'SDK_SEND_RESPONSE_ASSOCIATION_NOT_FINALIZED_OR_POLICY_PROVENANCE',transactionId:id,walletId:'local_wallet',chainId:'10143',from:a(4),to:a(1),calldataHash});
const allocationProvider=(action:SettlementAction,id='local_transaction',orderId=h(1))=>provider(id,keccak256(encodeFunctionData({abi:escrowAbi,functionName:action,args:[orderId as Hex]})));
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'intentpass-submission-store-')),path=join(directory,'private.db'),opened=new Set<FundingStore|SettlementStore>();
  t.after(()=>{for(const store of opened)store.close();rmSync(directory,{recursive:true,force:true});});
  return {path,openFunding:()=>{const store=new FundingStore(path);opened.add(store);return store;},openSettlement:()=>{const store=new SettlementStore(path);opened.add(store);return store;},close:(store:FundingStore|SettlementStore)=>{store.close();opened.delete(store);}};
}

test('actual SQLite funding binds original acknowledgement atomically and retains exact metadata across reopen',t=>{
  const f=fixture(t);let store=f.openFunding();const record=store.register(anchor()),attempt=store.acquire(record.key,1000)!,metadata=provider();
  store.broadcast(record.key,attempt,h(10),metadata);metadata.transactionId='changed_caller_value';
  assert.equal(store.get(record.key)?.status,'SUBMITTED');assert.deepEqual(store.get(record.key)?.providerSubmission,provider());
  assert.deepEqual(store.listSubmissions(record.key),[{attempt,hash:h(10),providerSubmission:provider()}]);
  f.close(store);store=f.openFunding();assert.deepEqual(store.get(record.key)?.providerSubmission,provider());
  const history=store.listSubmissions(record.key);history[0].providerSubmission!.transactionId='changed_reader_value';assert.equal(store.listSubmissions(record.key)[0].providerSubmission?.transactionId,'local_transaction');
  store.finish(record.key,h(10),'CONFIRMED');assert.equal(store.get(record.key)?.providerSubmission?.transactionId,'local_transaction');
});

test('funding metadata binds chain escrow executor and exact submit calldata before any state update',t=>{
  const f=fixture(t),store=f.openFunding(),record=store.register(anchor()),attempt=store.acquire(record.key,1000)!;
  const invalid:unknown[]=[{...provider(),chainId:'143'},{...provider(),to:a(9)},{...provider(),from:a(9)},{...provider(),calldataHash:h(9)},
    {...provider(),scope:'SELF_ATTESTED'},{...provider(),transactionId:'../private'},{...provider(),additional:'not accepted'}];
  for(const metadata of invalid){assert.throws(()=>store.broadcast(record.key,attempt,h(10),metadata as ProviderSubmission),/PROVIDER_SUBMISSION_(INVALID|MISMATCH)/);assert.equal(store.get(record.key)?.status,'IN_FLIGHT');assert.equal(store.get(record.key)?.hash,null);assert.deepEqual(store.listSubmissions(record.key),[]);}
  assert.throws(()=>store.broadcast(record.key,randomUUID(),h(10),provider()),/STALE_ATTEMPT/);assert.deepEqual(store.listSubmissions(record.key),[]);
});

test('funding identical acknowledgement is idempotent while terminal hash and provider tuple never change',t=>{
  const f=fixture(t),store=f.openFunding(),record=store.register(anchor()),attempt=store.acquire(record.key,1000)!;
  store.broadcast(record.key,attempt,h(10),provider());store.broadcast(record.key,attempt,h(10),provider());store.finish(record.key,h(10),'CONFIRMED');
  store.broadcast(record.key,attempt,h(10));store.broadcast(record.key,attempt,h(10),provider());const before=store.get(record.key);
  for(const [hash,metadata] of [[h(11),provider()],[h(10),provider('other_id')],[h(10),{...provider(),walletId:'other_wallet'}]] as const){assert.throws(()=>store.broadcast(record.key,attempt,hash,metadata),/PROVIDER_SUBMISSION_CONFLICT/);assert.deepEqual(store.get(record.key),before);}
  assert.equal(store.listSubmissions(record.key).length,1);assert.equal(store.get(record.key)?.status,'CONFIRMED');
});

test('expired funding remains unrepeatable and late response adds original history without reversing reconciliation',t=>{
  const f=fixture(t);let store=f.openFunding();const record=store.register(anchor()),attempt=store.acquire(record.key,1000)!;f.close(store);store=f.openFunding();
  store.expire(record.key,31000);assert.equal(store.get(record.key)?.status,'UNKNOWN');assert.equal(store.acquire(record.key,32000),undefined);
  store.reconcileOrder(record.key);store.broadcast(record.key,attempt,h(10),provider());
  assert.equal(store.get(record.key)?.status,'RECONCILED');assert.equal(store.get(record.key)?.hash,null);assert.equal(Object.hasOwn(store.get(record.key)!,'providerSubmission'),false);
  assert.deepEqual(store.listSubmissions(record.key),[{attempt,hash:h(10),providerSubmission:provider()}]);assert.equal(store.acquire(record.key,33000),undefined);
  store.finish(record.key,h(10),'CONFIRMED');assert.deepEqual(store.get(record.key)?.providerSubmission,provider());
});

test('funding independently proven hash remains immutable when original SDK ID arrives afterwards',t=>{
  const f=fixture(t),store=f.openFunding(),record=store.register(anchor()),attempt=store.acquire(record.key,1000)!;store.expire(record.key,31000);
  store.finish(record.key,h(10),'REVERTED');store.broadcast(record.key,attempt,h(10),provider());assert.equal(store.get(record.key)?.status,'REVERTED');
  assert.throws(()=>store.broadcast(record.key,attempt,h(11),provider()),/PROVIDER_SUBMISSION_CONFLICT/);assert.deepEqual(store.listSubmissions(record.key),[{attempt,hash:h(10),providerSubmission:provider()}]);
});

test('settle and timeout acknowledgements bind their original selector order and canonical escrow',t=>{
  for(const action of ['settle','timeout'] as const){const f=fixture(t),store=f.openSettlement(),record=store.register(order()),attempt=store.acquire(record.key,action,1000)!;
    for(const metadata of [allocationProvider(action==='settle'?'timeout':'settle'),allocationProvider(action,'local_transaction',h(99)),{...allocationProvider(action),to:a(99)},{...allocationProvider(action),chainId:'143'}]){
      assert.throws(()=>store.broadcast(record.key,attempt,h(10),metadata),/PROVIDER_SUBMISSION_MISMATCH/);assert.equal(store.get(record.key)?.status,'IN_FLIGHT');assert.deepEqual(store.listSubmissions(record.key),[]);
    }
    store.broadcast(record.key,attempt,h(10),allocationProvider(action));assert.equal(store.get(record.key)?.providerSubmission?.transactionId,'local_transaction');
    assert.deepEqual(store.listSubmissions(record.key),[{attempt,action,hash:h(10),providerSubmission:allocationProvider(action)}]);
  }
});

test('actual settlement SQLite retries preserve old reverted provider ID and cannot alter either attempt',t=>{
  const f=fixture(t);let store=f.openSettlement();const record=store.register(order()),first=store.acquire(record.key,'settle',1000)!;
  store.broadcast(record.key,first,h(10),allocationProvider('settle','first_id'));store.finish(record.key,first,'REVERTED','TRANSACTION_REVERTED');store.retryBlocked(record.key);
  const second=store.acquire(record.key,'timeout',2000)!;store.broadcast(record.key,second,h(11),allocationProvider('timeout','second_id'));const current=store.get(record.key);
  store.broadcast(record.key,first,h(10),allocationProvider('settle','first_id'));assert.deepEqual(store.get(record.key),current);
  assert.throws(()=>store.broadcast(record.key,first,h(10),allocationProvider('settle','replacement_id')),/PROVIDER_SUBMISSION_CONFLICT/);
  assert.throws(()=>store.broadcast(record.key,first,h(12),allocationProvider('settle','first_id')),/PROVIDER_SUBMISSION_CONFLICT/);
  f.close(store);store=f.openSettlement();assert.deepEqual(store.get(record.key),current);assert.deepEqual(store.listSubmissions(record.key),[
    {attempt:first,action:'settle',hash:h(10),providerSubmission:allocationProvider('settle','first_id')},{attempt:second,action:'timeout',hash:h(11),providerSubmission:allocationProvider('timeout','second_id')}]);
});

test('late settlement acknowledgement can add a missing original ID after retry without touching new active lease',t=>{
  const f=fixture(t),store=f.openSettlement(),record=store.register(order()),first=store.acquire(record.key,'settle',1000)!;
  store.broadcast(record.key,first,h(10));store.finish(record.key,first,'REVERTED');store.retryBlocked(record.key);const second=store.acquire(record.key,'timeout',2000)!,before=store.get(record.key);
  store.broadcast(record.key,first,h(10),allocationProvider('settle','late_id'));assert.deepEqual(store.get(record.key),before);assert.equal(store.get(record.key)?.attempt,second);
  assert.equal(store.listSubmissions(record.key)[0].providerSubmission?.transactionId,'late_id');assert.throws(()=>store.broadcast(record.key,randomUUID(),h(10),allocationProvider('settle','late_id')),/STALE_ATTEMPT/);
});

test('UNKNOWN settlement never releases a lease; reconciled late response stays historical until independently proven',t=>{
  const f=fixture(t),store=f.openSettlement(),record=store.register(order()),attempt=store.acquire(record.key,'settle',1000)!;store.expire(record.key,31000);
  assert.equal(store.acquire(record.key,'settle',32000),undefined);assert.throws(()=>store.retryBlocked(record.key),/RETRY_UNSAFE/);store.reconcile(record.key);
  store.broadcast(record.key,attempt,h(10),allocationProvider('settle'));assert.equal(store.get(record.key)?.status,'RECONCILED');assert.equal(store.get(record.key)?.txHash,null);assert.equal(Object.hasOwn(store.get(record.key)!,'providerSubmission'),false);
  store.provenBroadcast(record.key,attempt,'settle',h(10));assert.deepEqual(store.get(record.key)?.providerSubmission,allocationProvider('settle'));store.finish(record.key,attempt,'CONFIRMED');
  store.broadcast(record.key,attempt,h(10),allocationProvider('settle'));assert.equal(store.get(record.key)?.status,'CONFIRMED');assert.equal(store.listSubmissions(record.key).length,1);
});

test('same Privy transaction ID cannot be assigned to a different reserved attempt and atomic rollback keeps it unsubmitted',t=>{
  const f=fixture(t),store=f.openSettlement(),record=store.register(order()),first=store.acquire(record.key,'settle',1000)!;
  store.broadcast(record.key,first,h(10),allocationProvider('settle'));store.finish(record.key,first,'REVERTED');store.retryBlocked(record.key);const second=store.acquire(record.key,'timeout',2000)!,before=store.get(record.key);
  assert.throws(()=>store.broadcast(record.key,second,h(11),allocationProvider('timeout')),/PROVIDER_SUBMISSION_CONFLICT/);assert.deepEqual(store.get(record.key),before);assert.equal(store.listSubmissions(record.key).length,1);
});

test('two SQLite connections cannot replace an already bound funding hash or ID',t=>{
  const f=fixture(t),first=f.openFunding(),second=f.openFunding(),record=first.register(anchor()),attempt=first.acquire(record.key,1000)!;
  assert.equal(second.acquire(record.key,1000),undefined);first.broadcast(record.key,attempt,h(10),provider());
  assert.throws(()=>second.broadcast(record.key,attempt,h(11),provider('replacement_id')),/PROVIDER_SUBMISSION_CONFLICT/);second.broadcast(record.key,attempt,h(10),provider());assert.equal(first.listSubmissions(record.key).length,1);
});

test('original funding and settlement tables migrate without fabricated provider metadata or changed legacy object shape',t=>{
  const f=fixture(t),db=new DatabaseSync(f.path),fundingAttempt=randomUUID(),settlementAttempt=randomUUID(),fundingKey=`10143:${a(1)}:${h(1)}`,settlementKey=fundingKey;
  db.exec(`CREATE TABLE funding_attempts(key TEXT PRIMARY KEY,anchor_json TEXT NOT NULL,status TEXT NOT NULL,attempt TEXT,hash TEXT,lease_until INTEGER) STRICT;
    CREATE TABLE settlement_orders(key TEXT PRIMARY KEY,order_json TEXT NOT NULL,status TEXT NOT NULL,attempt TEXT,action TEXT,lease_until INTEGER,tx_hash TEXT,error TEXT) STRICT;`);
  db.prepare('INSERT INTO funding_attempts VALUES(?,?,?,?,?,?)').run(fundingKey,JSON.stringify(anchor()),'CONFIRMED',fundingAttempt,h(10),null);
  db.prepare('INSERT INTO settlement_orders VALUES(?,?,?,?,?,?,?,?)').run(settlementKey,JSON.stringify(order()),'REVERTED',settlementAttempt,'settle',null,h(11),'TRANSACTION_REVERTED');db.close();
  const funding=f.openFunding(),settlement=f.openSettlement();assert.deepEqual(funding.get(fundingKey),{key:fundingKey,anchor:anchor(),status:'CONFIRMED',attempt:fundingAttempt,hash:h(10),leaseUntil:null});
  assert.deepEqual(settlement.get(settlementKey),{key:settlementKey,order:order(),status:'REVERTED',attempt:settlementAttempt,action:'settle',leaseUntil:null,txHash:h(11),error:'TRANSACTION_REVERTED'});
  assert.deepEqual(funding.listSubmissions(fundingKey),[{attempt:fundingAttempt,hash:h(10)}]);assert.deepEqual(settlement.listSubmissions(settlementKey),[{attempt:settlementAttempt,action:'settle',hash:h(11)}]);
  settlement.retryBlocked(settlementKey);assert.equal(settlement.listSubmissions(settlementKey).length,1);funding.broadcast(fundingKey,fundingAttempt,h(10),provider());assert.equal(funding.get(fundingKey)?.status,'CONFIRMED');
});

test('legacy Hex broadcast keeps original record shape and missing metadata never erases a recorded association',t=>{
  const f=fixture(t),funding=f.openFunding(),settlement=f.openSettlement(),fundingRecord=funding.register(anchor()),settlementRecord=settlement.register(order());
  const fundingAttempt=funding.acquire(fundingRecord.key,1000)!,settlementAttempt=settlement.acquire(settlementRecord.key,'timeout',1000)!;
  funding.broadcast(fundingRecord.key,fundingAttempt,h(10));settlement.broadcast(settlementRecord.key,settlementAttempt,h(11));
  assert.equal(Object.hasOwn(funding.get(fundingRecord.key)!,'providerSubmission'),false);assert.equal(Object.hasOwn(settlement.get(settlementRecord.key)!,'providerSubmission'),false);
  funding.broadcast(fundingRecord.key,fundingAttempt,h(10),provider());funding.broadcast(fundingRecord.key,fundingAttempt,h(10));assert.deepEqual(funding.get(fundingRecord.key)?.providerSubmission,provider());
});
