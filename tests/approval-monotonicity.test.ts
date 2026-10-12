import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {encodeAbiParameters,encodeEventTopics,encodeFunctionData,TransactionReceiptNotFoundError,type Address,type PublicClient} from 'viem';
import {originalAuthorizationFixture,readTestHash as h} from './support/original-authorization.js';
import {ExactApprovalReader} from '../packages/capsule/src/asset-approval-read.js';
import {exactApprovalAbi} from '../packages/capsule/src/asset-approval.js';
import {ApprovalStore} from '../packages/storage/src/approval-store.js';
import {ApprovalReceiptSchema,type ApprovalRecord} from '../packages/protocol/src/approval-api.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {AssetApprovalFlow,type ApprovalPort} from '../apps/web/src/asset-approval-flow.js';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import {serveApproval} from '../apps/web/src/approval-api.js';

type Original=Awaited<ReturnType<typeof originalAuthorizationFixture>>;
const subject='local-approval-buyer',hash=h(999);
function record(x:Original,status:ApprovalRecord['status']='RESERVED'):ApprovalRecord{
  const g=x.payload.grant;return {orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,chainId:g.chainId,asset:g.asset,owner:g.owner,spender:g.arbiter,amount:g.amount,step:'SET',status,hash:status==='RESERVED'?null:hash};
}
function finalReceipt(x:Original,status:'CONFIRMED'|'REVERTED'='CONFIRMED',number='205',blockHash=h(205)){
  const g=x.payload.grant;return ApprovalReceiptSchema.parse({status,hash,orderId:g.orderId,step:'SET',approvedAmount:g.amount,currentAllowance:g.amount,exactAllowance:true,block:{number,hash:blockHash},canSubmitPayment:false});
}
function localSession(x:Original){
  let walletCalls=0;
  const auth:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-only-token',logout:async()=>{},approveAsset:async()=>{walletCalls++;throw new Error('UNEXPECTED_WALLET_REQUEST');}};
  const session=new BrowserSession(async()=>auth,async path=>new Response(JSON.stringify(path==='/api/config'?{privyAppId:'local-only-app',meraRpId:null,recoveryDeployment:x.deployment}:{subject,wallets:[x.buyer.address]})));
  return {session,walletCalls:()=>walletCalls};
}
async function closeServer(server:Server){server.closeIdleConnections();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));}

/** Actual reader and signatures, with explicitly local RPC/identity doubles. */
async function readerFixture(status:'success'|'reverted'){
  const x=await originalAuthorizationFixture(),g=x.payload.grant,blockHash=h(200);
  const event={type:'event',name:'Approval',inputs:[{name:'owner',type:'address',indexed:true},{name:'spender',type:'address',indexed:true},{name:'value',type:'uint256',indexed:false}]} as const;
  const transaction={hash,to:g.asset,from:g.owner,input:encodeFunctionData({abi:exactApprovalAbi,functionName:'approve',args:[g.arbiter as Address,BigInt(g.amount)]}),value:0n,chainId:Number(g.chainId),blockNumber:200n,blockHash};
  const receipt={transactionHash:hash,blockNumber:200n,blockHash,status,logs:status==='reverted'?[]:[{address:g.asset,removed:false,data:encodeAbiParameters([{type:'uint256'}],[BigInt(g.amount)]),topics:encodeEventTopics({abi:[event],eventName:'Approval',args:{owner:g.owner as Address,spender:g.arbiter as Address}})}]};
  let final=205n,missing=false,receiptReads=0;
  const rpc={getChainId:async()=>Number(g.chainId),getTransaction:async()=>transaction,getTransactionReceipt:async()=>{receiptReads++;if(missing)throw new TransactionReceiptNotFoundError({hash});return receipt;},getBlock:async(input:{blockNumber?:bigint})=>({number:input.blockNumber??final,hash:h(Number(input.blockNumber??final))}),readContract:async()=>status==='reverted'?0n:BigInt(g.amount)} as unknown as PublicClient;
  const reader=new ExactApprovalReader(rpc,x.deployment);
  return {x,reader,loseReceipt:()=>{missing=true;},lagFinality:()=>{final=199n;},receiptReads:()=>receiptReads};
}

