import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,unlinkSync,truncateSync,renameSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {inspectReleaseReview,inspectReleaseEvidence,releaseAssertions,releaseProfiles,releaseReviewScope,ReleaseReviewSchema,readStableReleaseJson,inspectStableLocalAsset,type ReleaseReviewContext,type ReleaseCheckId} from '../scripts/release-review.js';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const ids=Object.keys(releaseAssertions) as ReleaseCheckId[];
function fixture(t:test.TestContext){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'intentpass-release-review-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const save=(path:string,content:string|Buffer)=>{const absolute=join(root,path);mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,content);const bytes=readFileSync(absolute);return {path:absolute,bytes:bytes.length,sha256:hash(bytes)};};
  // These are synthetic unit fixtures. They are never real videos, operator records or acceptance output.
  const product=save('artifacts/release-evidence/product-check.md','synthetic public product check\n');
  const technical=save('artifacts/release-evidence/technical.mp4','synthetic technical fixture\n');
  const pitch=save('artifacts/release-evidence/pitch.mp4','synthetic pitch fixture\n');
  const cleanverse=save('artifacts/release-evidence/cleanverse.mp4','synthetic cleanverse fixture\n');
  const identity=save('artifacts/release-evidence/identity-check.md','synthetic physical device and policy check\n');
  const privacy=save('artifacts/release-evidence/privacy-check.md','synthetic public release review\n');
  const logo=save('artifacts/release-evidence/logo.png',Buffer.from([137,80,78,71,0,1,2,3]));
  const receipt=save('artifacts/release-evidence/submission-receipt.json','{"syntheticUnitFixture":true}\n');
  const original=save('assets/legacy.png',Buffer.from([0,42,43,44]));
  const copy=save('artifacts/release-evidence/legacy.png',readFileSync(original.path));
  const empty=save('empty-public.txt','');
  const candidate={schemaVersion:1 as const,sourceCommit:'1'.repeat(40),productUrl:'https://product.example/intentpass',repositoryUrl:'https://repository.example/intentpass',technicalVideo:{localPath:technical.path,publicUrl:'https://video.example/technical'},pitchVideo:{localPath:pitch.path,publicUrl:'https://video.example/pitch'},cleanverseVideo:{localPath:cleanverse.path,publicUrl:'https://video.example/cleanverse'},logoPath:logo.path,submission:{publicUrl:'https://submission.example/saved',receiptPath:receipt.path}};
  const candidateFile=save('private-assets.json',JSON.stringify(candidate));
  const byId:Record<ReleaseCheckId,typeof product[]>={'D7-01':[product],'D7-02':[technical],'D7-03':[pitch,cleanverse],'D7-04':[identity],'D7-05':[privacy,technical,pitch,cleanverse,logo,copy],'D7-06':[receipt]};
  const record={schemaVersion:1 as const,scope:releaseReviewScope,sourceCommit:candidate.sourceCommit,assetsSha256:candidateFile.sha256,reviewedAt:'2026-10-02T10:01:00.000Z',checks:ids.map(id=>({id,status:'PASS' as 'PASS'|'FAIL'|'BLOCKED',reviewer:'synthetic-operator',assertions:Object.fromEntries(releaseAssertions[id].map(key=>[key,true])),evidence:byId[id].map(e=>({...e}))}))};
  const all=[product,technical,pitch,cleanverse,identity,privacy,logo,receipt,original,copy,empty];
  const unverified=[technical,pitch,cleanverse,logo,original,copy];
  const audit={startedAt:'2026-10-02T10:02:00.000Z',endedAt:'2026-10-02T10:03:00.000Z',scope:'PUBLIC_SOURCE_BUILD_LOG_RAW_BYTES_HEURISTIC_ONLY',status:'BLOCKED',findings:[] as {path:string;line:number;rule:string}[],unverified:unverified.map(e=>relative(root,e.path)),manifest:all.map(e=>({...e,path:relative(root,e.path),binary:unverified.includes(e)}))};
  const assets=[...([['technicalVideo',technical,180],['pitchVideo',pitch,120],['cleanverseVideo',cleanverse,300]] as const).map(([name,evidence,maximumSeconds])=>({name,status:'LOCAL_METADATA_PASS',bytes:evidence.bytes,sha256:evidence.sha256,durationSeconds:maximumSeconds,maximumSeconds})),{name:'logo',status:'LOCAL_METADATA_PASS',bytes:logo.bytes,sha256:logo.sha256},{name:'submissionReceipt',status:'LOCAL_FILE_PRESENT_MANUAL_PLATFORM_VERIFICATION_REQUIRED',bytes:receipt.bytes,sha256:receipt.sha256}];
  const context:ReleaseReviewContext={root,commit:candidate.sourceCommit,sourceCommittedAt:'2026-10-02T10:00:00.000Z',startedAt:'2026-10-02T10:02:00.000Z',checkedAt:'2026-10-02T10:04:00.000Z',worktreeDirty:false,candidateStatus:'VALID',assetsSha256:candidateFile.sha256,candidate,localPassed:true,assets,audit};
  const recordPath=join(root,'private-operator.json');
  const inspect=()=>{writeFileSync(recordPath,JSON.stringify(record));return inspectReleaseReview(recordPath,context);};
  return {root,record,recordPath,context,audit,assets,inspect,save,byId,original,copy,technical,logo,receipt};
}
const issue=(result:ReturnType<typeof inspectReleaseReview>,code:string)=>result.issues.some(item=>item.code===code);
const check=(result:ReturnType<typeof inspectReleaseReview>,id:ReleaseCheckId)=>result.checks.find(item=>item.id===id)!;

