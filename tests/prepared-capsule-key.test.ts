import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {PreparedCapsuleKey,decryptCapsule,type PrfSource} from '../packages/capsule/src/crypto.js';
import {authorizationNamespace} from '../packages/capsule/src/format.js';
import {AuthorizationBackup} from '../packages/capsule/src/authorization-backup.js';
import {originalAuthorizationFixture,readTestHash} from './support/original-authorization.js';
const ref={rpId:'localhost',credentialId:'AQ'};
function prf(){const outputs:Uint8Array[]=[],source:PrfSource={evaluate:async salt=>{const bytes=new Uint8Array(createHmac('sha256','LOCAL PLATFORM DOUBLE').update(salt).digest());outputs.push(bytes);return bytes;}};return {source,outputs};}
test('preparation wipes PRF bytes immediately and seals the signed original without another device operation',async()=>{
  const f=await originalAuthorizationFixture(),p=prf(),namespace=authorizationNamespace(f.payload.intent.orderId);
  const key=await PreparedCapsuleKey.prepare(namespace,ref,p.source);assert.ok(key.ready);assert.equal(p.outputs.length,1);assert.ok(p.outputs[0].every(b=>b===0));assert.ok(!JSON.stringify(key).includes('key'));
  const principal={subject:'local-buyer',wallets:[f.buyer.address]},backup=await AuthorizationBackup.create(f.payload,principal,f.deployment,async()=>principal,{put:async()=>{throw Error('NO_STORAGE');},get:async()=>{throw Error('NO_STORAGE');}});
  const file=await backup.seal(ref,key);assert.equal(key.ready,false);assert.equal(p.outputs.length,1);assert.deepEqual(await decryptCapsule(file,p.source),f.payload);
  await assert.rejects(key.encrypt(f.payload,{namespace,objectId:f.payload.intent.orderId,revision:'1'},ref),/PREPARED_KEY_EXPIRED/);
});
test('prepared key rejects another namespace or credential and cannot be reused after disposal or expiry',async()=>{
  const f=await originalAuthorizationFixture(),p=prf(),namespace=authorizationNamespace(f.payload.intent.orderId),key=await PreparedCapsuleKey.prepare(namespace,ref,p.source);
  await assert.rejects(key.encrypt(f.payload,{namespace:authorizationNamespace(readTestHash(66)),objectId:readTestHash(66),revision:'1'},ref),/CONTEXT_MISMATCH/);
  await assert.rejects(key.encrypt(f.payload,{namespace,objectId:f.payload.intent.orderId,revision:'1'},{...ref,credentialId:'Ag'}),/CONTEXT_MISMATCH/);key.dispose();assert.equal(key.ready,false);
  const expired=await PreparedCapsuleKey.prepare(namespace,ref,p.source,()=>{},10);await new Promise(r=>setTimeout(r,20));assert.equal(expired.ready,false);
  await assert.rejects(expired.encrypt(f.payload,{namespace,objectId:f.payload.intent.orderId,revision:'1'},ref),/PREPARED_KEY_EXPIRED/);
});
test('a cancelled preparation discards a late PRF response and still wipes its bytes',async()=>{
  let valid=true,release!:(raw:Uint8Array<ArrayBuffer>)=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),raw=new Uint8Array(32).fill(11);
  const source:PrfSource={evaluate:()=>{entered();return new Promise(r=>{release=r;});}};
  const pending=PreparedCapsuleKey.prepare(authorizationNamespace(readTestHash(77)),ref,source,()=>{if(!valid)throw Error('SESSION_CHANGED');});await started;valid=false;release(raw);
  await assert.rejects(pending,/SESSION_CHANGED/);assert.ok(raw.every(b=>b===0));
});
