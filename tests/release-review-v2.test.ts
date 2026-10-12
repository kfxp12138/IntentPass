import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {z} from 'zod';
import {Day5BrowserContextSchema} from '../scripts/day5-review-types.js';
import {inspectReleaseReview,releaseAssertions,releaseSponsorAssertions,releaseProfiles,releaseReviewScope,
  ReleaseReviewSchema,ReleaseReviewManifestSchema,type ReleaseReviewContext,type ReleaseReviewManifest,type ReleaseCheckId} from '../scripts/release-review.js';

type Status='PASS'|'FAIL'|'BLOCKED';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(t:test.TestContext){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'intentpass-release-v2-synthetic-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const save=(name:string,extension='md')=>{
    const path=join(root,`artifacts/release-evidence/v2/${name}.${extension}`),bytes=Buffer.from(`SYNTHETIC_RELEASE_V2_FORMAT_DOUBLE_${name}\n`);
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return {path,bytes:bytes.length,sha256:hash(bytes)};
  };
  // No fixture represents a real provider, passkey, device, video or release.
  const product=save('product'),technical=save('technical','mp4'),pitch=save('pitch','mp4'),cleanverse=save('cleanverse','mp4'),
    logo=save('logo','png'),receipt=save('receipt','json'),mera=save('mera'),privy=save('privy');
  const candidate={schemaVersion:1 as const,sourceCommit:'1'.repeat(40),productUrl:'https://product.example/intentpass',repositoryUrl:'https://repository.example/intentpass',
    technicalVideo:{localPath:technical.path,publicUrl:'https://video.example/technical'},pitchVideo:{localPath:pitch.path,publicUrl:'https://video.example/pitch'},
    cleanverseVideo:{localPath:cleanverse.path,publicUrl:'https://video.example/cleanverse'},logoPath:logo.path,submission:{publicUrl:'https://submission.example/saved',receiptPath:receipt.path}};
  const assetsSha256=hash(Buffer.from(JSON.stringify(candidate))),byId:Partial<Record<ReleaseCheckId,typeof product[]>>={
    'D7-01':[product],'D7-02':[technical],'D7-03':[pitch,cleanverse],'D7-05':[logo,product],'D7-06':[receipt]};
  const recoveryContext:z.infer<typeof Day5BrowserContextSchema>={configuration:{publicUrl:candidate.productUrl,rpId:'product.example'},
    observationsStartedAt:'2026-10-02T10:00:10.000Z',observationsEndedAt:'2026-10-02T10:00:50.000Z',primaryContext:'synthetic-primary',
    secondaryContext:{id:'synthetic-secondary',kind:'NEW_BROWSER_PROFILE'},
    namespaces:[{namespace:['intentpass','v1','memory','synthetic-task'],objectId:'0x'+'2'.repeat(64),revision:'1'},
      {namespace:['intentpass','v1','authorization','0x'+'3'.repeat(64)],objectId:'0x'+'3'.repeat(64),revision:'1'}],originalOrder:null};
  const record={schemaVersion:2 as const,scope:releaseReviewScope,sourceCommit:candidate.sourceCommit,assetsSha256,reviewedAt:'2026-10-02T10:01:00.000Z',
    checks:(Object.keys(releaseAssertions) as ReleaseCheckId[]).filter(id=>id!=='D7-04').map(id=>({id,status:'PASS' as Status,reviewer:'synthetic-operator',
      assertions:Object.fromEntries(releaseAssertions[id].map(key=>[key,true])),evidence:byId[id]!.map(binding=>({...binding}))})),
    sponsorChecks:(['MERA','PRIVY'] as const).map(id=>({id,status:'PASS' as Status,reviewer:'synthetic-operator',
      assertions:Object.fromEntries(releaseSponsorAssertions[id].map(key=>[key,true])),evidence:[{...(id==='MERA'?mera:privy)}]})),
    recoveryContext:recoveryContext as z.infer<typeof Day5BrowserContextSchema>|null};
  const assets=[...([['technicalVideo',technical,180],['pitchVideo',pitch,120],['cleanverseVideo',cleanverse,300]] as const).map(([name,b,maximumSeconds])=>
    ({name,status:'LOCAL_METADATA_PASS',bytes:b.bytes,sha256:b.sha256,durationSeconds:2,maximumSeconds})),
    {name:'logo',status:'LOCAL_METADATA_PASS',bytes:logo.bytes,sha256:logo.sha256},
    {name:'submissionReceipt',status:'LOCAL_FILE_PRESENT_MANUAL_PLATFORM_VERIFICATION_REQUIRED',bytes:receipt.bytes,sha256:receipt.sha256}];
  const audit={startedAt:'2026-10-02T10:02:00.000Z',endedAt:'2026-10-02T10:03:00.000Z',scope:'PUBLIC_SOURCE_BUILD_LOG_RAW_BYTES_HEURISTIC_ONLY',status:'PASS',findings:[],unverified:[],
    manifest:[{path:'artifacts/release-evidence/v2/product.md',bytes:product.bytes,sha256:product.sha256,binary:false}]};
  const context:ReleaseReviewContext={root,commit:candidate.sourceCommit,sourceCommittedAt:'2026-10-02T10:00:00.000Z',startedAt:audit.startedAt,
    checkedAt:'2026-10-02T10:04:00.000Z',worktreeDirty:false,candidateStatus:'VALID',assetsSha256,candidate,localPassed:true,assets,audit};
  const recordPath=join(root,'synthetic-private-release.json');
  const inspect=(input:unknown=record)=>{writeFileSync(recordPath,JSON.stringify(input));return inspectReleaseReview(recordPath,context);};
  return {root,record,context,inspect,recordPath,mera,privy};
}
function v2(review:ReleaseReviewManifest){assert.equal(review.schemaVersion,2);if(review.schemaVersion!==2)throw Error('EXPECTED_SYNTHETIC_V2');return review;}
const profile=(review:ReleaseReviewManifest,name:string)=>releaseProfiles(review.checks,review).find(row=>row.name===name)!;

