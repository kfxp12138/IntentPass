import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocalTask,serializeLocalTask,restoreLocalTask,localTaskFingerprint} from '../packages/capsule/src/local-task.js';
import {isIpRpId,localPasskeyUrl} from '../packages/capsule/src/rp-domain.js';
import {createCapsulePasskey} from '../packages/capsule/src/mera.js';
import {createReport} from '../packages/protocol/src/report.js';
import {memoryNamespace} from '../packages/capsule/src/format.js';
import type {WebAuthnClient} from '@category-labs/mera';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
function task(){const dataset=[3,7,11,19];return {policy:{schemaVersion:1,taskId:h(1),datasetHash:createReport(dataset).datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'10',allowedAsset:a(9),requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'},taskInput:{dataset,buyer:a(1),seller:a(2)},evidence:{schemaVersion:2,salt:h(8),taskText:'Current report with literal braces { retained }',documents:[]}};}
test('local task transfer preserves the exact original task, dataset and evidence salt without generating new values',()=>{
  const original=task(),serialized=serializeLocalTask(original,false),parsed=parseLocalTask(serialized);assert.deepEqual(parsed.policy,original.policy);assert.deepEqual(parsed.taskInput,original.taskInput);assert.deepEqual(parsed.evidence,original.evidence);assert.equal(localTaskFingerprint(parsed),localTaskFingerprint(original));
});
test('a copy of the original visible page can be recovered without interpreting surrounding text or JSON strings',()=>{
  const original=task(),visible='IP IntentPass\n当前原始策略\n'+JSON.stringify(original,null,2)+'\n候选订单：'+h(9)+'\n审查暂停';const parsed=parseLocalTask(visible);assert.deepEqual(parsed.evidence,original.evidence);assert.equal(parsed.policy.taskId,original.policy.taskId);
});
test('signed authorizations, credential fields, legacy unsalted evidence and changed dataset commitments are rejected',()=>{
  const original=task();for(const changed of [{...original,grant:{nonce:'1'},ownerSignature:'0x1234'},{...original,accessToken:'secret-not-a-task'},{...original,evidence:{schemaVersion:1,taskText:'Legacy',documents:[]}},{...original,policy:{...original.policy,datasetHash:h(90)}}])assert.throws(()=>parseLocalTask(JSON.stringify(changed)),/LOCAL_TASK_INPUT_INVALID/);
});
test('locked or unknown wallet operations prevent local export and restore',()=>{
  const original=task();assert.throws(()=>serializeLocalTask(original,true),/AUTHORIZATION_LOCKED/);assert.throws(()=>restoreLocalTask(JSON.stringify(original),undefined,true),/AUTHORIZATION_LOCKED/);
});
test('an existing task remains untouched and a differing task cannot overwrite it',()=>{
  const original=task();assert.equal(restoreLocalTask(JSON.stringify(original),original,false).alreadyPresent,true);const changed={...original,evidence:{...original.evidence,salt:h(99)}};assert.throws(()=>restoreLocalTask(JSON.stringify(changed),original,false),/EXISTING_TASK_MISMATCH/);assert.equal(original.evidence.salt,h(8));
});
test('only loopback IP origins receive an exact same-service localhost target',()=>{
  assert.equal(isIpRpId('127.0.0.1'),true);assert.equal(isIpRpId('[::1]'),true);assert.equal(isIpRpId('localhost'),false);assert.equal(isIpRpId('example.com'),false);
  assert.equal(localPasskeyUrl('http://127.0.0.1:3000'),'http://localhost:3000/#recovery');assert.equal(localPasskeyUrl('https://[::1]:4443'),'https://localhost:4443/#recovery');assert.equal(localPasskeyUrl('https://service.example'),undefined);
});
test('IP RP IDs stop before any real or injected credential creation',async()=>{
  let creations=0;const client:WebAuthnClient={createCredential:async()=>{creations++;return {credentialId:new Uint8Array([1]),prfEnabled:true,prfOutput:new Uint8Array(32)};},getCredential:async()=>{throw Error('SHOULD_NOT_ASSERT');}};
  await assert.rejects(createCapsulePasskey('127.0.0.1',{name:'Test',displayName:'Test'},memoryNamespace(h(1)),client),/PASSKEY_DOMAIN_REQUIRED/);assert.equal(creations,0);
});
