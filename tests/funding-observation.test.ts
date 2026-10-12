import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {PublicClient,Address,Hex} from 'viem';
import {EscrowReader,type EscrowDeployment} from '../packages/protocol/src/escrow-read.js';
import {PurchasePreflightReader} from '../packages/protocol/src/purchase-preflight.js';
import {committeeHash} from '../packages/protocol/src/escrow.js';
import {FundingStore} from '../packages/storage/src/funding-store.js';
import {FundingWorker} from '../apps/worker/src/funding.js';
import {viemFundingPort} from '../apps/worker/src/funding-port.js';
import {originalAuthorizationFixture,readTestHash as h} from './support/original-authorization.js';

// The real readers, worker, signatures and journal run against a moving-head
// RPC double. This is local verification, not evidence of an actual payment.
async function fixture(){
  const f=await originalAuthorizationFixture('10143'),g=f.payload.grant;
  const d:EscrowDeployment={chainId:g.chainId,arbiter:g.arbiter as Address,asset:g.asset as Address,gate:f.seller.address,reviewer:f.reviewer.address,committeeHash:committeeHash(f.deployment.committee)};
  let tip=200n,reorg=false,sends=0,simulations=0;
  const heights:bigint[]=[],zeroAddress='0x'+'00'.repeat(20),zeroHash='0x'+'00'.repeat(32);
  const client={getChainId:async()=>10143,getBlock:async(input:{blockTag?:string;blockNumber?:bigint})=>{
    const number=input.blockNumber??tip++;return {number,hash:(reorg&&input.blockNumber!==undefined?h(999):h(Number(number))) as Hex,timestamp:1000n};
  },readContract:async(input:{functionName:string;blockNumber:bigint;args?:unknown[]})=>{
    heights.push(input.blockNumber);
    switch(input.functionName){
      case 'asset':return d.asset;case 'eligibility':return d.gate;case 'reviewer':return d.reviewer;case 'committeeHash':return d.committeeHash;
      case 'orders':return [zeroHash,zeroAddress,zeroAddress,zeroAddress,0n,0n,0n,0n,zeroHash,zeroHash,zeroHash,0,0];
      case 'consumed':case 'revoked':return false;case 'canTransfer':return true;case 'allowance':return BigInt(g.amount);
      case 'balanceOf':return String(input.args?.[0]).toLowerCase()===d.arbiter.toLowerCase()?0n:100n;
      default:return 0n;
    }
  },call:async()=>{simulations++;throw Error('UNEXPECTED_SIMULATION');}} as unknown as PublicClient;
  const dir=mkdtempSync(join(tmpdir(),'intentpass-moving-funding-head-')),store=new FundingStore(join(dir,'funding.db'));
  const reader=new EscrowReader(client,d),preflight=new PurchasePreflightReader(client,d,g.executor),port=viemFundingPort(reader,preflight,{address:g.executor as Address,send:async()=>{sends++;throw Error('UNEXPECTED_SEND');}}),worker=new FundingWorker(store,port,f.deployment,()=>1000000);
  return {f,worker,heights,counts:()=>({sends,simulations,tip}),reorg:()=>{reorg=true;},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('funding reconciliation uses one finalized height despite head advancement and refreshes it on the next read',async()=>{
  const x=await fixture();try{
    const result=await x.worker.reconcile(x.f.payload,[x.f.buyer.address]);
    assert.equal(result.error,undefined);assert.equal(result.snapshot?.state,'UNREGISTERED');assert.equal(result.snapshot?.block.number,'200');
    assert.equal(result.record.status,'IDLE');assert.equal(result.record.attempt,null);assert.equal(result.record.hash,null);assert.deepEqual([...new Set(x.heights)],[200n]);assert.ok(x.counts().tip>201n);
    x.heights.length=0;const second=await x.worker.reconcile(x.f.payload,[x.f.buyer.address]);assert.equal(second.error,undefined);assert.equal(second.snapshot?.block.number,'202');assert.deepEqual([...new Set(x.heights)],[202n]);assert.deepEqual({sends:x.counts().sends,simulations:x.counts().simulations},{sends:0,simulations:0});
  }finally{x.close();}
});
test('a changed canonical hash still blocks reconciliation without opening any send or simulation',async()=>{
  const x=await fixture();try{x.reorg();const result=await x.worker.reconcile(x.f.payload,[x.f.buyer.address]);assert.equal(result.error,'CHAIN_SNAPSHOT_CHANGED');assert.equal(result.snapshot,undefined);assert.equal(result.record.status,'IDLE');assert.equal(result.record.attempt,null);assert.deepEqual({sends:x.counts().sends,simulations:x.counts().simulations},{sends:0,simulations:0});}finally{x.close();}
});
