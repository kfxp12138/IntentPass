import test from 'node:test';
import assert from 'node:assert/strict';
import {taskPasskeyReference} from '../apps/web/src/passkey-reference.js';
const taskId='0x'+'12'.repeat(32),reference={rpId:'localhost',credentialId:'AQ'};
const file={format:'IntentPass.Capsule.v1',keyReference:reference,capsule:{schemaVersion:1,objectId:taskId,revision:'1',namespace:['intentpass','v1','memory',taskId],iv:'AAAAAAAAAAAAAAAA',ciphertext:'AAAAAAAAAAAAAAAAAAAAAAAA'}};
test('original task reference reads public locator only, preserves an existing same locator and rejects task, RP, namespace or credential replacement',()=>{
  assert.deepEqual(taskPasskeyReference(file,taskId,'localhost'),reference);assert.deepEqual(taskPasskeyReference(file,taskId,'localhost',reference),reference);
  for(const [input,id,rp,old] of [[file,'0x'+'13'.repeat(32),'localhost',undefined],[file,taskId,'example.com',undefined],[{...file,capsule:{...file.capsule,namespace:['intentpass','v1','authorization',taskId]}},taskId,'localhost',undefined],[file,taskId,'localhost',{rpId:'localhost',credentialId:'Ag'}],[{...file,prf:'forbidden'},taskId,'localhost',undefined]] as const)assert.throws(()=>taskPasskeyReference(input,id,rp,old));
  assert.throws(()=>taskPasskeyReference(file,taskId,'127.0.0.1'));
});