test('absent records and partial operator records stay BLOCKED with six ordered checks',t=>{
  const f=fixture(t),absent=inspectReleaseReview(undefined,f.context);
  assert.equal(absent.status,'BLOCKED');assert.equal(absent.sha256,null);assert.deepEqual(absent.checks.map(c=>[c.id,c.status]),ids.map(id=>[id,'BLOCKED']));
  f.record.checks=f.record.checks.slice(0,2);const partial=f.inspect();
  assert.equal(partial.status,'BLOCKED');assert.equal(check(partial,'D7-01').status,'PASS');assert.equal(check(partial,'D7-03').status,'BLOCKED');assert.ok(issue(partial,'MANUAL_CHECK_MISSING'));
  assert.equal(releaseProfiles(partial.checks).find(p=>p.name==='PACT-inspired product')?.status,'BLOCKED');
});
test('complete synthetic operator bindings can pass only in explicit manual integrity scope',t=>{
  const f=fixture(t),result=f.inspect();assert.equal(result.status,'PASS');assert.equal(result.scope,releaseReviewScope);assert.equal(result.sha256,hash(readFileSync(f.recordPath)));
  assert.deepEqual(result.checks.map(c=>c.id),ids);assert.equal(result.privacyReview.status,'PASS');assert.equal(result.privacyReview.reviewedUnverified.length,f.audit.unverified.length);assert.equal(f.audit.status,'BLOCKED');
  const serialized=JSON.stringify(result);assert.equal(serialized.includes(f.root),false);assert.equal(serialized.includes('synthetic-operator'),false);assert.equal(serialized.includes('private-operator'),false);assert.equal(serialized.includes('"reviewer":'),false);
  assert.ok(result.limits.some(limit=>limit.includes('not independent provider attestation')));
  for(const profile of releaseProfiles(result.checks))assert.equal(profile.status,profile.applicable?'PASS':'NOT_STARTED');
});
test('strict records reject unknown fields duplicate checks fake scope and non-Z timestamps',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  const invalid=[{...base,extra:'untrusted'},{...base,scope:'INDEPENDENT_PROVIDER_ATTESTATION'},{...base,checks:[base.checks[0],base.checks[0]]},{...base,reviewedAt:'2026-10-02T18:01:00+08:00'},{...base,checks:[{...base.checks[0],reason:'any reason'}]},{...base,checks:[{...base.checks[0],assertions:{...base.checks[0].assertions,ANY_BOOLEAN:true}}]}];
  for(const record of invalid){assert.equal(ReleaseReviewSchema.safeParse(record).success,false);writeFileSync(f.recordPath,JSON.stringify(record));const result=inspectReleaseReview(f.recordPath,f.context);assert.equal(result.status,'FAIL');assert.equal(result.sha256,null);assert.ok(issue(result,'REVIEW_RECORD_INVALID'));}
});
test('record files must be separate bounded absolute JSON files with no symlink leaf',t=>{
  const f=fixture(t);f.inspect();
  for(const path of ['private-operator.json',join(f.root,'absent.json'),join(f.root,'private-operator.txt')])assert.equal(inspectReleaseReview(path,f.context).status,'FAIL');
  const linked=join(f.root,'linked-record.json');symlinkSync(f.recordPath,linked);assert.equal(inspectReleaseReview(linked,f.context).status,'FAIL');
  writeFileSync(f.recordPath,' '.repeat(65537));assert.equal(inspectReleaseReview(f.recordPath,f.context).status,'FAIL');
});
test('source commit clean state exact candidate bytes and commit-to-run time window are mandatory',t=>{
  const f=fixture(t),base=structuredClone(f.record);
  for(const change of [{sourceCommit:'2'.repeat(40)},{assetsSha256:'2'.repeat(64)},{reviewedAt:'2026-10-02T09:59:59.999Z'},{reviewedAt:'2026-10-02T10:02:00.001Z'}]){Object.assign(f.record,base,change);assert.equal(f.inspect().status,'FAIL');}
  Object.assign(f.record,base);f.context.worktreeDirty=true;assert.equal(f.inspect().status,'FAIL');f.context.worktreeDirty=false;f.context.candidateStatus='FAIL';assert.equal(f.inspect().status,'FAIL');
  f.context.candidateStatus='VALID';f.context.sourceCommittedAt=null;assert.equal(f.inspect().status,'FAIL');
});
test('missing candidate blocks PASS but cannot overwrite explicit operator FAIL',t=>{
  const f=fixture(t);f.context.candidateStatus='BLOCKED';f.context.candidate=undefined;f.context.assetsSha256=null;
  assert.equal(f.inspect().status,'BLOCKED');f.record.checks[0].status='FAIL';const result=f.inspect();assert.equal(result.status,'FAIL');assert.equal(check(result,'D7-01').status,'FAIL');assert.ok(issue(result,'MANUAL_CHECK_FAILED'));
});
test('a declared PASS requires all fixed assertions and a real bound original file',t=>{
  const f=fixture(t);f.record.checks[0].assertions.PUBLIC_HTTPS_PRODUCT_ACCESSIBLE=false;assert.equal(check(f.inspect(),'D7-01').status,'FAIL');
  f.record.checks[0].assertions.PUBLIC_HTTPS_PRODUCT_ACCESSIBLE=true;f.record.checks[0].evidence=[];assert.equal(check(f.inspect(),'D7-01').status,'FAIL');
});
test('byte drift wrong hash and duplicate bindings fail without logging the private path',t=>{
  const f=fixture(t),evidence=f.record.checks[0].evidence[0],original=readFileSync(evidence.path);
  writeFileSync(evidence.path,'changed current bytes');assert.ok(issue(f.inspect(),'EVIDENCE_BYTES_MISMATCH'));writeFileSync(evidence.path,original);
  evidence.sha256='0'.repeat(64);assert.ok(issue(f.inspect(),'EVIDENCE_BYTES_MISMATCH'));evidence.sha256=hash(original);f.record.checks[0].evidence.push({...evidence});assert.ok(issue(f.inspect(),'EVIDENCE_PATH_INVALID'));
});
test('only canonical release-evidence files are read and symlink files or parents fail',t=>{
  const f=fixture(t),evidence=f.record.checks[0].evidence[0],original={...evidence};
  for(const path of [join(f.root,'private-do-not-read.txt'),join(f.root,'artifacts/release-evidence/../private-do-not-read.txt'),join(f.root,'artifacts/release-evidence/.hidden.txt'),join(f.root,'artifacts/release-evidence/evidence.db'),evidence.path.replace('release-evidence/','release-evidence//')]){evidence.path=path;const result=f.inspect();assert.equal(check(result,'D7-01').status,'FAIL');assert.equal(JSON.stringify(result).includes('private-do-not-read'),false);}
  Object.assign(evidence,original);unlinkSync(evidence.path);symlinkSync(f.technical.path,evidence.path);assert.ok(issue(f.inspect(),'PUBLIC_SYMLINK_REJECTED'));
  const directory=join(f.root,'artifacts/release-evidence/linked');symlinkSync(join(f.root,'assets'),directory);evidence.path=join(directory,'legacy.png');assert.ok(issue(f.inspect(),'PUBLIC_SYMLINK_REJECTED'));
});
test('public evidence raw-byte findings fail including secrets split across streaming chunks',t=>{
  const f=fixture(t),content=Buffer.from('x'.repeat(65525)+'\n'+['api','key_'].join('')+'A'.repeat(40));const evidence=f.save('artifacts/release-evidence/unsafe.txt',content);f.record.checks[0].evidence=[evidence];
  const result=f.inspect();assert.equal(check(result,'D7-01').status,'FAIL');assert.ok(issue(result,'PUBLIC_EVIDENCE_UNSAFE'));assert.equal(JSON.stringify(result).includes('A'.repeat(40)),false);
});
test('evidence cap rejects oversized declared and actual sparse files before reading',t=>{
  const f=fixture(t),evidence=f.record.checks[0].evidence[0];
  assert.throws(()=>inspectReleaseEvidence(f.root,{...evidence,path:relative(f.root,evidence.path),bytes:536870913}));
  truncateSync(evidence.path,536870913);assert.throws(()=>inspectReleaseEvidence(f.root,{...evidence,path:relative(f.root,evidence.path)}),/PUBLIC_FILE_INVALID/);
});
test('stable local metadata probes reject bytes or file identity changed between hash and probe',t=>{
  const f=fixture(t),valid=inspectStableLocalAsset(f.technical.path,()=>({syntheticDuration:180}));
  assert.deepEqual(valid.metadata,{bytes:f.technical.bytes,sha256:f.technical.sha256});assert.deepEqual(valid.observation,{syntheticDuration:180});
  assert.throws(()=>inspectStableLocalAsset(f.technical.path,()=>{writeFileSync(f.technical.path,'different short synthetic video');return {syntheticDuration:1};}),/LOCAL_FILE_CHANGED/);
  const replacement=f.save('replacement.mp4',readFileSync(f.technical.path));
  assert.throws(()=>inspectStableLocalAsset(f.technical.path,()=>{renameSync(replacement.path,f.technical.path);return {syntheticDuration:1};}),/LOCAL_FILE_CHANGED/);
});
test('local asset metadata hashes bounded regular files and rejects symlink empty private or oversized inputs',t=>{
  const f=fixture(t);assert.deepEqual(inspectStableLocalAsset(f.logo.path).metadata,{bytes:f.logo.bytes,sha256:f.logo.sha256});
  const empty=f.save('empty.png',''),secretName=join(f.root,'.env'),linked=join(f.root,'linked.png');symlinkSync(f.logo.path,linked);
  for(const path of [empty.path,secretName,linked,'relative.png'])assert.throws(()=>inspectStableLocalAsset(path));
  truncateSync(f.logo.path,536870913);assert.throws(()=>inspectStableLocalAsset(f.logo.path),/LOCAL_FILE_INVALID/);
});
test('private JSON reader bounds actual reads and never treats a directory or symlink as a candidate record',t=>{
  const f=fixture(t);f.inspect();assert.deepEqual(readStableReleaseJson(f.recordPath),readFileSync(f.recordPath));
  const directory=join(f.root,'directory.json');mkdirSync(directory);assert.throws(()=>readStableReleaseJson(directory),/LOCAL_FILE_INVALID/);
  const linked=join(f.root,'candidate-linked.json');symlinkSync(f.recordPath,linked);assert.throws(()=>readStableReleaseJson(linked),/LOCAL_FILE_INVALID/);
  truncateSync(f.recordPath,65537);assert.throws(()=>readStableReleaseJson(f.recordPath),/LOCAL_FILE_INVALID/);
});
test('original audit findings malformed status and future or stale audit time cannot be waived',t=>{
  const f=fixture(t),base=structuredClone(f.audit);
  const invalid=[{...base,status:'FAIL',findings:[{path:'public.txt',line:1,rule:'API_KEY_LITERAL'}]},{...base,status:'PASS'},{...base,startedAt:'2026-10-02T10:01:59.999Z'},{...base,endedAt:'2026-10-02T10:04:00.001Z'},{...base,endedAt:'2026-10-02T10:01:00.000Z'}];
  for(const audit of invalid){f.context.audit=audit;const result=f.inspect();assert.equal(result.status,'FAIL');assert.equal(result.privacyReview.status,'FAIL');assert.equal(check(result,'D7-05').status,'FAIL');}
  f.context.audit=invalid[0];assert.equal(inspectReleaseReview(undefined,f.context).status,'FAIL');
});
test('manual media clearance requires every unverified original to retain its exact bytes and a bound copy',t=>{
  const f=fixture(t),original=readFileSync(f.original.path);
  writeFileSync(f.original.path,Buffer.from([0,99,98,97]));assert.ok(issue(f.inspect(),'AUDIT_UNVERIFIED_BYTES_CHANGED'));writeFileSync(f.original.path,original);
  f.record.checks.find(c=>c.id==='D7-05')!.evidence=f.byId['D7-05'].filter(e=>e.path!==f.copy.path);const result=f.inspect();assert.ok(issue(result,'MANUAL_MEDIA_EVIDENCE_MISSING'));assert.equal(result.privacyReview.status,'FAIL');
});
test('unverified paths cannot point to private files or missing symlink-only manifest entries',t=>{
  const f=fixture(t);f.audit.unverified.push('../private-do-not-read.png');f.audit.manifest.push({path:'../private-do-not-read.png',bytes:1,sha256:'0'.repeat(64),binary:true});assert.equal(f.inspect().status,'FAIL');
  f.audit.unverified=f.audit.unverified.filter(path=>path!=='../private-do-not-read.png');f.audit.manifest=f.audit.manifest.filter(e=>e.path!==relative(f.root,f.original.path));assert.ok(issue(f.inspect(),'AUDIT_UNVERIFIED_BINDING_INVALID'));
});
test('video logo and receipt metadata must match exact bound files and valid local metadata limits',t=>{
  const f=fixture(t),base=structuredClone(f.assets);
  for(const [name,id] of [['technicalVideo','D7-02'],['pitchVideo','D7-03'],['cleanverseVideo','D7-03'],['logo','D7-05'],['submissionReceipt','D7-06']] as const){
    f.context.assets=base.map(asset=>asset.name===name?{...asset,sha256:'3'.repeat(64)}:asset);assert.equal(check(f.inspect(),id).status,'FAIL');
    f.context.assets=base.filter(asset=>asset.name!==name);assert.equal(check(f.inspect(),id).status,'BLOCKED');
  }
  for(const durationSeconds of [0,-1,Infinity,NaN,180.001]){f.context.assets=base.map(asset=>asset.name==='technicalVideo'?{...asset,durationSeconds}:asset);assert.ok(issue(f.inspect(),'REQUIRED_ASSET_METADATA_INVALID'));}
  f.context.assets=base.map(asset=>asset.name==='pitchVideo'?{...asset,maximumSeconds:180}:asset);assert.ok(issue(f.inspect(),'REQUIRED_ASSET_METADATA_INVALID'));
  f.context.assets=base.map(asset=>asset.name==='logo'?{...asset,bytes:3000001}:asset);assert.ok(issue(f.inspect(),'REQUIRED_ASSET_METADATA_INVALID'));
});
test('local prerequisites and actual declared product repository and submission are required',t=>{
  const f=fixture(t);f.context.localPassed=false;const failed=f.inspect();assert.equal(failed.status,'FAIL');assert.ok(issue(failed,'LOCAL_RELEASE_PREREQUISITES_INCOMPLETE'));
  f.context.localPassed=true;f.context.candidate={...f.context.candidate!,productUrl:null,repositoryUrl:null,submission:null};const blocked=f.inspect();assert.equal(blocked.status,'BLOCKED');for(const id of ['D7-01','D7-05','D7-06'] as const)assert.equal(check(blocked,id).status,'BLOCKED');
});
test('profile states reflect required checks independently and keep Full PACT inapplicable',()=>{
  const checks=ids.map(id=>({id,status:'PASS' as 'PASS'|'FAIL'|'BLOCKED'}));checks.find(c=>c.id==='D7-04')!.status='BLOCKED';
  const profiles=releaseProfiles(checks);assert.deepEqual(profiles.map(p=>[p.name,p.status]),[['Full PACT / IMAS / CDAS','NOT_STARTED'],['PACT-inspired product','BLOCKED'],['Cleanverse CVA/CVI','PASS'],['Privy','BLOCKED'],['Mera','BLOCKED'],['JEV','PASS']]);
  checks.find(c=>c.id==='D7-02')!.status='FAIL';for(const profile of releaseProfiles(checks).filter(p=>p.applicable))assert.equal(profile.status,'FAIL');
});
