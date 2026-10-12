import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,chmodSync,writeFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {ReviewStore} from '../packages/storage/src/review-store.js';
import {ReviewService} from '../apps/web/src/services/review.js';
import {reviewSemanticInput} from '../apps/web/src/services/review-key.js';
import {ReviewRequestSchema} from '../packages/protocol/src/draft.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
import {contextHash,receiptTypedData,quoteTypedData,policyHash,committeeHash} from '../packages/protocol/src/index.js';
import {createApp} from '../apps/web/src/server.js';
import {configuredPurchaseApis} from '../apps/web/src/configured-purchase-api.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {readTestHash,readTestAddress} from './support/original-authorization.js';
import type {ReviewJournal} from '../packages/storage/src/review-journal.js';
import type {EscrowDeployment} from '../packages/protocol/src/escrow-read.js';
import type {Address} from 'viem';
function response(choice:'SUPPORTED'|'INSUFFICIENT'|'CONTRADICTED'){
  const answer={type:'choice' as const,choice,confidence:1,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0}};
  return {model:'jev-1.13.0',answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:12,output_tokens:3}};
}
async function fixture(){
  const f=await purchaseEvidenceFixture();await f.flow.catalog();await f.flow.propose([f.entry.quote.quoteId]);const request=ReviewRequestSchema.parse(f.flow.draft&&{policy:f.flow.draft.policy,intent:f.flow.draft.intent,quote:f.flow.draft.quote,evidence:f.flow.draft.evidence}),directory=mkdtempSync(join(tmpdir(),'intentpass-review-journal-')),path=join(directory,'review.db');
  const deployment:EscrowDeployment={chainId:f.deployment.chainId,arbiter:f.deployment.arbiter as Address,asset:f.deployment.asset as Address,reviewer:f.deployment.reviewer as Address,gate:f.deployment.asset as Address,committeeHash:committeeHash(f.deployment.committee)};
  let calls=0,signs=0,choice:'SUPPORTED'|'INSUFFICIENT'|'CONTRADICTED'='INSUFFICIENT',failure=false;
  const jev={model:f.model,evaluate:async()=>{calls++;if(failure)throw new Error('local private provider diagnostic');return response(choice);}},signer={address:f.reviewer.address,sign:async(r:Parameters<typeof receiptTypedData>[0],d:Parameters<typeof receiptTypedData>[1])=>{signs++;return f.reviewer.signTypedData(receiptTypedData(r,d));}};
  return {...f,deployment,request,directory,path,jev,signer,counts:()=>({calls,signs}),choice:(value:typeof choice)=>{choice=value;},fail:()=>{failure=true;},service:(journal:ReviewJournal)=>new ReviewService(jev,deployment,.9,signer,f.clock,journal),cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
function worker(mode:string,input:unknown){
  const child=spawn(process.execPath,['--experimental-sqlite','--import','tsx','tests/support/review-worker.ts',mode],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdin.end(JSON.stringify(input));
  let timer:ReturnType<typeof setTimeout>;const done=new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolve,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('LOCAL_REVIEW_WORKER_TIMEOUT'));},15000);child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));}).finally(()=>clearTimeout(timer));
  async function until(phase:string){await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('LOCAL_REVIEW_PHASE_TIMEOUT'));},10000);const check=()=>{if(stdout.includes(phase)){clearTimeout(timer);child.stdout.off('data',check);resolve();}};child.stdout.on('data',check);void done.then(()=>{clearTimeout(timer);child.stdout.off('data',check);if(!stdout.includes(phase))reject(new Error('LOCAL_REVIEW_PHASE_MISSING'));},reject);check();});}
  return {child,done,until};
}
test('trusted background job namespace isolates an approved new purchase while preserving each original decision lock',async()=>{
  const f=await fixture(),store=new ReviewStore(f.path);try{f.choice('SUPPORTED');const legacy=f.service(store),old=await legacy.review(f.request,f.principal());assert.ok(old.source==='JEV'&&old.executable);const next=structuredClone(f.request);next.intent.orderId=readTestHash(765);
    assert.deepEqual(await legacy.review(next,f.principal()),{decision:'ABSTAIN',source:'DEPENDENCY',code:'REVIEW_VERSION_ALREADY_REQUESTED'});assert.equal(f.counts().calls,1);
    const id='00000000-0000-4000-8000-000000000001',background=new ReviewService(f.jev,f.deployment,.9,f.signer,f.clock,store,id);f.choice('INSUFFICIENT');const result=await background.review(next,f.principal());assert.equal(result.decision,'ABSTAIN');assert.equal(f.counts().calls,2);f.choice('SUPPORTED');assert.deepEqual(await background.review(next,f.principal()),result);const changed=structuredClone(next);changed.intent.orderId=readTestHash(766);assert.deepEqual(await background.review(changed,f.principal()),{decision:'ABSTAIN',source:'DEPENDENCY',code:'REVIEW_VERSION_ALREADY_REQUESTED'});assert.equal(f.counts().calls,2);assert.deepEqual(await legacy.review(f.request,f.principal()),old);
    assert.throws(()=>new ReviewService(f.jev,f.deployment,.9,f.signer,f.clock,store,'untrusted-namespace'));
  }finally{store.close();f.cleanup();}
});
test('authenticated HTTP replays the exact original decision and receipt after SQLite reconnect without gambling or re-signing',async()=>{
  for(const choice of ['INSUFFICIENT','CONTRADICTED','SUPPORTED'] as const){const f=await fixture();f.choice(choice);let store=new ReviewStore(f.path);const principal=f.principal(),auth={authenticate:async(token:string)=>{if(token==='stranger')return {subject:'other',wallets:[readTestAddress(77)]};if(token!=='local-review-token')throw new AuthenticationRejected();return principal;}},app=await createApp({dependencyPrebundling:false,browserApi:{auth,configuration:f.configuration},reviewApi:{auth,service:f.service(store)}});
    await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`,client=new PurchaseClient(url,async()=>'local-review-token',undefined,f.clock);
    try{
      const first=await client.review(f.request),second=await client.review(f.request);assert.deepEqual(second,first);assert.equal(first.decision,choice==='SUPPORTED'?'PASS':choice==='CONTRADICTED'?'REJECT':'ABSTAIN');assert.equal(f.counts().calls,1);assert.equal(f.counts().signs,choice==='SUPPORTED'?1:0);
      const stranger=await new PurchaseClient(url,async()=>'stranger',undefined,f.clock).review(f.request);assert.equal(stranger.source,'HARD_RULE');assert.equal(stranger.decision,'REJECT');assert.equal(f.counts().calls,1);
      await app.close();store.close();store=new ReviewStore(f.path);const restarted=f.service(store);assert.deepEqual(await restarted.review(f.request,principal),first);assert.equal(f.counts().calls,1);
      const key=store.key(reviewSemanticInput(f.request,f.model,restarted.questionHash)),record=store.get(key)!;assert.equal(record.status,'COMPLETE');assert.equal(record.evaluation?.decision,first.decision);assert.equal(record.contextHash,contextHash(f.request.intent));
      record.evaluation=null;assert.ok(store.get(key)?.evaluation);const dump=Buffer.concat([f.path,f.path+'-wal'].filter(existsSync).map(path=>{assert.equal(statSync(path).mode&0o077,0);return readFileSync(path);}));for(const privateText of [f.request.evidence.taskText,...f.request.evidence.documents.map(d=>d.text),principal.subject,'local-review-token'])assert.equal(dump.includes(Buffer.from(privateText)),false);
      assert.equal(statSync(f.path).mode&0o077,0);
      if(choice==='SUPPORTED'){f.setTime(900n);assert.deepEqual(await restarted.review(f.request,principal),{decision:'ABSTAIN',source:'DEPENDENCY',code:'REVIEW_TIME_INVALID'});f.setTime(1300n);const expired=await restarted.review(f.request,principal);assert.equal(expired.decision,'ABSTAIN');assert.ok('code'in expired);assert.equal(expired.code,'REVIEW_RECEIPT_EXPIRED');assert.deepEqual(store.get(key)?.result,first);assert.equal(f.counts().signs,1);}
    }finally{await app.close();store.close();f.cleanup();}
  }
});
test('changing order attempt salt deadlines or JSON order cannot re-evaluate a recorded version; new material and payment scope require fresh review',async()=>{
  const f=await fixture(),store=new ReviewStore(f.path),service=f.service(store);try{
    const first=await service.review(f.request,f.principal());assert.equal(first.decision,'ABSTAIN');f.choice('SUPPORTED');
    const changed=structuredClone(f.request);changed.evidence={...changed.evidence,schemaVersion:2,salt:readTestHash(987)};changed.intent={...changed.intent,orderId:readTestHash(988),attempt:'99',deliveryDeadline:'1800',settlementDeadline:'2500',purchaseEvidenceCommitment:purchaseEvidenceHash(changed.evidence)};
    const duplicate=await service.review(changed,f.principal());assert.deepEqual(duplicate,{decision:'ABSTAIN',source:'DEPENDENCY',code:'REVIEW_VERSION_ALREADY_REQUESTED'});assert.equal(f.counts().calls,1);assert.equal(f.counts().signs,0);
    assert.deepEqual(await service.review(Object.fromEntries(Object.entries(f.request).reverse()),f.principal()),first);
    assert.deepEqual(await service.review({...f.request,evidence:{...f.request.evidence,taskText:'Tamper without updating commitment.'}},f.principal()),{decision:'REJECT',source:'HARD_RULE',code:'EVIDENCE_COMMITMENT_MISMATCH'});assert.equal(f.counts().calls,1);
    const added=structuredClone(changed);added.evidence.documents.push(f.supplement());added.intent.purchaseEvidenceCommitment=purchaseEvidenceHash(added.evidence);const next=await service.review(added,f.principal());assert.ok(next.source==='JEV'&&next.executable);assert.equal(next.receipt.contextHash,contextHash(added.intent));assert.equal(f.counts().calls,2);
    const newAmount=structuredClone(added);newAmount.policy.budget='16';newAmount.quote.amount='11';const {signature:_signature,...unsignedQuote}=newAmount.quote;newAmount.quote.signature=await f.seller.signTypedData(quoteTypedData(unsignedQuote,{chainId:f.deployment.chainId,arbiter:f.deployment.arbiter}));newAmount.intent={...newAmount.intent,orderId:readTestHash(989),price:'11',policyHash:policyHash(newAmount.policy)};assert.equal((await service.review(newAmount,f.principal())).decision,'PASS');assert.equal(f.counts().calls,3);assert.equal(f.counts().signs,2);
  }finally{store.close();f.cleanup();}
});
test('five independent review service processes competing for one durable journal call the local model exactly once',async()=>{
  const f=await fixture();new ReviewStore(f.path).close();try{
    const processes=Array.from({length:5},(_,index)=>worker('race',{path:f.path,deployment:f.deployment,request:{...f.request,intent:{...f.request.intent,orderId:readTestHash(1000+index)}}}));const results=await Promise.all(processes.map(p=>p.done));
    const reports=results.map(result=>{assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);return JSON.parse(result.stdout.trim());});assert.equal(reports.reduce((count,result)=>count+result.calls,0),1);assert.equal(reports.reduce((count,result)=>count+result.signs,0),0);assert.ok(reports.every(result=>result.result.decision==='ABSTAIN'));
    const store=new ReviewStore(f.path);try{assert.equal((await f.service(store).review(f.request,f.principal())).decision,'ABSTAIN');assert.equal(f.counts().calls,0);}finally{store.close();}
  }finally{f.cleanup();}
});
test('actual process termination during model and receipt phases preserves pending or evaluated records across restart and forbids repeat calls',async()=>{
  for(const mode of ['pending','signing'] as const){const f=await fixture();new ReviewStore(f.path).close();const p=worker(mode,{path:f.path,deployment:f.deployment,request:f.request});try{
    await p.until(mode==='pending'?'MODEL_STARTED':'SIGNING_STARTED');p.child.kill('SIGTERM');const stopped=await p.done;assert.equal(stopped.code,null);assert.equal(stopped.signal,'SIGTERM');
    const store=new ReviewStore(f.path);try{const service=f.service(store),result=await service.review(f.request,f.principal()),record=store.get(store.key(reviewSemanticInput(f.request,f.model,service.questionHash)))!;assert.equal(record.status,mode==='pending'?'PENDING':'EVALUATED');assert.equal(record.evaluation?.decision,mode==='signing'?'PASS':undefined);assert.equal(record.result,null);assert.equal(result.decision,'ABSTAIN');assert.equal(result.source,'DEPENDENCY');assert.deepEqual(f.counts(),{calls:0,signs:0});}finally{store.close();}
  }finally{p.child.kill('SIGKILL');await p.done;f.cleanup();}}
});
test('unknown provider responses, disk failures and malformed records cannot trigger another model call or release unrecorded authority',async()=>{
  const f=await fixture(),store=new ReviewStore(f.path);try{
    const service=f.service(store);f.fail();const failed=await service.review(f.request,f.principal());assert.deepEqual(failed,{decision:'ABSTAIN',source:'DEPENDENCY',code:'JEV_UNAVAILABLE_OR_INVALID'});assert.deepEqual(await f.service(store).review(f.request,f.principal()),failed);assert.equal(f.counts().calls,1);assert.equal(JSON.stringify(store.get(store.key(reviewSemanticInput(f.request,f.model,service.questionHash)))).includes('private provider diagnostic'),false);
    const db=new DatabaseSync(f.path),key=store.key(reviewSemanticInput(f.request,f.model,service.questionHash));db.prepare('UPDATE review_requests SET record_json=? WHERE semantic_key=?').run('{"status":"COMPLETE"}',key);db.close();assert.deepEqual(await service.review(f.request,f.principal()),{decision:'ABSTAIN',source:'DEPENDENCY',code:'REVIEW_JOURNAL_UNAVAILABLE'});assert.equal(f.counts().calls,1);
  }finally{store.close();f.cleanup();}
  for(const phase of ['reserve','evaluated','finish'] as const){const g=await fixture(),journal=new ReviewStore(g.path);g.choice('SUPPORTED');const broken:ReviewJournal={key:input=>journal.key(input),get:key=>journal.get(key),reserve:(...args)=>journal.reserve(...args),evaluated:(...args)=>journal.evaluated(...args),finish:(...args)=>journal.finish(...args)};broken[phase]=()=>{throw new Error('private local disk diagnostic');};
    try{assert.deepEqual(await g.service(broken).review(g.request,g.principal()),{decision:'ABSTAIN',source:'DEPENDENCY',code:'REVIEW_JOURNAL_UNAVAILABLE'});assert.deepEqual(g.counts(),{calls:phase==='reserve'?0:1,signs:phase==='finish'?1:0});if(phase!=='reserve'){assert.equal((await g.service(journal).review(g.request,g.principal())).decision,'ABSTAIN');assert.equal(g.counts().calls,1);assert.equal(g.counts().signs,phase==='finish'?1:0);}}finally{journal.close();g.cleanup();}
  }
  for(const boundary of [1300n,999n]){const g=await fixture(),journal=new ReviewStore(g.path);g.choice('SUPPORTED');let reads=0;const clock=()=>++reads>=5?boundary:1000n,service=new ReviewService(g.jev,g.deployment,.9,g.signer,clock,journal);
    try{const result=await service.review(g.request,g.principal());assert.deepEqual(result,{decision:'ABSTAIN',source:'DEPENDENCY',code:boundary===1300n?'REVIEW_RECEIPT_EXPIRED':'REVIEW_TIME_INVALID'});assert.deepEqual(g.counts(),{calls:1,signs:1});const original=journal.get(journal.key(reviewSemanticInput(g.request,g.model,service.questionHash)))!;assert.equal(original.status,'COMPLETE');assert.equal(original.result?.decision,'PASS');assert.equal(original.evaluation?.decision,'PASS');}finally{journal.close();g.cleanup();}
  }
});
test('configured reviews require an explicit durable private journal and reject relative paths permissions symlinks and unusable configuration',async()=>{
  const f=await fixture();try{
    assert.throws(()=>new ReviewStore('relative.db'),/CONFIGURATION_INVALID/);assert.throws(()=>new ReviewStore(join(f.directory,'missing','review.db')),/CONFIGURATION_INVALID/);
    const publicFile=join(f.directory,'public.db');writeFileSync(publicFile,'');chmodSync(publicFile,0o644);assert.throws(()=>new ReviewStore(publicFile),/CONFIGURATION_INVALID/);
    const link=join(f.directory,'linked.db');symlinkSync(publicFile,link);assert.throws(()=>new ReviewStore(link),/CONFIGURATION_INVALID/);
    assert.throws(()=>configuredPurchaseApis({REVIEW_JOURNAL_DB_PATH:f.path},undefined),/CONFIGURATION_INVALID/);
    const browser={configuration:f.configuration,auth:{authenticate:async()=>f.principal()}};assert.throws(()=>configuredPurchaseApis({TYPESAFE_API_KEY:'local-only',JEV_MODEL:f.model,REVIEW_POLICY_PATH:join(f.directory,'absent-rule.json'),ELIGIBILITY_GATE_ADDRESS:f.deployment.gate},browser),/REVIEW_JOURNAL_CONFIGURATION_INVALID/);assert.equal(existsSync(f.path),false);
    const store=new ReviewStore(f.path);store.close();assert.equal(statSync(f.path).mode&0o777,0o600);
  }finally{f.cleanup();}
});