test('v2 new-profile Mera and Privy records retain independent scope without inventing the physical-device story',t=>{
  const f=fixture(t),review=v2(f.inspect());
  assert.equal(review.status,'BLOCKED');assert.equal(review.physicalSecondDeviceStoryStatus,'BLOCKED');assert.equal(review.checks[3].status,'BLOCKED');
  assert.equal(review.checks[3].assertions.SAME_PASSKEY_SECOND_PHYSICAL_DEVICE_REVIEWED,false);assert.equal(profile(review,'Mera').status,'PASS');
  assert.equal(profile(review,'Privy').status,'PASS');assert.equal(profile(review,'PACT-inspired product').status,'BLOCKED');
  assert.equal(profile(review,'Full PACT / IMAS / CDAS').status,'NOT_STARTED');assert.ok(review.limits.some(limit=>limit.includes('not independent provider attestation')));
  assert.equal(review.productOrigin,'https://product.example');
  const serialized=JSON.stringify(review);assert.equal(serialized.includes(f.root),false);assert.equal(serialized.includes('synthetic-operator'),false);
  assert.equal(serialized.includes('synthetic-private-release'),false);assert.deepEqual(review.checks.map(row=>row.id),Object.keys(releaseAssertions));
});

test('v2 sponsor PASS FAIL and BLOCKED do not inherit the other sponsor or create physical-device evidence',t=>{
  const f=fixture(t);
  for(const sponsor of ['MERA','PRIVY'] as const)for(const status of ['PASS','FAIL','BLOCKED'] as const){
    for(const row of f.record.sponsorChecks)row.status=row.id===sponsor?status:'PASS';
    const review=v2(f.inspect()),other=sponsor==='MERA'?'Privy':'Mera';
    assert.equal(profile(review,sponsor==='MERA'?'Mera':'Privy').status,status);
    assert.equal(profile(review,other).status,'PASS');assert.equal(review.physicalSecondDeviceStoryStatus,'BLOCKED');
    assert.equal(review.status,status==='FAIL'?'FAIL':'BLOCKED');assert.equal(profile(review,'PACT-inspired product').status,status==='FAIL'?'FAIL':'BLOCKED');
  }
});

test('v2 physical-device story follows the actual context and Mera status, never only an asserted boolean',t=>{
  const f=fixture(t);f.record.recoveryContext!.secondaryContext!.kind='PHYSICAL_DEVICE';
  for(const status of ['PASS','FAIL','BLOCKED'] as const){
    f.record.sponsorChecks[0].status=status;const review=v2(f.inspect());
    assert.equal(review.physicalSecondDeviceStoryStatus,status);assert.equal(review.checks[3].status,status);
    assert.equal(review.checks[3].assertions.SAME_PASSKEY_SECOND_PHYSICAL_DEVICE_REVIEWED,status==='PASS');
    assert.equal(profile(review,'Privy').status,'PASS');assert.equal(profile(review,'PACT-inspired product').status,status);
  }
});

