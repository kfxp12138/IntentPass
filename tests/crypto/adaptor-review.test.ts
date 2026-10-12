import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generatePrivateKey} from 'viem/accounts';
import {keccak256,toHex,type Hex} from 'viem';
import {NativeEcdsaAdaptor} from '../../packages/adapters/src/ecdsa-adaptor.js';
import {reviewEvaluationHash,adaptorCandidateHash,type AdaptorCertificate} from '../../packages/protocol/src/adaptor-review.js';
import {AdaptorSessionStore} from '../../packages/storage/src/adaptor-session-store.js';
import {ReviewStore} from '../../packages/storage/src/review-store.js';
import {AdaptorReviewExperiment,verifyAdaptorCertificate} from '../../apps/web/src/services/adaptor-review-experiment.js';
import {applicationReviewSmokeCases} from '../../scripts/application-review-smoke.js';
import {adaptorSource,fileSha256} from '../../scripts/adaptor-runtime.js';
import type {JevResult} from '../../packages/adapters/src/jev-review.js';
const native=new NativeEcdsaAdaptor(),hex=(s:string)=>`0x${s}` as Hex;
const response=(choice:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'='SUPPORTED',confidence=1):JevResult=>{
  const item={type:'choice' as const,choice,confidence,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0}};
  return {model:'jev-1.13.0',answers:{service:{...item},purpose:{...item},provenance:{...item}},usage:{input_tokens:100,output_tokens:12}};
};
async function fixture(){
  const f=await applicationReviewSmokeCases(1000n),directory=mkdtempSync(join(tmpdir(),'intentpass-adaptor-test-'));
  const path=join(directory,'sessions.db'),journalPath=join(directory,'reviews.db');
  let store=new AdaptorSessionStore(path),journal=new ReviewStore(journalPath),now=1000n,calls=0,value=response(),fail=false,after:bigint|undefined,barrier:Promise<void>|undefined;
  const preSignerKey=generatePrivateKey(),attestorKey=generatePrivateKey();
  const jev={model:'jev-1.13.0',evaluate:async()=>{calls++;if(barrier)await barrier;if(after!==undefined)now=after;if(fail)throw Error('fixture unavailable');return structuredClone(value);}};
  const create=()=>new AdaptorReviewExperiment({preSignerKey,attestorKey,jev,deployment:f.deployment,minConfidence:.9,reviewJournal:journal,store,native,clock:()=>now});
  let flow=create();
  return {...f,input:f.cases[0].input,directory,path,get flow(){return flow;},get store(){return store;},calls:()=>calls,
    set:(v:JevResult)=>{value=v;},fail:()=>{fail=true;},time:(v:bigint)=>{now=v;},after:(v:bigint)=>{after=v;},pause:(p:Promise<void>)=>{barrier=p;},
    restart:()=>{flow.dispose();store.close();journal.close();store=new AdaptorSessionStore(path);journal=new ReviewStore(journalPath);flow=create();},
    cleanup:()=>{flow.dispose();store.close();journal.close();rmSync(directory,{recursive:true,force:true});}};
}
test('pinned DLC verification and extraction vectors, including invalid proofs and high-s recovery',()=>{
  const path='.tools/adaptor-source/ecdsa_adaptor.json';assert.equal(fileSha256(path),adaptorSource.vectorsSha256);
  const cases=JSON.parse(readFileSync(path,'utf8'));let checked=0;
  for(const c of cases){
    if(c.kind==='verification'){
      checked++;assert.equal(native.verify(hex(c.public_signing_key),hex(c.message_hash),hex(c.encryption_key),hex(c.adaptor_sig)),!c.error);
      if(!c.error){const completed=native.complete(hex(c.public_signing_key),hex(c.message_hash),hex(c.encryption_key),hex(c.adaptor_sig),hex(c.decryption_key));assert.equal(completed.slice(2,130),c.signature);assert.equal(native.extract(hex(c.encryption_key),hex(c.adaptor_sig),completed),hex(c.decryption_key));}
    }
    if(c.kind==='recovery'){
      checked++;if(c.error)assert.throws(()=>native.extract(hex(c.encryption_key),hex(c.adaptor_sig),hex(c.signature)));else assert.equal(native.extract(hex(c.encryption_key),hex(c.adaptor_sig),hex(c.signature)),hex(c.decryption_key));
    }
  }
  assert.equal(checked,6); // Serialization-only cases are covered by upstream C tests.
});
test('real adaptor signing binds message, signing key, adaptor point and secret witness',()=>{
  const key=generatePrivateKey(),witness=generatePrivateKey(),other=generatePrivateKey(),pub=native.publicKey(key),point=native.publicKey(witness),hash=keccak256(toHex('one exact purchase'));
  const pre=native.preSign(key,hash,point);assert.equal(native.verify(pub,hash,point,pre),true);
  assert.equal(native.verify(pub,keccak256(toHex('a different purchase')),point,pre),false);
  assert.equal(native.verify(native.publicKey(other),hash,point,pre),false);assert.equal(native.verify(pub,hash,native.publicKey(other),pre),false);
  assert.throws(()=>native.complete(pub,hash,point,pre,other));assert.throws(()=>native.complete(pub,hash,point,pre,keccak256(toHex('PASS'))));
  const completed=native.complete(pub,hash,point,pre,witness);assert.equal(native.extract(point,pre,completed),witness);
  assert.equal(native.verify(pub,hash,point,'0x'),false);assert.throws(()=>native.publicKey('0x'+'00'.repeat(32)));
});
test('prepare precedes JEV; PASS yields a verifiable result-bound certificate and one local acceptance',async()=>{
  const f=await fixture();try{
    const s=f.flow.prepare(f.input,f.principal);assert.equal(f.calls(),0);assert.equal(s.state,'PREPARED');assert.equal('certificate'in s,false);
    const done=await f.flow.complete(s.candidate.sessionId,f.input,f.principal);assert.equal(done.state,'COMPLETE');assert.ok(done.certificate);assert.equal(f.calls(),1);
    assert.equal(await verifyAdaptorCertificate(done.certificate,f.input,f.flow.trust,native,1000n),true);
    assert.equal(await verifyAdaptorCertificate({...done.certificate,releaseSignature:undefined},f.input,f.flow.trust,native,1000n),false);
    assert.ok(done.certificate.evaluation.source==='JEV');assert.equal(done.certificate.evaluation.executable,false);assert.equal('receipt'in done.certificate.evaluation,false);
    await f.flow.acceptOnce(s.candidate.sessionId,f.input,f.principal);await assert.rejects(f.flow.acceptOnce(s.candidate.sessionId,f.input,f.principal),/ALREADY_CONSUMED/);assert.equal(f.calls(),1);
    assert.equal(statSync(f.path).mode&0o777,0o600);
  }finally{f.cleanup();}
});
test('REJECT, ABSTAIN, low confidence, wrong model and provider failure cannot release a signature',async()=>{
  for(const outcome of [response('CONTRADICTED'),response('INSUFFICIENT'),response('SUPPORTED',.4),{...response(),model:'jev-other'},null]){
    const f=await fixture();try{if(outcome)f.set(outcome);else f.fail();const s=f.flow.prepare(f.input,f.principal),done=await f.flow.complete(s.candidate.sessionId,f.input,f.principal);assert.equal(done.state,'STOPPED');assert.equal(done.certificate,undefined);assert.notEqual(done.review?.decision,'PASS');assert.equal(f.calls(),1);f.restart();assert.deepEqual(await f.flow.complete(s.candidate.sessionId,f.input,f.principal),done);assert.equal(f.calls(),1);}finally{f.cleanup();}
  }
});
test('existing hard rules prevent release and unnecessary JEV calls; owner and input substitution rejected',async()=>{
  const f=await fixture();try{
    assert.throws(()=>f.flow.prepare(f.input,{subject:'other',wallets:[]}),/OWNER/);
    const bad=structuredClone(f.input);bad.intent.bond='1';const s=f.flow.prepare(bad,f.principal),done=await f.flow.complete(s.candidate.sessionId,bad,f.principal);assert.equal(done.state,'STOPPED');assert.equal(done.review?.source,'HARD_RULE');assert.equal(f.calls(),0);
    const good=f.flow.prepare(f.input,f.principal),changed=structuredClone(f.input);changed.evidence.taskText+=' changed';
    await assert.rejects(f.flow.complete(good.candidate.sessionId,changed,f.principal));await assert.rejects(f.flow.complete(good.candidate.sessionId,f.input,{subject:'other',wallets:[]}),/OWNER/);assert.equal(f.calls(),0);
  }finally{f.cleanup();}
});
test('tampered intent, result details, release, model, domain, keys and expiry all fail verification',async()=>{
  const f=await fixture();try{
    const s=f.flow.prepare(f.input,f.principal),done=await f.flow.complete(s.candidate.sessionId,f.input,f.principal),original=done.certificate!;
    const changes:((p:AdaptorCertificate)=>void)[]=[
      p=>{p.candidate.orderId=keccak256(toHex('another order'));},p=>{p.candidate.chainId='1';},p=>{p.candidate.expiresAt='1500';},
      p=>{p.candidate.modelId='jev-other';},p=>{p.candidate.questionConfigHash=keccak256(toHex('other rule'));},p=>{p.candidate.attestor=f.input.intent.buyer;},
      p=>{p.preSignature=hex('00'.repeat(162));},p=>{p.completedSignature=hex('00'.repeat(64)+'1b');},
      p=>{p.release.evaluationHash=keccak256(toHex('other answers'));},p=>{p.release.preSignatureHash=keccak256(toHex('other pre'));},
      p=>{p.release.evaluatedAt='999';},p=>{p.release.candidateHash=keccak256(toHex('other candidate'));},
      p=>{if(p.evaluation.source==='JEV')p.evaluation.answers.purpose.confidence=.99;},
      p=>{if(p.evaluation.source==='JEV'){p.evaluation.usage.output_tokens++;p.release.evaluationHash=reviewEvaluationHash(p.evaluation);}},
    ];
    for(const mutate of changes){const p=structuredClone(original);mutate(p);assert.equal(await verifyAdaptorCertificate(p,f.input,f.flow.trust,native,1000n),false);}
    const altered=structuredClone(f.input);altered.intent.payee=f.input.intent.buyer;assert.equal(await verifyAdaptorCertificate(original,altered,f.flow.trust,native,1000n),false);
    assert.equal(await verifyAdaptorCertificate(original,f.input,{...f.flow.trust,attestor:f.input.intent.buyer},native,1000n),false);
    assert.equal(await verifyAdaptorCertificate(original,f.input,f.flow.trust,native,1300n),false);
    const e=original.evaluation;assert.equal(reviewEvaluationHash(e),reviewEvaluationHash(Object.fromEntries(Object.entries(e).reverse())));
  }finally{f.cleanup();}
});
test('full evaluation hash binds all answers and exact confidence, probabilities and usage',async()=>{
  const f=await fixture();try{
    const s=f.flow.prepare(f.input,f.principal),done=await f.flow.complete(s.candidate.sessionId,f.input,f.principal),e=done.certificate!.evaluation;
    const reordered=JSON.parse(JSON.stringify(e));reordered.answers={provenance:reordered.answers.provenance,purpose:reordered.answers.purpose,service:reordered.answers.service};assert.equal(reviewEvaluationHash(reordered),reviewEvaluationHash(e));
    for(const k of ['service','purpose','provenance'] as const){const altered=structuredClone(e);assert.equal(altered.source,'JEV');if(altered.source!=='JEV')throw Error();altered.answers[k].confidence=1-Number.EPSILON;assert.notEqual(reviewEvaluationHash(altered),reviewEvaluationHash(e));}
    assert.notEqual(adaptorCandidateHash(s.candidate),adaptorCandidateHash({...s.candidate,sessionId:keccak256(toHex('different session'))}));
  }finally{f.cleanup();}
});
test('completed sessions survive reconnect without another model call; pending witness loss fails closed',async()=>{
  const f=await fixture();try{const s=f.flow.prepare(f.input,f.principal),done=await f.flow.complete(s.candidate.sessionId,f.input,f.principal);f.restart();assert.deepEqual(await f.flow.complete(s.candidate.sessionId,f.input,f.principal),done);assert.equal(f.calls(),1);assert.throws(()=>f.flow.prepare(f.input,f.principal),/ALREADY_EXISTS/);}finally{f.cleanup();}
  const g=await fixture();try{const s=g.flow.prepare(g.input,g.principal);g.restart();await assert.rejects(g.flow.complete(s.candidate.sessionId,g.input,g.principal),/RECONCILIATION/);assert.throws(()=>g.flow.prepare(g.input,g.principal),/ALREADY_EXISTS/);assert.equal(g.calls(),0);}finally{g.cleanup();}
});
test('expiry during review and a failed journal write leave no retriable witness or replacement session',async()=>{
  for(const mode of ['expiry','disk'] as const){const f=await fixture();try{const s=f.flow.prepare(f.input,f.principal);if(mode==='expiry')f.after(1300n);else f.store.finish=()=>{throw Error('disk fault');};await assert.rejects(f.flow.complete(s.candidate.sessionId,f.input,f.principal));assert.equal(f.store.get(s.candidate.sessionId)?.state,'RUNNING');f.time(1001n);await assert.rejects(f.flow.complete(s.candidate.sessionId,f.input,f.principal),/RECONCILIATION/);f.restart();await assert.rejects(f.flow.complete(s.candidate.sessionId,f.input,f.principal),/RECONCILIATION/);assert.equal(f.calls(),1);}finally{f.cleanup();}}
});
test('concurrent completions acquire one durable lease and cause only one provider call',async()=>{
  const f=await fixture();let release!:()=>void;f.pause(new Promise<void>(resolve=>{release=resolve;}));
  try{const s=f.flow.prepare(f.input,f.principal),first=f.flow.complete(s.candidate.sessionId,f.input,f.principal);await assert.rejects(f.flow.complete(s.candidate.sessionId,f.input,f.principal),/RECONCILIATION/);release();assert.equal((await first).state,'COMPLETE');assert.equal(f.calls(),1);}finally{release();f.cleanup();}
});
