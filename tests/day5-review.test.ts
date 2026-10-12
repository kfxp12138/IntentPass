import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,unlinkSync,truncateSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {inspectDay5Review} from '../scripts/day5-review.js';
import {Day5ReviewSchema,Day5ReviewManifestSchema,day5Assertions,day5CheckIds,day5ReviewScope,type Day5CheckId,type Day5ReviewContext,type Day5ReviewManifest} from '../scripts/day5-review-types.js';
import {OrderSnapshotSchema} from '../packages/protocol/src/escrow-read.js';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const digest=(digit:string)=>'0x'+digit.repeat(64);
function fixture(t:test.TestContext){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'intentpass-day5-review-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const save=(path:string,content:string|Buffer)=>{
    const absolute=join(root,path);mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,content);
    const bytes=readFileSync(absolute);return {path:absolute,bytes:bytes.length,sha256:hash(bytes)};
  };
  // Synthetic unit records and text only. These are never human ceremony, device, chain or acceptance evidence.
  const evidence=Object.fromEntries(day5CheckIds.map(id=>[id,save('artifacts/release-evidence/day5/'+id.toLowerCase()+'.md','synthetic unit fixture for '+id+'\n')])) as Record<Day5CheckId,ReturnType<typeof save>>;
  const snapshot=OrderSnapshotSchema.parse({chainId:'10143',arbiter:'0x'+'1'.repeat(40),asset:'0x'+'2'.repeat(40),
    orderId:digest('2'),contextHash:digest('3'),buyer:'0x'+'3'.repeat(40),seller:'0x'+'4'.repeat(40),payee:'0x'+'5'.repeat(40),
    price:'10',bond:'5',deliveryDeadline:'2000',settlementDeadline:'3000',datasetHash:digest('5'),serviceTermsHash:digest('6'),evidenceHash:digest('7'),voteMask:3,state:'ALLOCATED_PAID',
    credits:{buyer:'5',payee:'10'},withdrawn:{buyer:'0',payee:'0'},accounting:{locked:'0',outstanding:'15',balance:'15'},block:{number:'23',hash:digest('4'),timestamp:'4000'}});
  evidence['D5-04']=save('artifacts/release-evidence/day5/original-order.json',JSON.stringify(snapshot));
  const configuration={publicUrl:'https://product.example/intentpass',rpId:'product.example'};
  const record=Day5ReviewSchema.parse({
    schemaVersion:1,scope:day5ReviewScope,sourceCommit:'1'.repeat(40),reviewedAt:'2026-10-03T10:01:00.000Z',
    context:{configuration,observationsStartedAt:'2026-10-03T10:00:10.000Z',observationsEndedAt:'2026-10-03T10:00:30.000Z',
      primaryContext:'synthetic-profile-a',secondaryContext:{id:'synthetic-profile-b',kind:'PHYSICAL_DEVICE'},
      namespaces:[{namespace:['intentpass','v1','memory','agent-1'],objectId:digest('1'),revision:'2'},
        {namespace:['intentpass','v1','authorization',digest('2')],objectId:digest('2'),revision:'1'}],
      originalOrder:{chainId:10143,escrow:'0x'+'1'.repeat(40),taskId:digest('1'),orderId:digest('2'),contextHash:digest('3'),
        finalizedObservation:{blockNumber:'23',blockHash:digest('4'),state:'ALLOCATED_PAID',evidenceSha256:evidence['D5-04'].sha256}},
    },
    checks:day5CheckIds.map(id=>({id,status:'PASS',reviewer:'synthetic-operator',assertions:Object.fromEntries(day5Assertions[id].map(key=>[key,true])),evidence:[evidence[id]]})),
  });
  const context:Day5ReviewContext={root,commit:record.sourceCommit,sourceCommittedAt:'2026-10-03T10:00:00.000Z',
    startedAt:'2026-10-03T10:02:00.000Z',checkedAt:'2026-10-03T10:03:00.000Z',worktreeDirty:false,localPassed:true,expectedPublicConfiguration:{...configuration}};
  const recordPath=join(root,'private-day5-record.json');
  const inspect=()=>{writeFileSync(recordPath,JSON.stringify(record));return inspectDay5Review(recordPath,context);};
  const bindSnapshot=(value:unknown)=>{
    const binding=save('artifacts/release-evidence/day5/original-order.json',JSON.stringify(value));
    record.checks.find(check=>check.id==='D5-04')!.evidence=[binding];
    record.context.originalOrder!.finalizedObservation!.evidenceSha256=binding.sha256;
    return binding;
  };
  return {root,record,context,recordPath,evidence,inspect,save,snapshot,bindSnapshot};
}
const check=(result:Day5ReviewManifest,id:Day5CheckId)=>result.checks.find(check=>check.id===id)!;
const issue=(result:Day5ReviewManifest,code:string,id?:Day5CheckId)=>result.issues.some(item=>item.code===code&&(!id||item.id===id));