test('v2 invalid RP, reused context and observation windows cannot pass Mera',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  const invalid=[
    {...base,recoveryContext:{...base.recoveryContext!,configuration:{publicUrl:'https://product.example/intentpass',rpId:'elsewhere.example'}}},
    {...base,recoveryContext:{...base.recoveryContext!,secondaryContext:{id:base.recoveryContext!.primaryContext,kind:'NEW_BROWSER_PROFILE'}}},
    {...base,recoveryContext:{...base.recoveryContext!,observationsEndedAt:'2026-10-02T10:00:09.000Z'}},
  ];
  for(const record of invalid){assert.equal(ReleaseReviewSchema.safeParse(record).success,false);const result=f.inspect(record);assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);}
  for(const context of [null,{...base.recoveryContext!,secondaryContext:null},{...base.recoveryContext!,observationsStartedAt:'2026-10-02T09:59:59.999Z'},
    {...base.recoveryContext!,observationsEndedAt:'2026-10-02T10:01:00.001Z'},
    {...base.recoveryContext!,configuration:{publicUrl:'https://other.example/intentpass',rpId:'other.example'}}]){
    const review=v2(f.inspect({...base,recoveryContext:context}));assert.equal(profile(review,'Mera').status,'FAIL');
    assert.equal(profile(review,'Privy').status,'PASS');assert.equal(review.physicalSecondDeviceStoryStatus,'BLOCKED');
    assert.ok(review.issues.some(issue=>issue.code==='MERA_RECOVERY_CONTEXT_INVALID'));
  }
});

test('v2 sponsor records cannot use legacy D7-04, duplicate IDs or arbitrary assertions',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  for(const record of [
    {...base,checks:[...base.checks,{...base.checks[0],id:'D7-04'}]},
    {...base,sponsorChecks:[base.sponsorChecks[0],base.sponsorChecks[0]]},
    {...base,sponsorChecks:[{...base.sponsorChecks[0],assertions:{...base.sponsorChecks[0].assertions,REAL_BOUNTY_PASS:true}},base.sponsorChecks[1]]},
  ])assert.equal(ReleaseReviewSchema.safeParse(record).success,false);
  f.record.sponsorChecks=f.record.sponsorChecks.slice(0,1);const partial=v2(f.inspect());
  assert.equal(profile(partial,'Mera').status,'PASS');assert.equal(profile(partial,'Privy').status,'BLOCKED');assert.equal(partial.status,'BLOCKED');
});

test('v2 normalized manifests reject invented physical PASS, changed sponsor assertions or combined evidence',t=>{
  const f=fixture(t),original=v2(f.inspect());assert.equal(ReleaseReviewManifestSchema.safeParse(original).success,true);
  const physical=structuredClone(original);physical.physicalSecondDeviceStoryStatus='PASS';assert.equal(ReleaseReviewManifestSchema.safeParse(physical).success,false);
  const combined=structuredClone(original);combined.checks[3].status='PASS';combined.checks[3].assertions.SAME_PASSKEY_SECOND_PHYSICAL_DEVICE_REVIEWED=true;
  assert.equal(ReleaseReviewManifestSchema.safeParse(combined).success,false);
  const assertion=structuredClone(original);assertion.sponsorChecks[0].assertions.NO_COPIED_PLAINTEXT_KEY_PRF_OR_LOCAL_SESSION=false;
  assert.equal(ReleaseReviewManifestSchema.safeParse(assertion).success,false);
  const evidence=structuredClone(original);evidence.checks[3].evidence=[];assert.equal(ReleaseReviewManifestSchema.safeParse(evidence).success,false);
  const origin=structuredClone(original);origin.recoveryContext!.configuration={publicUrl:'https://elsewhere.example/',rpId:'elsewhere.example'};
  assert.equal(ReleaseReviewManifestSchema.safeParse(origin).success,false);
  const missingOrigin=structuredClone(original);missingOrigin.productOrigin=null;assert.equal(ReleaseReviewManifestSchema.safeParse(missingOrigin).success,false);
  const missingContext=structuredClone(original);missingContext.recoveryContext=null;assert.equal(ReleaseReviewManifestSchema.safeParse(missingContext).success,false);
  const mismatchedChecks=original.checks.map(row=>({...row,status:row.id==='D7-04'?'PASS' as const:row.status}));
  assert.equal(releaseProfiles(mismatchedChecks,original).find(row=>row.name==='Mera')!.status,'FAIL');
});

