import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SettlementStore} from '../packages/storage/src/settlement-store.js';
import {SettlementWorker,type SettlementPort} from '../apps/worker/src/settlement.js';
import type {OrderSnapshot} from '../packages/protocol/src/escrow-read.js';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`;
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
const order={chainId:'31337',arbiter:a(1),orderId:h(1),contextHash:h(2),buyer:a(2),seller:a(3),payee:a(3)};
function snapshot(state:OrderSnapshot['state']='CERTIFIED'):OrderSnapshot{return {...order,asset:a(4),price:'10',bond:'5',deliveryDeadline:'2000',settlementDeadline:'3000',datasetHash:h(3),serviceTermsHash:h(4),evidenceHash:h(5),voteMask:3,state,credits:{buyer:'0',payee:'0'},withdrawn:{buyer:'0',payee:'0'},accounting:{locked:'15',outstanding:'0',balance:'15'},block:{number:'10',hash:h(10),timestamp:'1000'}};}
function harness(){
  const db=new SettlementStore(':memory:'),key=db.register(order).key;
  let current=snapshot(),sends=0,preflights=0,receipt:'PENDING'|'SUCCESS'|'REVERTED'='PENDING';
  const port:SettlementPort={read:async()=>structuredClone(current),simulate:async()=>{preflights++;},send:async()=>{sends++;return h(20);},receipt:async()=>receipt==='PENDING'?{status:'PENDING'}:{status:receipt,blockNumber:'10',blockHash:h(10)},blockHash:async()=>h(10)};
  return {db,key,port,worker:new SettlementWorker(db,port,()=>1000),set:(value:OrderSnapshot)=>{current=value;},receipt:(value:typeof receipt)=>{receipt=value;},sends:()=>sends,preflights:()=>preflights};
}
test('allocation readonly worker observes an eligible original order without simulation lease or broadcast',async()=>{
  const x=harness();try{for(let i=0;i<3;i++)assert.equal((await x.worker.runOnce(x.key,false)).status,'WAITING');assert.equal(x.db.get(x.key)?.status,'IDLE');assert.equal(x.db.get(x.key)?.attempt,null);assert.equal(x.sends(),0);assert.equal(x.preflights(),0);await x.worker.runOnce(x.key,true);assert.equal(x.sends(),1);assert.equal((await x.worker.runOnce(x.key,false)).status,'SUBMITTED');assert.equal(x.sends(),1);}finally{x.db.close();}
});
test('worker distinguishes broadcast, chain allocation and actual withdrawal; confirmation does not resend',async()=>{
  const x=harness();try{
    const sent=await x.worker.runOnce(x.key);assert.equal(sent.status,'SUBMITTED');assert.equal(sent.snapshot?.credits.payee,'0');
    x.set({...snapshot('ALLOCATED_PAID'),credits:{buyer:'5',payee:'10'},accounting:{locked:'0',outstanding:'15',balance:'15'}});
    assert.equal((await x.worker.runOnce(x.key)).status,'SUBMITTED');
    x.receipt('SUCCESS');const confirmed=await x.worker.runOnce(x.key);assert.equal(confirmed.status,'CONFIRMED');assert.equal(confirmed.snapshot?.withdrawn.payee,'0');
    assert.equal((await x.worker.runOnce(x.key)).status,'CONFIRMED');assert.equal(x.sends(),1);
  }finally{x.db.close();}
});
test('two workers using separate SQLite connections share one durable send lease and survive restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'intentpass-worker-')),path=join(dir,'queue.db');
  let first=new SettlementStore(path),second=new SettlementStore(path);
  try {
    const key=first.register(order).key;
    const [left,right]=await Promise.all([Promise.resolve().then(()=>first.acquire(key,'settle',1000)),Promise.resolve().then(()=>second.acquire(key,'settle',1000))]);
    assert.equal([left,right].filter(Boolean).length,1);
    first.close();second.close();first=new SettlementStore(path);second=new SettlementStore(path);
    first.expire(key,31001);assert.equal(second.get(key)?.status,'UNKNOWN');assert.equal(second.acquire(key,'settle',32000),undefined);
    assert.throws(()=>second.retryBlocked(key),/RETRY_UNSAFE/);
  }finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});
test('concurrent runOnce callers broadcast at most once',async()=>{
  const x=harness();try{await Promise.all([x.worker.runOnce(x.key),new SettlementWorker(x.db,x.port,()=>1000).runOnce(x.key)]);assert.equal(x.sends(),1);}finally{x.db.close();}
});
test('send timeout creates UNKNOWN and reconciliation uses terminal chain state without another send',async()=>{
  const x=harness();let attempts=0;x.port.send=async()=>{attempts++;throw new Error('provider credential must never be saved');};
  try {
    assert.equal((await x.worker.runOnce(x.key)).status,'UNKNOWN');assert.equal(x.db.get(x.key)?.error,'SUBMISSION_OUTCOME_UNKNOWN');
    await x.worker.runOnce(x.key);assert.equal(attempts,1);assert.throws(()=>x.db.retryBlocked(x.key),/RETRY_UNSAFE/);
    x.set(snapshot('ALLOCATED_PAID'));assert.equal((await x.worker.runOnce(x.key)).status,'RECONCILED');assert.equal(attempts,1);
  }finally{x.db.close();}
});
test('preflight refusal blocks without sending and requires explicit retry',async()=>{
  const x=harness();x.port.simulate=async()=>{throw new Error('CVI blocked');};try{
    assert.equal((await x.worker.runOnce(x.key)).status,'BLOCKED');assert.equal(x.sends(),0);
    await x.worker.runOnce(x.key);assert.equal(x.sends(),0);x.db.retryBlocked(x.key);
    x.port.simulate=async()=>{};assert.equal((await x.worker.runOnce(x.key)).status,'SUBMITTED');assert.equal(x.sends(),1);
  }finally{x.db.close();}
});
test('expired preflight lease cannot start a late broadcast',async()=>{
  const x=harness();let now=1000;const worker=new SettlementWorker(x.db,x.port,()=>now);x.port.simulate=async()=>{now=31001;};
  try{assert.equal((await worker.runOnce(x.key)).status,'UNKNOWN');assert.equal(x.sends(),0);}finally{x.db.close();}
});
test('normal settlement and both timeout branches follow current chain timestamp and state',async()=>{
  for(const state of ['FUNDED','EVIDENCE_FROZEN','CERTIFIED'] as const){
    const x=harness();let action:string|undefined;x.port.send=async value=>{action=value;return h(20);};
    try{x.set({...snapshot(state),block:{number:'10',hash:h(10),timestamp:'3001'}});assert.equal((await x.worker.runOnce(x.key)).status,'SUBMITTED');assert.equal(action,'timeout');}finally{x.db.close();}
  }
  const x=harness();try{x.set(snapshot('FUNDED'));assert.equal((await x.worker.runOnce(x.key)).status,'WAITING');assert.equal(x.sends(),0);}finally{x.db.close();}
});
test('RPC errors, mutated context/owner, and unrelated successful receipt never become confirmation',async()=>{
  const x=harness();try {
    x.set({...snapshot(),buyer:a(99)});assert.equal((await x.worker.runOnce(x.key)).error,'ORDER_ANCHOR_MISMATCH');assert.equal(x.sends(),0);
    x.set(snapshot());await x.worker.runOnce(x.key);x.receipt('SUCCESS');
    assert.equal((await x.worker.runOnce(x.key)).error,'TRANSACTION_EFFECT_MISMATCH');assert.equal(x.db.get(x.key)?.status,'SUBMITTED');
    x.port.read=async()=>{throw new Error('Authorization: sensitive');};assert.equal((await x.worker.runOnce(x.key)).error,'CHAIN_UNAVAILABLE');assert.equal(x.db.get(x.key)?.status,'SUBMITTED');
  }finally{x.db.close();}
});
test('reverted tx preserves order and requires explicit retry; reorg cannot retain a false confirmation',async()=>{
  const x=harness();try {
    await x.worker.runOnce(x.key);x.receipt('REVERTED');assert.equal((await x.worker.runOnce(x.key)).status,'REVERTED');assert.equal(x.sends(),1);
    await x.worker.runOnce(x.key);assert.equal(x.sends(),1);x.db.retryBlocked(x.key);await x.worker.runOnce(x.key);
    x.receipt('SUCCESS');x.set(snapshot('ALLOCATED_PAID'));assert.equal((await x.worker.runOnce(x.key)).status,'CONFIRMED');
    x.port.blockHash=async()=>h(99);assert.equal((await x.worker.runOnce(x.key)).error,'CHAIN_SNAPSHOT_CHANGED');assert.equal(x.sends(),2);
  }finally{x.db.close();}
});
test('order registration is immutable and stale attempts cannot overwrite a newer submission',()=>{
  const x=harness();try {
    assert.throws(()=>x.db.register({...order,contextHash:h(99)}),/ORDER_ANCHOR_CONFLICT/);
    const attempt=x.db.acquire(x.key,'settle',1000)!;assert.throws(()=>x.db.broadcast(x.key,'old',h(10)),/STALE_ATTEMPT/);
    x.db.broadcast(x.key,attempt,h(20));assert.equal(x.db.get(x.key)?.txHash,h(20));
    assert.throws(()=>x.db.finish(x.key,attempt,'UNKNOWN','secret: foo'),/ERROR_CODE_INVALID/);
  }finally{x.db.close();}
});

test('independent Node processes atomically compete for one SQLite lease',{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'intentpass-process-race-')),path=join(dir,'queue.db');
  const db=new SettlementStore(path),key=db.register(order).key;db.close();
  const children=Array.from({length:2},()=>fork(fileURLToPath(new URL('./helpers/claim.ts',import.meta.url)),[path],{
    execArgv:['--experimental-sqlite','--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],
  }));
  try {
    const waitMessage=(child:typeof children[number])=>new Promise<unknown[]>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',error);};
      const message=(value:unknown)=>{cleanup();resolve([value]);};
      const exit=()=>{cleanup();reject(new Error('CLAIM_PROCESS_EXITED'));};
      const error=()=>{cleanup();reject(new Error('CLAIM_PROCESS_FAILED'));};
      const timer=setTimeout(()=>{cleanup();reject(new Error('CLAIM_PROCESS_TIMEOUT'));},5000);
      child.once('message',message);child.once('exit',exit);child.once('error',error);
    });
    for(const value of await Promise.all(children.map(waitMessage)))assert.equal((value[0] as {type:string}).type,'ready');
    const results=children.map(waitMessage),exits=children.map(c=>once(c,'exit',{signal:AbortSignal.timeout(5000)}));
    for(const c of children)c.send(key);
    const claimed=await Promise.all(results);assert.equal(claimed.filter(value=>(value[0] as {attempt:string|null}).attempt!==null).length,1);
    for(const [code] of await Promise.all(exits))assert.equal(code,0);
    const reopened=new SettlementStore(path);try{assert.equal(reopened.get(key)?.status,'IN_FLIGHT');}finally{reopened.close();}
  }finally{for(const c of children)if(c.exitCode===null)c.kill();rmSync(dir,{recursive:true,force:true});}
});
test('definite sender scope rejection blocks without UNKNOWN or automatic retry',async()=>{
  const {SubmissionRejected}=await import('../packages/adapters/src/privy-sender.js');
  const x=harness();let attempts=0;x.port.send=async()=>{attempts++;throw new SubmissionRejected();};
  try{assert.equal((await x.worker.runOnce(x.key)).status,'BLOCKED');assert.equal(x.db.get(x.key)?.error,'TRANSACTION_SCOPE_REJECTED');await x.worker.runOnce(x.key);assert.equal(attempts,1);}finally{x.db.close();}
});
test('sender rejection after concurrent lease expiry preserves UNKNOWN without crashing or retrying',async()=>{
  const {SubmissionRejected}=await import('../packages/adapters/src/privy-sender.js');const x=harness();let calls=0;
  x.port.send=async()=>{calls++;x.db.expire(x.key,31001);throw new SubmissionRejected();};
  try{assert.equal((await x.worker.runOnce(x.key)).status,'UNKNOWN');assert.equal((await x.worker.runOnce(x.key)).status,'UNKNOWN');assert.equal(calls,1);}finally{x.db.close();}
});