test('absent and partial D5 records remain BLOCKED with all seven ordered IDs',t=>{
  const f=fixture(t),absent=inspectDay5Review(undefined,f.context);
  assert.equal(absent.status,'BLOCKED');assert.equal(absent.sha256,null);assert.ok(issue(absent,'REVIEW_NOT_CONFIGURED'));
  assert.deepEqual(absent.checks.map(item=>[item.id,item.status]),day5CheckIds.map(id=>[id,'BLOCKED']));
  f.record.checks=f.record.checks.slice(0,2);const partial=f.inspect();
  assert.equal(partial.status,'BLOCKED');assert.equal(check(partial,'D5-01').status,'PASS');assert.equal(check(partial,'D5-03').status,'BLOCKED');
  for(const id of day5CheckIds.slice(2))assert.ok(issue(partial,'MANUAL_CHECK_MISSING',id));
});
test('a complete synthetic record binds current bytes in manual D5 scope and omits private paths and reviewers',t=>{
  const f=fixture(t),result=f.inspect();assert.equal(result.status,'PASS');assert.equal(result.scope,day5ReviewScope);
  assert.equal(result.sha256,hash(readFileSync(f.recordPath)));assert.equal(Day5ReviewManifestSchema.safeParse(result).success,true);
  assert.equal(result.context?.namespaces[0].namespace[3],'agent-1');assert.equal(result.context?.originalOrder?.finalizedObservation?.state,'ALLOCATED_PAID');
  for(const id of day5CheckIds)assert.deepEqual(check(result,id).evidence,[{...f.evidence[id],path:relative(f.root,f.evidence[id].path)}]);
  const serialized=JSON.stringify(result);
  for(const privateValue of [f.root,f.recordPath,'synthetic-operator','"reviewer":'])assert.equal(serialized.includes(privateValue),false);
  assert.ok(result.limits.some(limit=>limit.includes('not independent provider or human attestation')));
  assert.ok(result.limits.some(limit=>limit.includes('No other stage or release profile inherits PASS')));
});
test('strict record parse rejects extra fields duplicate checks fake scopes malformed dates and unknown assertions before hashing',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  const invalid=[{...base,extra:'untrusted'},{...base,scope:'INDEPENDENT_HUMAN_ATTESTATION'},
    {...base,checks:[base.checks[0],base.checks[0]]},{...base,reviewedAt:'2026-10-03T18:01:00+08:00'},
    {...base,checks:[{...base.checks[0],assertions:{...base.checks[0].assertions,ANY_BOOLEAN:true}}]},
    {...base,checks:[{...base.checks[0],assertions:{}}]},
    {...base,checks:[{...base.checks[0],evidence:[{...base.checks[0].evidence[0],reason:'operator says yes'}]}]},
    {...base,context:{...base.context,configuration:{publicUrl:'not-a-url',rpId:'product.example'}}},
  ];
  for(const record of invalid){writeFileSync(f.recordPath,JSON.stringify(record));const result=inspectDay5Review(f.recordPath,f.context);
    assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);assert.ok(issue(result,'REVIEW_RECORD_INVALID'));}
  writeFileSync(f.recordPath,'{"malformed":');assert.equal(inspectDay5Review(f.recordPath,f.context).sha256,null);
});
test('private records must be absolute bounded JSON regular files with no symlink leaf',t=>{
  const f=fixture(t);f.inspect();
  const linked=join(f.root,'linked-record.json');symlinkSync(f.recordPath,linked);
  const directory=join(f.root,'directory.json');mkdirSync(directory);
  const secretFile=join(f.root,'.env.json');writeFileSync(secretFile,readFileSync(f.recordPath));
  for(const path of ['private-day5-record.json',join(f.root,'absent.json'),join(f.root,'private-day5-record.txt'),linked,directory,secretFile]){
    const result=inspectDay5Review(path,f.context);assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);
    assert.ok(issue(result,'REVIEW_RECORD_INVALID'));assert.equal(JSON.stringify(result).includes(path),false);
  }
  truncateSync(f.recordPath,65537);assert.equal(inspectDay5Review(f.recordPath,f.context).sha256,null);
});
test('source mismatch dirty worktree and missing commit time fail every existing check while retaining validated record hash',t=>{
  const f=fixture(t),baseContext={...f.context};f.record.checks=f.record.checks.slice(0,2);f.record.checks[1].status='BLOCKED';
  for(const change of [{commit:'2'.repeat(40)},{commit:null},{worktreeDirty:true},{sourceCommittedAt:null},{sourceCommittedAt:'not-a-date'}]){
    Object.assign(f.context,baseContext,change);const result=f.inspect();assert.equal(result.status,'FAIL');assert.notEqual(result.sha256,null);
    assert.equal(check(result,'D5-01').status,'FAIL');assert.equal(check(result,'D5-02').status,'FAIL');assert.equal(check(result,'D5-03').status,'BLOCKED');
  }
});
test('observations must follow commit and finish by review, review by run, and check by run start',t=>{
  const f=fixture(t),baseRecord=structuredClone(f.record),baseContext=structuredClone(f.context);
  const changes=[()=>{f.record.context.observationsStartedAt='2026-10-03T09:59:59.999Z';},
    ()=>{f.record.context.observationsEndedAt='2026-10-03T10:01:00.001Z';},
    ()=>{f.record.reviewedAt='2026-10-03T10:02:00.001Z';},
    ()=>{f.context.checkedAt='2026-10-03T10:01:59.999Z';}];
  for(const change of changes){Object.assign(f.record,structuredClone(baseRecord));Object.assign(f.context,baseContext);change();
    const result=f.inspect();assert.equal(result.status,'FAIL');assert.ok(issue(result,'REVIEW_TIME_INVALID'));
    assert.ok(result.checks.every(item=>item.status==='FAIL'));
  }
  Object.assign(f.record,baseRecord);Object.assign(f.context,baseContext);
  f.record.context.observationsStartedAt=f.context.sourceCommittedAt!;f.record.context.observationsEndedAt=f.record.reviewedAt;
  f.context.startedAt=f.record.reviewedAt;f.context.checkedAt=f.context.startedAt;assert.equal(f.inspect().status,'PASS');
});
test('invalid runner timestamps throw only a fixed public code',t=>{
  const f=fixture(t);f.inspect();
  for(const key of ['startedAt','checkedAt'] as const){const invalid={...f.context,[key]:f.recordPath};
    assert.throws(()=>inspectDay5Review(f.recordPath,invalid),error=>error instanceof Error&&error.message==='DAY5_REVIEW_CONTEXT_INVALID');}
});
test('missing expected HTTPS and RP configuration blocks PASS but never overwrites any failure',t=>{
  const f=fixture(t);f.context.expectedPublicConfiguration=null;
  let result=f.inspect();assert.equal(result.status,'BLOCKED');assert.ok(result.checks.every(item=>item.status==='BLOCKED'));
  assert.ok(issue(result,'PUBLIC_CONFIGURATION_REQUIRED'));
  f.record.checks[0].status='FAIL';f.record.checks[1].assertions.REAL_HUMAN_CEREMONY_NO_VIRTUAL_AUTHENTICATOR=false;
  result=f.inspect();assert.equal(result.status,'FAIL');assert.equal(check(result,'D5-01').status,'FAIL');assert.equal(check(result,'D5-02').status,'FAIL');
  assert.ok(issue(result,'MANUAL_CHECK_FAILED','D5-01'));assert.ok(issue(result,'MANUAL_ASSERTIONS_OR_EVIDENCE_INCOMPLETE','D5-02'));
});
test('configuration must exactly match current canonical public HTTPS URL and RP declaration',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  for(const configuration of [{publicUrl:'https://other.example/intentpass',rpId:'other.example'},
    {publicUrl:'https://product.example/changed',rpId:'product.example'},
    {publicUrl:'https://product.example/intentpass',rpId:'example'}]){
    f.context.expectedPublicConfiguration=configuration;const result=f.inspect();assert.equal(result.status,'FAIL');assert.ok(result.checks.every(item=>item.status==='FAIL'));
  }
  const invalid=[{publicUrl:'http://product.example/',rpId:'product.example'},
    {publicUrl:['https://','user',':','pass','@product.example/'].join(''),rpId:'product.example'},
    {publicUrl:'https://product.example/?token=private',rpId:'product.example'},
    {publicUrl:'https://127.0.0.1/',rpId:'127.0.0.1'},
    {publicUrl:'https://product.local/',rpId:'product.local'},
    {publicUrl:'https://product.example/',rpId:'other.example'}];
  for(const configuration of invalid){Object.assign(f.record,structuredClone(base));f.record.context.configuration=configuration;
    writeFileSync(f.recordPath,JSON.stringify(f.record));const result=inspectDay5Review(f.recordPath,f.context);
    assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);assert.ok(issue(result,'REVIEW_RECORD_INVALID'));}
});
test('local D5 prerequisites and every fixed assertion and current evidence are required for claimed PASS',t=>{
  const f=fixture(t);f.context.localPassed=false;let result=f.inspect();assert.equal(result.status,'FAIL');assert.ok(result.checks.every(item=>item.status==='FAIL'));
  for(const id of day5CheckIds)assert.ok(issue(result,'LOCAL_DAY_FIVE_PREREQUISITES_INCOMPLETE',id));
  f.context.localPassed=true;f.record.checks[0].assertions.TWO_NON_WALLET_NAMESPACES_CREATED_ON_A=false;
  f.record.checks[1].evidence=[];result=f.inspect();assert.equal(check(result,'D5-01').status,'FAIL');assert.equal(check(result,'D5-02').status,'FAIL');
});
test('a genuinely separate browser profile is an allowed D5 context without being relabeled a physical device',t=>{
  const f=fixture(t);f.record.context.secondaryContext!.kind='NEW_BROWSER_PROFILE';const result=f.inspect();
  assert.equal(result.status,'PASS');assert.equal(result.context?.secondaryContext?.kind,'NEW_BROWSER_PROFILE');assert.equal(result.scope,day5ReviewScope);
  f.record.context.secondaryContext=null;const missing=f.inspect();assert.equal(check(missing,'D5-02').status,'FAIL');assert.ok(issue(missing,'SECONDARY_CONTEXT_REQUIRED','D5-02'));
  const same={...f.record.context,secondaryContext:{id:f.record.context.primaryContext,kind:'NEW_BROWSER_PROFILE'}};
  writeFileSync(f.recordPath,JSON.stringify({...f.record,context:same}));assert.equal(inspectDay5Review(f.recordPath,f.context).sha256,null);
  const virtual={...f.record.context,secondaryContext:{id:'synthetic-virtual',kind:'VIRTUAL_AUTHENTICATOR'}};
  writeFileSync(f.recordPath,JSON.stringify({...f.record,context:virtual}));assert.equal(inspectDay5Review(f.recordPath,f.context).sha256,null);
});
test('restore and tamper checks require the original Monad order bound to memory object and immutable authorization namespace',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  f.record.context.originalOrder=null;let result=f.inspect();for(const id of ['D5-04','D5-05'] as const){assert.equal(check(result,id).status,'FAIL');assert.ok(issue(result,'ORIGINAL_ORDER_REQUIRED',id));}
  const variants=[()=>{f.record.context.originalOrder!.taskId=digest('9');},()=>{f.record.context.originalOrder!.orderId=digest('9');},
    ()=>{f.record.context.namespaces[1].namespace[3]=digest('9');},()=>{f.record.context.namespaces[1].revision='2';},
    ()=>{f.record.context.namespaces[0].namespace[2]='authorization';}];
  for(const change of variants){Object.assign(f.record,structuredClone(base));change();result=f.inspect();assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);}
  const invalidChain={...base,context:{...base.context,originalOrder:{...base.context.originalOrder!,chainId:31337}}};
  writeFileSync(f.recordPath,JSON.stringify(invalidChain));assert.equal(inspectDay5Review(f.recordPath,f.context).sha256,null);
});
test('D5-04 needs a finalized observation digest bound to its own successfully inspected evidence',t=>{
  const f=fixture(t),original=structuredClone(f.record.context.originalOrder!);
  f.record.context.originalOrder!.finalizedObservation=null;let result=f.inspect();assert.equal(check(result,'D5-04').status,'FAIL');assert.ok(issue(result,'FINALIZED_OBSERVATION_REQUIRED','D5-04'));
  f.record.context.originalOrder=structuredClone(original);f.record.context.originalOrder!.finalizedObservation!.evidenceSha256=f.evidence['D5-05'].sha256;
  result=f.inspect();assert.equal(check(result,'D5-04').status,'FAIL');assert.ok(issue(result,'FINALIZED_OBSERVATION_EVIDENCE_MISMATCH','D5-04'));assert.equal(check(result,'D5-05').status,'PASS');
  f.record.context.originalOrder=structuredClone(original);writeFileSync(f.evidence['D5-04'].path,'changed finalized observation bytes');
  result=f.inspect();assert.equal(check(result,'D5-04').status,'FAIL');assert.ok(issue(result,'EVIDENCE_BYTES_MISMATCH','D5-04'));
});
test('finalized order observation states are protocol states and cannot claim invented delivered or allocated states',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  for(const state of ['FUNDED','EVIDENCE_FROZEN','CERTIFIED','ALLOCATED_PAID','ALLOCATED_REFUND','ALLOCATED_COMPENSATION']){
    const binding=f.bindSnapshot({...f.snapshot,state});
    const record={...base,checks:f.record.checks,context:{...base.context,originalOrder:{...base.context.originalOrder!,finalizedObservation:{...base.context.originalOrder!.finalizedObservation!,state,evidenceSha256:binding.sha256}}}};
    writeFileSync(f.recordPath,JSON.stringify(record));assert.equal(inspectDay5Review(f.recordPath,f.context).status,'PASS');
  }
  for(const state of ['UNREGISTERED','DELIVERED','ALLOCATED']){
    const record={...base,context:{...base.context,originalOrder:{...base.context.originalOrder!,finalizedObservation:{...base.context.originalOrder!.finalizedObservation!,state}}}};
    writeFileSync(f.recordPath,JSON.stringify(record));const result=inspectDay5Review(f.recordPath,f.context);assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);
  }
});
test('changed bytes wrong hashes empty actual files and duplicate bindings fail without private error text',t=>{
  const f=fixture(t),evidence=f.record.checks[0].evidence[0],original=readFileSync(evidence.path);
  writeFileSync(evidence.path,'changed public bytes');assert.ok(issue(f.inspect(),'EVIDENCE_BYTES_MISMATCH','D5-01'));writeFileSync(evidence.path,original);
  evidence.sha256='0'.repeat(64);assert.ok(issue(f.inspect(),'EVIDENCE_BYTES_MISMATCH','D5-01'));evidence.sha256=hash(original);
  f.record.checks[0].evidence.push({...evidence});assert.ok(issue(f.inspect(),'EVIDENCE_PATH_INVALID','D5-01'));f.record.checks[0].evidence.pop();
  writeFileSync(evidence.path,'');const result=f.inspect();assert.equal(check(result,'D5-01').status,'FAIL');assert.ok(issue(result,'PUBLIC_FILE_INVALID','D5-01'));
  assert.equal(JSON.stringify(result).includes(f.root),false);
});
test('evidence accepts only canonical public release paths and rejects symlink leaves and parent directories',t=>{
  const f=fixture(t),evidence=f.record.checks[0].evidence[0],original={...evidence};
  for(const path of [join(f.root,'private-do-not-read.txt'),join(f.root,'artifacts/release-evidence/.hidden.txt'),
    original.path.replace('release-evidence/','release-evidence//'),f.root+'/artifacts/release-evidence/day5/../day5/d5-01.md',
    join(f.root,'artifacts/release-evidence/env-private.txt'),join(f.root,'artifacts/release-evidence/evidence.db')]){
    evidence.path=path;const result=f.inspect();assert.equal(check(result,'D5-01').status,'FAIL');assert.equal(JSON.stringify(result).includes('private-do-not-read'),false);
  }
  Object.assign(evidence,original);unlinkSync(evidence.path);symlinkSync(f.evidence['D5-02'].path,evidence.path);
  assert.ok(issue(f.inspect(),'PUBLIC_SYMLINK_REJECTED','D5-01'));
  const linked=join(f.root,'artifacts/release-evidence/linked');symlinkSync(join(f.root,'artifacts/release-evidence/day5'),linked);
  evidence.path=join(linked,'d5-02.md');assert.ok(issue(f.inspect(),'PUBLIC_SYMLINK_REJECTED','D5-01'));
  evidence.path='artifacts/release-evidence/day5/d5-02.md';const relativePath=f.inspect();assert.equal(relativePath.sha256,null);assert.equal(relativePath.status,'FAIL');
});
test('public secrets are rejected even across stream chunks and are never copied into the manifest',t=>{
  const f=fixture(t),secret=['api','key_'].join('')+'A'.repeat(40);
  f.record.checks[0].evidence=[f.save('artifacts/release-evidence/unsafe.txt',Buffer.from('x'.repeat(65525)+'\n'+secret))];
  const result=f.inspect();assert.equal(check(result,'D5-01').status,'FAIL');assert.ok(issue(result,'PUBLIC_EVIDENCE_UNSAFE','D5-01'));
  assert.equal(JSON.stringify(result).includes(secret),false);
});
test('credentials pasted into otherwise valid public aliases URLs or paths fail without publishing the value',t=>{
  const f=fixture(t),secret=['api','key_'].join('')+'A'.repeat(40),base=structuredClone(f.record);
  f.record.context.primaryContext=secret;let result=f.inspect();assert.equal(result.status,'FAIL');assert.equal(result.context,null);assert.equal(result.sha256,null);assert.ok(issue(result,'REVIEW_RECORD_UNSAFE'));assert.equal(JSON.stringify(result).includes(secret),false);
  const escaped=JSON.stringify(f.record).replace(secret,secret.split('').map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
  writeFileSync(f.recordPath,escaped);result=inspectDay5Review(f.recordPath,f.context);assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);assert.ok(issue(result,'REVIEW_RECORD_UNSAFE'));
  Object.assign(f.record,structuredClone(base));f.record.context.configuration.publicUrl='https://product.example/'+secret;
  result=f.inspect();assert.equal(result.status,'FAIL');assert.equal(result.context,null);assert.equal(JSON.stringify(result).includes(secret),false);
  Object.assign(f.record,structuredClone(base));f.record.checks[0].evidence=[f.save('artifacts/release-evidence/'+secret+'.txt','synthetic safe bytes')];
  result=f.inspect();assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);assert.ok(issue(result,'REVIEW_RECORD_UNSAFE'));assert.equal(JSON.stringify(result).includes(secret),false);
});
test('D5-04 inspects snapshot contents and rejects a different order chain context block or state even with a correct digest',t=>{
  const f=fixture(t);
  const invalid=[{...f.snapshot,orderId:digest('9')},{...f.snapshot,contextHash:digest('9')},{...f.snapshot,chainId:'31337'},
    {...f.snapshot,arbiter:'0x'+'9'.repeat(40)},{...f.snapshot,block:{...f.snapshot.block,number:'24'}},
    {...f.snapshot,block:{...f.snapshot.block,hash:digest('9')}},{...f.snapshot,state:'FUNDED'},
    {...f.snapshot,extra:'untrusted'},{}];
  for(const snapshot of invalid){const binding=f.bindSnapshot(snapshot),result=f.inspect();
    assert.equal(result.status,'FAIL');assert.equal(check(result,'D5-04').status,'FAIL');assert.notEqual(result.sha256,null);
    assert.equal(check(result,'D5-04').evidence[0].sha256,binding.sha256);
    assert.ok(issue(result,'FINALIZED_OBSERVATION_CONTEXT_MISMATCH','D5-04')||issue(result,'FINALIZED_OBSERVATION_JSON_INVALID','D5-04'));
  }
});
test('D5-04 requires one bounded public snapshot JSON and cannot bind prose media oversized or ambiguous anchors',t=>{
  const f=fixture(t),entry=f.record.checks.find(check=>check.id==='D5-04')!;
  for(const [path,content] of [['arbitrary.md','synthetic unrelated prose'],['media.png',Buffer.from([0,1,2])],
    ['large.json',' '.repeat(65537)],['malformed.json','{"broken":']] as const){
    const binding=f.save('artifacts/release-evidence/day5/'+path,content);entry.evidence=[binding];f.record.context.originalOrder!.finalizedObservation!.evidenceSha256=binding.sha256;
    const result=f.inspect();assert.equal(check(result,'D5-04').status,'FAIL');
    assert.ok(issue(result,'FINALIZED_OBSERVATION_JSON_REQUIRED','D5-04')||issue(result,'FINALIZED_OBSERVATION_JSON_INVALID','D5-04'));
  }
  const binding=f.bindSnapshot(f.snapshot),copy=f.save('artifacts/release-evidence/day5/copied-order.json',JSON.stringify(f.snapshot));
  entry.evidence=[binding,copy];const result=f.inspect();assert.equal(check(result,'D5-04').status,'FAIL');assert.ok(issue(result,'FINALIZED_OBSERVATION_EVIDENCE_MISMATCH','D5-04'));
});
test('unsafe evidence remains FAIL for BLOCKED or explicit FAIL checks and missing configuration cannot mask it',t=>{
  const f=fixture(t);f.context.expectedPublicConfiguration=null;f.record.checks[0].status='BLOCKED';f.record.checks[1].status='FAIL';
  f.record.checks[0].evidence[0].sha256='0'.repeat(64);const result=f.inspect();
  assert.equal(result.status,'FAIL');assert.equal(check(result,'D5-01').status,'FAIL');assert.equal(check(result,'D5-02').status,'FAIL');
  assert.ok(issue(result,'EVIDENCE_BYTES_MISMATCH','D5-01'));assert.ok(issue(result,'MANUAL_CHECK_FAILED','D5-02'));
});

test('D5 private duplicate members cannot hide escaped credentials or publish their record digest',t=>{
  const f=fixture(t);f.inspect();
  const secret=['api','key_'].join('')+'A'.repeat(40),escaped=Array.from(secret,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  const raw=readFileSync(f.recordPath,'utf8').replace('"reviewer":','"reviewer":"'+escaped+'","reviewer":');
  writeFileSync(f.recordPath,raw);const result=inspectDay5Review(f.recordPath,f.context);assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);assert.equal(result.context,null);assert.equal(JSON.stringify(result).includes(secret),false);
});
