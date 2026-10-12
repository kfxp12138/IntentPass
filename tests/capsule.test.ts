import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {encryptCapsule,decryptCapsule,exportCapsule,importCapsule,namespaceSalt,type PrfSource} from '../packages/capsule/src/crypto.js';
import {memoryNamespace,authorizationNamespace,CapsuleFileSchema} from '../packages/capsule/src/format.js';
import {MeraPrfSource,createCapsulePasskey} from '../packages/capsule/src/mera.js';
import {CapsuleStore} from '../packages/storage/src/capsule-store.js';
import {createApp} from '../apps/web/src/server.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import type {WebAuthnClient} from '@category-labs/mera';
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),a='0x'+'1'.repeat(40);
const payload={schemaVersion:1,kind:'memory',policy:{schemaVersion:1,taskId:h(1),datasetHash:h(2),action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'15',allowedAsset:a,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'},evidence:{schemaVersion:1,taskText:'PRIVATE TASK MUST NEVER APPEAR IN STORAGE',documents:[{id:'private-doc',subjectQuoteId:h(3),text:'PRIVATE DOCUMENT CONTENT'}]}};
const ref={rpId:'localhost',credentialId:'AQ'},namespace=memoryNamespace('agent-1');
const metadata=(revision='1',objectId=h(10))=>({namespace,objectId,revision});
function localPrf(seed='LOCAL TEST ONLY'):{source:PrfSource;outputs:Uint8Array[]} {
  const outputs:Uint8Array[]=[];
  return {outputs,source:{evaluate:async salt=>{const result=new Uint8Array(createHmac('sha256',seed).update(salt).digest());outputs.push(result);return result;}}};
}
test('WebCrypto capsules round-trip export; IVs are fresh, keys are cleared and plaintext never exported',async()=>{
  const p=localPrf(),one=await encryptCapsule(payload,metadata(),ref,p.source),two=await encryptCapsule(payload,metadata(),ref,p.source);
  assert.notEqual(one.capsule.iv,two.capsule.iv);assert.notEqual(one.capsule.ciphertext,two.capsule.ciphertext);
  const text=exportCapsule(one);assert.ok(!text.includes(payload.evidence.taskText));assert.ok(!text.includes('PRIVATE DOCUMENT CONTENT'));
  assert.deepEqual(await decryptCapsule(importCapsule(text),p.source),payload);assert.ok(p.outputs.every(value=>value.every(x=>x===0)));
  await assert.rejects(encryptCapsule({...payload,privateKey:'FORBIDDEN'},metadata(),ref,p.source));
  assert.throws(()=>importCapsule('x'.repeat(1500001)));
});
test('namespace, RP, credential, object, revision, IV and ciphertext changes fail authentication',async()=>{
  const p=localPrf(),file=await encryptCapsule(payload,metadata(),ref,p.source);
  const changes=[{...file,keyReference:{...ref,rpId:'example.com'}},{...file,keyReference:{...ref,credentialId:'Ag'}},...[
    {namespace:memoryNamespace('agent-2')},{objectId:h(11)},{revision:'2'},{iv:'AAAAAAAAAAAAAAAA'},
    {ciphertext:(file.capsule.ciphertext.startsWith('A')?'B':'A')+file.capsule.ciphertext.slice(1)},
  ].map(change=>({...file,capsule:{...file.capsule,...change}}))];
  for(const changed of changes)await assert.rejects(decryptCapsule(changed,p.source),/CAPSULE_AUTH_FAILED/);
  await assert.rejects(decryptCapsule(file,localPrf('OTHER PASSKEY').source),/CAPSULE_AUTH_FAILED/);
  assert.notDeepEqual(await namespaceSalt(namespace),await namespaceSalt(authorizationNamespace(h(10))));
  assert.ok(p.outputs.every(value=>value.every(x=>x===0)));
});
test('actual Mera SDK pins credential, RP and namespace salt and requires user verification',async()=>{
  let calls=0;const salt=await namespaceSalt(namespace);
  const client:WebAuthnClient={createCredential:async request=>{assert.equal(request.userVerification,'required');assert.equal(request.residentKey,'required');assert.equal(request.user.id.length,32);return {credentialId:new Uint8Array([1]),prfEnabled:true,prfOutput:new Uint8Array(32).fill(7)};},getCredential:async request=>{calls++;assert.equal(request.rpId,'localhost');assert.equal(request.userVerification,'required');assert.deepEqual(request.allowCredential?.credentialId,new Uint8Array([1]));assert.deepEqual(request.prfSalt,salt);return {credentialId:new Uint8Array([1]),prfOutput:new Uint8Array(32).fill(7)};}};
  assert.deepEqual(await createCapsulePasskey('localhost',{name:'local-test',displayName:'Local test'},namespace,client),ref);
  const file=await encryptCapsule(payload,metadata(),ref,new MeraPrfSource(ref,client));
  assert.deepEqual(await decryptCapsule(file,new MeraPrfSource(ref,client)),payload);assert.equal(calls,2);
  const unavailable={...client,getCredential:async()=>({credentialId:new Uint8Array([1])})};
  await assert.rejects(new MeraPrfSource(ref,unavailable).evaluate(salt),/PRF_UNSUPPORTED/);
  for(const [name,code] of [['NotAllowedError','PASSKEY_CANCELLED'],['SecurityError','RPID_MISMATCH']]) {
    await assert.rejects(new MeraPrfSource(ref,{...client,getCredential:async()=>{throw new DOMException('private platform details',name);}}).evaluate(salt),new RegExp(code));
  }
});
test('durable ciphertext store isolates owners and CAS, preserves history and rejects IV reuse',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'intentpass-capsule-')),path=join(dir,'capsules.db'),one=new CapsuleStore(path),two=new CapsuleStore(path),p=localPrf();
  try {
    const v1=await encryptCapsule(payload,metadata(),ref,p.source),v2=await encryptCapsule(payload,metadata('2'),ref,p.source);
    one.put('alice',v1,'0');assert.equal(two.get('bob',h(10)),undefined);assert.deepEqual(two.get('alice',h(10)),v1);
    assert.throws(()=>two.put('alice',v2,'0'),/CONFLICT/);two.put('alice',v2,'1');
    assert.deepEqual(one.put('alice',v1,'0'),v1);assert.deepEqual(one.get('alice',h(10)),v2);
    assert.throws(()=>one.put('alice',{...v2,capsule:{...v2.capsule,revision:'3',iv:v1.capsule.iv}},'2'),/CONFLICT/);
    const switched=await encryptCapsule(payload,metadata('3'),{...ref,credentialId:'Ag'},p.source);assert.throws(()=>one.put('alice',switched,'2'),/CONFLICT/);
    one.put('bob',v1,'0');assert.deepEqual(two.get('bob',h(10)),v1);
    one.close();two.close();const reopened=new CapsuleStore(path);assert.deepEqual(reopened.get('alice',h(10)),v2);reopened.close();
    assert.ok(!readFileSync(path).includes(Buffer.from(payload.evidence.taskText)));
  }finally{try{one.close();}catch{}try{two.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
test('authorization namespace is bound to original order and permits only immutable revision one',async()=>{
  const file=await encryptCapsule(payload,metadata(),ref,localPrf().source);
  const auth={...file,capsule:{...file.capsule,namespace:authorizationNamespace(h(10))}};
  assert.ok(CapsuleFileSchema.safeParse(auth).success);
  assert.ok(!CapsuleFileSchema.safeParse({...auth,capsule:{...auth.capsule,revision:'2'}}).success);
  assert.ok(!CapsuleFileSchema.safeParse({...auth,capsule:{...auth.capsule,objectId:h(11)}}).success);
  const store=new CapsuleStore(':memory:');try{store.put('alice',auth,'0');assert.throws(()=>store.put('alice',{...auth,capsule:{...auth.capsule,iv:'AAAAAAAAAAAAAAAA'}},'0'),/CONFLICT/);}finally{store.close();}
  // Opaque storage validates headers, never pretends to authenticate the client ciphertext.
  await assert.rejects(decryptCapsule(auth,localPrf().source),/CAPSULE_AUTH_FAILED/);
});
test('capsule HTTP authenticates first; owner spoofing and overwrite fail, other owners see no record',async()=>{
  const store=new CapsuleStore(':memory:'),file=await encryptCapsule(payload,metadata(),ref,localPrf().source);
  const app=await createApp({dependencyPrebundling:false,capsuleApi:{store,auth:{authenticate:async token=>{if(token==='invalid')throw new AuthenticationRejected();return {subject:token,wallets:[]};}}}});
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const addr=app.server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}/api/capsules/${h(10)}`;
  const put=(body:unknown,token='alice')=>fetch(url,{method:'PUT',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const get=(token:string)=>fetch(url,{headers:{authorization:`Bearer ${token}`}});
  try {
    assert.equal((await fetch(url)).status,401);assert.equal((await put({bad:true},'invalid')).status,401);
    assert.equal((await put({expectedRevision:'0',file,owner:'bob'})).status,400);
    assert.equal((await put({expectedRevision:'0',file})).status,200);assert.equal((await get('bob')).status,404);
    const response=await get('alice');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{file});
    assert.equal((await put({expectedRevision:'0',file:{...file,capsule:{...file.capsule,iv:'AAAAAAAAAAAAAAAA'}}})).status,409);
    assert.equal((await put({expectedRevision:'0',file:{...file,capsule:{...file.capsule,objectId:h(11)}}})).status,400);
    assert.equal((await put({garbage:'x'.repeat(1500001)})).status,413);
  }finally{await app.close();store.close();}
});
