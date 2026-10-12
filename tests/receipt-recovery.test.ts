import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {PrivyClient} from '@privy-io/node';
import {type PublicClient,keccak256,type Hex} from 'viem';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {ReviewStore} from '../packages/storage/src/review-store.js';
import {ReceiptStore} from '../packages/storage/src/receipt-store.js';
import {PrivyReceiptSigner,receiptPolicy} from '../packages/adapters/src/privy-receipt-signer.js';
import {ReviewService} from '../apps/web/src/services/review.js';
import {ReceiptRecoveryService} from '../apps/web/src/services/receipt-recovery.js';
import {receiptRecoveryGuard} from '../apps/web/src/receipt-recovery-guard.js';
import {ReviewRequestSchema} from '../packages/protocol/src/draft.js';
import {ReceiptRecoveryResponseSchema} from '../packages/protocol/src/receipt-recovery.js';
import {UnsignedReceiptSchema,receiptTypedData,receiptHash,contextHash,quoteTypedData} from '../packages/protocol/src/index.js';
import {committeeHash} from '../packages/protocol/src/escrow.js';
import {PurchaseFlow} from '../apps/web/src/purchase-flow.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {createApp} from '../apps/web/src/server.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import type {EscrowDeployment} from '../packages/protocol/src/escrow-read.js';
async function fixture(){
  const f=await purchaseEvidenceFixture();await f.flow.catalog();await f.flow.propose([f.entry.quote.quoteId]);f.deployment.chainId='10143';
  f.session.configuration=async()=>f.configuration;
  f.entry.quote.expiresAt='5000';
  const {signature:_oldQuoteSignature,...unsignedQuote}=f.entry.quote;f.entry.quote.signature=await f.seller.signTypedData(quoteTypedData(unsignedQuote,{chainId:'10143',arbiter:f.deployment.arbiter}));
  const {policy,intent,evidence}=f.flow.draft!,request=ReviewRequestSchema.parse({policy,intent:{...intent,chainId:'10143'},quote:f.entry.quote,evidence});
  const dir=mkdtempSync(join(tmpdir(),'intentpass-receipt-recovery-')),journal=new ReviewStore(join(dir,'reviews.db')),store=new ReceiptStore(join(dir,'receipts.db'));
  const deployment={chainId:f.deployment.chainId,arbiter:f.deployment.arbiter,asset:f.deployment.asset,gate:f.deployment.asset,reviewer:f.reviewer.address,committeeHash:committeeHash(f.deployment.committee)} as EscrowDeployment;
  const rule=f.configuration.purchaseRule,c={chainId:f.deployment.chainId as '10143',arbiter:f.deployment.arbiter,address:f.reviewer.address,model:f.model,questionConfigHash:rule.questionConfigHash,walletId:'local-reviewer',policyId:'local-policy',signerId:'local-authority',authorizationPrivateKey:'LOCAL_UNUSED'};
  const wallet={id:c.walletId,chain_type:'ethereum',address:c.address,owner_id:c.signerId,policy_ids:[c.policyId],additional_signers:[]},remotePolicy={...receiptPolicy({chainId:c.chainId,arbiter:c.arbiter,address:c.address,model:c.model,questionConfigHash:c.questionConfigHash}),id:c.policyId};let calls=0,models=0,guards=0,lose=false,deny=false;
  const client={wallets:()=>({get:async()=>wallet,ethereum:()=>({signTypedData:async(_id:string,input:{params:{typed_data:{message:unknown}}})=>{calls++;if(lose)throw Error('private diagnostics');const raw=input.params.typed_data.message as Record<string,unknown>,r=UnsignedReceiptSchema.parse({...raw,schemaVersion:Number(raw.schemaVersion)});return {encoding:'hex',signature:await f.reviewer.signTypedData(receiptTypedData(r,{chainId:c.chainId,arbiter:c.arbiter}))};}})}),policies:()=>({get:async()=>remotePolicy})} as unknown as PrivyClient;
  const signer=new PrivyReceiptSigner(client,c,store,f.clock),answer={type:'choice' as const,choice:'SUPPORTED' as const,confidence:1,probabilities:{SUPPORTED:1,INSUFFICIENT:0,CONTRADICTED:0}};
  const review=new ReviewService({model:f.model,evaluate:async()=>{models++;return {model:f.model,answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:20,output_tokens:3}};}},deployment,rule.minConfidence,signer,f.clock,journal);
  const original=await review.review(request,f.principal());assert.ok(original.source==='JEV'&&original.executable,JSON.stringify(original));const {signature,...unsigned}=original.receipt,rootHash=receiptHash(unsigned,{chainId:c.chainId,arbiter:c.arbiter});
  const recovery=new ReceiptRecoveryService(journal,store,signer,deployment,rule,async()=>{guards++;if(deny)throw Error('blocked chain');},f.clock);
  const input=(confirmation=false,previousReceiptHash=rootHash)=>({request,confirmation,...(confirmation?{previousReceiptHash}:{})});
  f.port.recoverReceipt=input=>recovery.recover(input,f.principal());
  return {...f,dir,request,journal,store,deployment,c,client,signer,original,rootHash,recovery,input,counts:()=>({calls,models,guards}),lose:()=>{lose=true;},deny:()=>{deny=true;},cleanup:()=>{journal.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('expired receipt is read as metadata; only explicit confirmation appends one same-context successor without another model call',async()=>{
  const f=await fixture();try{
    assert.equal((await f.recovery.recover(f.input(true),f.principal())).status,'SIGNED');assert.deepEqual(f.counts(),{calls:1,models:1,guards:0});
    f.setTime(1300n);const old=await f.recovery.recover(f.input(),f.principal());assert.ok(old.status==='SIGNED');assert.deepEqual(old.receipt,f.original.receipt);assert.equal(f.counts().calls,1);
    const renewed=await f.recovery.recover(f.input(true),f.principal());assert.ok(renewed.status==='SIGNED');assert.equal(renewed.receipt.expiresAt,'1600');assert.equal(renewed.receipt.contextHash,contextHash(f.request.intent));assert.deepEqual(renewed.originalReceipt,f.original.receipt);assert.equal(f.counts().models,1);assert.equal(f.counts().calls,2);
    const key=f.journal.key((await import('../apps/web/src/services/review-key.js')).reviewSemanticInput(f.request,f.model,f.configuration.purchaseRule.questionConfigHash));assert.deepEqual(f.journal.get(key)?.result,f.original);
    const root=f.store.get({chainId:f.c.chainId,arbiter:f.c.arbiter},f.original.receipt.contextHash)!;assert.equal(root.receiptHash,f.rootHash);assert.equal(root.signatureHash,keccak256(f.original.receipt.signature as Hex));
    assert.deepEqual(await f.recovery.recover(f.input(true),f.principal()),renewed);assert.equal(f.counts().calls,2);
    f.setTime(1600n);const next=await f.recovery.recover(f.input(true,renewed.receiptHash as Hex),f.principal());assert.ok(next.status==='SIGNED');assert.equal(next.receipt.expiresAt,'1900');assert.equal(f.counts().calls,3);assert.equal(f.counts().models,1);
  }finally{f.cleanup();}
});
test('concurrent services and reopened receipt store preserve one successor and no duplicate provider request',async()=>{
  const f=await fixture(),other=new ReceiptStore(join(f.dir,'receipts.db'));try{
    f.setTime(1300n);const rival=new ReceiptRecoveryService(f.journal,other,new PrivyReceiptSigner(f.client,f.c,other,f.clock),f.deployment,f.configuration.purchaseRule,async()=>{},f.clock);
    await Promise.all([f.recovery.recover(f.input(true),f.principal()),rival.recover(f.input(true),f.principal()),f.recovery.recover(f.input(true),f.principal())]);assert.equal(f.counts().calls,2);assert.equal(f.counts().models,1);
    const replay=await rival.recover(f.input(true),f.principal());assert.ok(replay.status==='SIGNED');assert.equal(replay.receipt.expiresAt,'1600');assert.equal(f.counts().calls,2);
    const db=new DatabaseSync(join(f.dir,'receipts.db'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM receipt_renewals').get()!.n,1);}finally{db.close();}
  }finally{other.close();f.cleanup();}
});
test('lost renewal response remains UNKNOWN across connections and later expiry; root is unchanged and cannot bypass the unknown successor',async()=>{
  const f=await fixture();try{
    f.setTime(1300n);f.lose();const result=await f.recovery.recover(f.input(true),f.principal());assert.equal(result.status,'UNKNOWN');assert.equal(f.counts().calls,2);
    f.setTime(1700n);assert.equal((await f.recovery.recover(f.input(true),f.principal())).status,'UNKNOWN');assert.equal(f.counts().calls,2);assert.equal(f.counts().models,1);
    const db=new DatabaseSync(join(f.dir,'receipts.db'),{readOnly:true});try{assert.equal(db.prepare('SELECT status FROM receipt_attempts').get()!.status,'SIGNED');assert.equal(db.prepare('SELECT status FROM receipt_renewals').get()!.status,'UNKNOWN');}finally{db.close();}
    assert.equal(readFileSync(join(f.dir,'receipts.db')).includes(Buffer.from('private diagnostics')),false);
  }finally{f.cleanup();}
});
test('owner, exact request, frozen decision, chain guard, unknown root and original quote/deadline bounds are enforced before new signatures',async()=>{
  const f=await fixture();try{
    f.setTime(1300n);const stranger={subject:'stranger',wallets:[]};assert.equal((await f.recovery.recover(f.input(true),stranger)).status,'BLOCKED');
    for(const changed of [{intent:{...f.request.intent,price:'99'}},{intent:{...f.request.intent,orderId:'0x'+'ab'.repeat(32)}},{policy:{...f.request.policy,budget:'99'}},{evidence:{...f.request.evidence,taskText:'changed'}}])assert.equal((await f.recovery.recover({...f.input(true),request:{...f.request,...changed}},f.principal())).status,'BLOCKED');
    f.deny();assert.equal((await f.recovery.recover(f.input(true),f.principal())).status,'BLOCKED');assert.equal(f.counts().calls,1);assert.equal(f.counts().models,1);
    f.setTime(BigInt(f.request.intent.deliveryDeadline));const expired=await f.recovery.recover(f.input(true),f.principal());assert.equal(expired.status,'BLOCKED');assert.ok('code'in expired&&expired.code==='ORIGINAL_QUOTE_OR_DELIVERY_EXPIRED');assert.equal(f.counts().calls,1);
  }finally{f.cleanup();}
});
test('browser restores the exact committed candidate and old history without planner/model calls, then prepares only with a valid explicitly recovered receipt',async()=>{
  const f=await fixture();try{
    f.setTime(1300n);const flow=new PurchaseFlow(f.task,f.session,f.port,f.clock);await flow.resumeOriginal({format:'IntentPass.OriginalCandidate.v1',intent:f.request.intent,quoteId:f.request.quote.quoteId});assert.equal(flow.canReview,false);assert.equal(flow.draft!.intent.orderId,f.request.intent.orderId);assert.equal(flow.reviewHistory.length,1);
    await assert.rejects(flow.prepare('1','1400'));assert.equal(f.counts().models,1);await flow.recoverReceipt(true);const prepared=await flow.prepare('1','1500');assert.equal(prepared.payload.intent.orderId,f.request.intent.orderId);assert.equal(prepared.payload.grant.deadline,'1500');assert.equal(prepared.payload.grant.maxUses,1);assert.equal(f.counts().calls,2);assert.equal(f.counts().models,1);
    await assert.rejects(flow.resumeOriginal({format:'IntentPass.OriginalCandidate.v1',intent:f.request.intent,quoteId:f.request.quote.quoteId}),/ALREADY_PRESENT/);
    const wrong=new PurchaseFlow(f.task,f.session,f.port,f.clock);await assert.rejects(wrong.resumeOriginal({format:'IntentPass.OriginalCandidate.v1',intent:{...f.request.intent,purchaseEvidenceCommitment:'0x'+'ab'.repeat(32)},quoteId:f.request.quote.quoteId}),/EVIDENCE_MISMATCH/);
  }finally{f.cleanup();}
});
test('authenticated API and SDK preserve expired receipt metadata, validate successors and reject unauthenticated or wrong-owner requests',async()=>{
  const f=await fixture(),auth={authenticate:async(token:string)=>{if(token==='stranger')return {subject:'stranger',wallets:[]};if(token!=='local')throw new AuthenticationRejected();return f.principal();}},app=await createApp({dependencyPrebundling:false,browserApi:{auth,configuration:f.configuration},receiptRecoveryApi:{auth,service:f.recovery}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  try{f.setTime(1300n);const client=new PurchaseClient(base,async()=>'local',undefined,f.clock);const old=await client.recoverReceipt(f.input());assert.ok(old.status==='SIGNED');assert.equal(old.receipt.expiresAt,'1300');const renewed=await client.recoverReceipt(f.input(true));assert.ok(renewed.status==='SIGNED');assert.equal(renewed.receipt.expiresAt,'1600');assert.equal(f.counts().models,1);
    assert.equal((await new PurchaseClient(base,async()=>'stranger',undefined,f.clock).recoverReceipt(f.input(true))).status,'BLOCKED');await assert.rejects(new PurchaseClient(base,async()=>'invalid',undefined,f.clock).recoverReceipt(f.input()));
    const noAuth=await fetch(base+'/api/intent/receipt-recovery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.input(true))});assert.equal(noAuth.status,401);assert.equal(f.counts().calls,2);
    assert.ok(ReceiptRecoveryResponseSchema.safeParse(renewed).success);
  }finally{await app.close();f.cleanup();}
});
test('production guard checks both finalized and latest original order and blocks every persisted funding attempt',async()=>{
  const f=await fixture(),path=join(f.dir,'funding.db'),db=new DatabaseSync(path);db.exec('CREATE TABLE funding_attempts(key TEXT PRIMARY KEY)');let registered=false,reads=0;
  const block=(number:bigint)=>({number,hash:('0x'+number.toString(16).padStart(64,'0')) as Hex,timestamp:1300n});
  const client={getChainId:async()=>Number(f.deployment.chainId),getBlock:async(input:{blockTag?:string;blockNumber?:bigint})=>block(input.blockNumber??(input.blockTag==='latest'?101n:100n)),readContract:async(input:{functionName:string})=>{reads++;switch(input.functionName){case 'asset':return f.deployment.asset;case 'eligibility':return f.deployment.gate;case 'reviewer':return f.deployment.reviewer;case 'committeeHash':return f.deployment.committeeHash;case 'orders':return ['0x'+'00'.repeat(32),...Array(3).fill('0x'+'00'.repeat(20)),0n,0n,0n,0n,'0x'+'00'.repeat(32),'0x'+'00'.repeat(32),'0x'+'00'.repeat(32),0,registered?1:0];default:return 0n;}}} as unknown as PublicClient;
  try{const guard=receiptRecoveryGuard(client,f.deployment,path,()=>1300n);await guard(f.request,1300n);registered=true;await assert.rejects(guard(f.request,1300n));registered=false;await assert.rejects(guard(f.request,1301n));const before=reads;db.prepare('INSERT INTO funding_attempts VALUES(?)').run(`${f.deployment.chainId}:${f.deployment.arbiter.toLowerCase()}:${f.request.intent.orderId}`);await assert.rejects(guard(f.request,1300n),/SUBMISSION_EXISTS/);assert.equal(reads,before);}finally{db.close();f.cleanup();}
});
test('expired delivery window can only start a user-confirmed task revision after chain checks; it issues no replacement receipt and preserves original task ID salt and attempts',async()=>{
  const f=await fixture();try{
    const flow=new PurchaseFlow(f.task,f.session,f.port,f.clock);await flow.resumeOriginal({format:'IntentPass.OriginalCandidate.v1',intent:f.request.intent,quoteId:f.request.quote.quoteId});
    await assert.rejects(flow.rescheduleOriginal(false,()=>{}),/CONFIRMATION_REQUIRED/);f.setTime(1300n);await assert.rejects(flow.rescheduleOriginal(true,()=>{}),/WINDOW_STILL_OPEN/);
    f.setTime(BigInt(f.request.intent.deliveryDeadline));const before=structuredClone(f.task()),history=flow.reviewHistory;
    const updated=await flow.rescheduleOriginal(true,task=>{const current=f.task();current.policy=task.policy;current.evidence=task.evidence as typeof current.evidence;});
    assert.equal(updated.policy.taskId,before.policy.taskId);assert.deepEqual(updated.taskInput,before.taskInput);assert.equal(updated.policy.version,String(BigInt(before.policy.version)+1n));assert.ok(updated.evidence?.schemaVersion===2&&before.evidence.schemaVersion===2);assert.equal(updated.evidence.salt,before.evidence.salt);assert.ok(updated.evidence.taskText.includes('30分钟'));assert.deepEqual(flow.reviewHistory,history);assert.equal(flow.draft,undefined);assert.equal(f.counts().models,1);assert.equal(f.counts().calls,1);
  }finally{f.cleanup();}
});