test('recorded approval finality survives an actual reader missing receipt or lagging node through authenticated HTTP and flow',async()=>{
  for(const outcome of ['success','reverted'] as const)for(const unavailable of ['missing','lagging'] as const){
    const f=await readerFixture(outcome),x=f.x,store=new ApprovalStore(':memory:'),browser=localSession(x),initial=record(x);store.reserve(subject,initial);
    const api={auth:{authenticate:async()=>({subject,wallets:[x.buyer.address]})},deployment:x.deployment,store,preflight:async()=>{throw new Error('UNEXPECTED_PREFLIGHT');},receipt:(input:unknown,wallets:string[],step:'RESET'|'SET',transactionHash:string)=>f.reader.read(input,wallets,step,transactionHash)};
    const server=createServer((req,res)=>{void serveApproval(req,res,req.url?.endsWith('/reserve')?'reserve':'reconcile',api);});
    try{
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
      const address=server.address();assert.ok(address&&typeof address!=='string');
      const client=new PurchaseClient(`http://127.0.0.1:${address.port}`,async()=>'local-only-token'),flow=new AssetApprovalFlow(x.payload,subject,()=>true,browser.session,client,()=>1000n),expected=outcome==='success'?'CONFIRMED':'REVERTED';
      const first=await flow.reconcile('SET',hash);assert.ok('receipt'in first&&first.receipt.status===expected);assert.equal(flow.attemptStates.SET?.status,expected);
      const saved=store.get(subject,x.payload.grant.orderId,'SET');assert.equal(saved?.status,expected);
      if(unavailable==='missing')f.loseReceipt();else f.lagFinality();
      assert.equal((await f.reader.read(x.payload,[x.buyer.address],'SET',hash)).status,'PENDING');
      await assert.rejects(flow.reconcile('SET',hash),/PURCHASE_HTTP_503/);
      assert.equal(flow.attemptStates.SET?.status,expected);assert.equal(flow.attemptStates.SET?.hash,hash);assert.deepEqual(store.get(subject,x.payload.grant.orderId,'SET'),saved);
      const replay=await client.reserveApproval({payload:x.payload,step:'SET'});assert.ok('created'in replay&&!replay.created&&replay.record.status===expected);
      await assert.rejects(flow.approve('SET'),/APPROVAL_RECONCILIATION_REQUIRED/);assert.equal(browser.walletCalls(),0);assert.equal(f.receiptReads(),3);
    }finally{await closeServer(server);store.close();}
  }
});

test('approval flow independently rejects contradictory responses, changed hash, and every downgrade or reversal of its original terminal state',async()=>{
  for(const status of ['CONFIRMED','REVERTED'] as const){
    const x=await originalAuthorizationFixture(),browser=localSession(x);let response:unknown={record:record(x,status),receipt:finalReceipt(x,status)};
    const port:ApprovalPort={preflight:async()=>{throw new Error('UNEXPECTED_PREFLIGHT');},reserveApproval:async()=>{throw new Error('UNEXPECTED_RESERVATION');},reconcileApproval:async()=>{if(response instanceof Error)throw response;return structuredClone(response);}};
    const flow=new AssetApprovalFlow(x.payload,subject,()=>true,browser.session,port,()=>1000n);await flow.reconcile('SET',hash);const saved=flow.attemptStates;
    const pending={status:'PENDING',hash,canSubmitPayment:false},opposite=status==='CONFIRMED'?'REVERTED':'CONFIRMED';
    for(const invalid of [
      {record:record(x,status),receipt:pending},
      {record:record(x),receipt:pending},
      {record:record(x,opposite),receipt:finalReceipt(x,opposite)},
      {record:record(x,status),receipt:finalReceipt(x,opposite)},
      {record:{...record(x,status),hash:h(998)},receipt:{...finalReceipt(x,status),hash:h(998)}},
      new Error('LOCAL_RPC_UNAVAILABLE'),
    ]){response=invalid;await assert.rejects(flow.reconcile('SET',hash),/APPROVAL_RESPONSE_MISMATCH|APPROVAL_RECORD_LOCKED|LOCAL_RPC_UNAVAILABLE/);assert.deepEqual(flow.attemptStates,saved);}
    await assert.rejects(flow.reconcile('SET',h(998)),/APPROVAL_HASH_LOCKED/);assert.deepEqual(flow.attemptStates,saved);
    await assert.rejects(flow.approve('SET'),/APPROVAL_RECONCILIATION_REQUIRED/);assert.equal(browser.walletCalls(),0);
  }
});

test('approval flow keeps its latest existing finalized block and permits a newer observation of changed current allowance',async()=>{
  const x=await originalAuthorizationFixture(),browser=localSession(x);let response:unknown={record:record(x,'CONFIRMED'),receipt:finalReceipt(x)};
  const port:ApprovalPort={preflight:async()=>{throw new Error('UNEXPECTED_PREFLIGHT');},reserveApproval:async()=>{throw new Error('UNEXPECTED_RESERVATION');},reconcileApproval:async()=>structuredClone(response)};
  const flow=new AssetApprovalFlow(x.payload,subject,()=>true,browser.session,port,()=>1000n);await flow.reconcile('SET',hash);const saved=flow.attemptStates;
  for(const receipt of [finalReceipt(x,'CONFIRMED','204',h(204)),finalReceipt(x,'CONFIRMED','205',h(206))]){response={record:record(x,'CONFIRMED'),receipt};await assert.rejects(flow.reconcile('SET',hash),/APPROVAL_SNAPSHOT_STALE/);assert.deepEqual(flow.attemptStates,saved);}
  const receipt={...finalReceipt(x,'CONFIRMED','206',h(206)),currentAllowance:'0',exactAllowance:false};response={record:record(x,'CONFIRMED'),receipt};
  const latest=await flow.reconcile('SET',hash);assert.ok('receipt'in latest&&latest.receipt.status==='CONFIRMED'&&latest.receipt.currentAllowance==='0'&&!latest.receipt.exactAllowance);assert.deepEqual(flow.attemptStates,saved);
  response={record:record(x,'CONFIRMED'),receipt:finalReceipt(x)};await assert.rejects(flow.reconcile('SET',hash),/APPROVAL_SNAPSHOT_STALE/);assert.deepEqual(flow.attemptStates,saved);assert.equal(browser.walletCalls(),0);
});