test('v2 changed original sponsor bytes fail only the affected sponsor and retain the other exact binding',t=>{
  const f=fixture(t),original=readFileSync(f.mera.path);writeFileSync(f.mera.path,'CHANGED_SYNTHETIC_MERA_FORMAT_BYTES');
  const changed=v2(f.inspect());assert.equal(profile(changed,'Mera').status,'FAIL');assert.equal(profile(changed,'Privy').status,'PASS');
  assert.equal(changed.physicalSecondDeviceStoryStatus,'BLOCKED');assert.ok(changed.issues.some(issue=>issue.sponsor==='MERA'&&issue.code==='EVIDENCE_BYTES_MISMATCH'));
  writeFileSync(f.mera.path,original);f.record.sponsorChecks[1].assertions.REAL_PRIVY_POLICY_DENIAL_REVIEWED=false;
  const denied=v2(f.inspect());assert.equal(profile(denied,'Privy').status,'FAIL');assert.equal(profile(denied,'Mera').status,'PASS');
  assert.equal(denied.physicalSecondDeviceStoryStatus,'BLOCKED');assert.equal(denied.status,'FAIL');
});

test('v2 synthetic credentials in aliases namespaces and escaped JSON fail before any private digest or context is published',t=>{
  const f=fixture(t),secret=['api','key_'].join('')+'A'.repeat(40),base=structuredClone(f.record);
  const escaped=Array.from(secret,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  for(const field of ['primary','secondary','memory'] as const)for(const encoded of [false,true]){
    const record=structuredClone(base);
    if(field==='primary')record.recoveryContext!.primaryContext=secret;
    else if(field==='secondary')record.recoveryContext!.secondaryContext!.id=secret;
    else record.recoveryContext!.namespaces[0].namespace[3]=secret;
    const raw=JSON.stringify(record);writeFileSync(f.recordPath,encoded?raw.replace(secret,escaped):raw);
    const result=inspectReleaseReview(f.recordPath,f.context),serialized=JSON.stringify(result);
    assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);assert.equal(result.sourceCommit,null);
    assert.equal(serialized.includes(secret),false);assert.equal(serialized.includes(escaped),false);assert.equal(serialized.includes('"recoveryContext"'),false);
  }
  const normalized=v2(f.inspect(base));normalized.recoveryContext!.primaryContext=secret;
  assert.equal(ReleaseReviewManifestSchema.safeParse(normalized).success,false);
});

test('v2 two sponsor scopes may bind the same exact original file but conflicting byte commitments cannot be collapsed',t=>{
  const f=fixture(t);f.record.sponsorChecks[1].evidence=[{...f.mera}];
  const shared=v2(f.inspect());assert.equal(shared.sponsorChecks[0].status,'PASS');assert.equal(shared.sponsorChecks[1].status,'PASS');
  assert.equal(shared.checks[3].evidence.length,1);assert.equal(ReleaseReviewManifestSchema.safeParse(shared).success,true);
  const collision=structuredClone(shared);collision.sponsorChecks[0].evidence[0].sha256='f'.repeat(64);
  // Map dedup retains the later PRIVY entry. The earlier MERA commitment must
  // still be checked, even though the combined evidence remains unchanged.
  assert.deepEqual(collision.checks[3].evidence,shared.checks[3].evidence);assert.equal(ReleaseReviewManifestSchema.safeParse(collision).success,false);
  f.record.sponsorChecks[0].evidence[0].sha256='f'.repeat(64);const actual=v2(f.inspect());
  assert.equal(actual.sponsorChecks[0].status,'FAIL');assert.equal(actual.sponsorChecks[1].status,'PASS');assert.equal(actual.status,'FAIL');
});

test('v2 partial records with mismatched source or dirty worktree return safe FAIL instead of throwing during normalization',t=>{
  const f=fixture(t);f.record.checks=f.record.checks.slice(0,1);f.record.sponsorChecks=[];
  f.record.sourceCommit='2'.repeat(40);const mismatch=v2(f.inspect());assert.equal(mismatch.status,'FAIL');
  assert.equal(mismatch.checks.every(row=>row.status==='FAIL'),true);assert.equal(mismatch.sponsorChecks.every(row=>row.status==='FAIL'),true);
  f.record.sourceCommit=f.context.commit!;f.context.worktreeDirty=true;const dirty=v2(f.inspect());assert.equal(dirty.status,'FAIL');
  assert.equal(dirty.checks.every(row=>row.status==='FAIL'),true);assert.ok(dirty.issues.some(row=>row.code==='REVIEW_SOURCE_MISMATCH'));
});
