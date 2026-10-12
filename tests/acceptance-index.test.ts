import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,unlinkSync,symlinkSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {acceptanceRequirements,buildAcceptanceIndex,renderAcceptanceIndex,writeAcceptanceIndex,checkAcceptanceIndex} from '../scripts/acceptance-index.js';
import {inspectReleaseReview,releaseAssertions,releaseSponsorAssertions,releaseProfiles} from '../scripts/release-review.js';
import {inspectDay5Review} from '../scripts/day5-review.js';
import {day5Assertions,day5CheckIds,day5ReviewScope} from '../scripts/day5-review-types.js';
const spec=readFileSync('tests/support/legacy-acceptance-spec.md','utf8'),head='a'.repeat(40),generatedAt='2026-10-02T12:00:00.000Z',commands=[['typecheck','build','test:unit','test:contract','demo:local','doctor'],['typecheck','build','test:unit','test:contract:monad'],['typecheck','build','test:unit','test:contract','abi:check','demo:local','test:contract:monad','demo:monad-local'],['typecheck','build','test:unit','test:contract:monad','abi:check','demo:monad-local'],['typecheck','build','test:unit'],['typecheck','build','test:unit','test:contract:monad','audit:public'],['typecheck','build','test:unit','audit:public']];
const passIds=new Set(['D1-02','D1-07','D2-05','D2-06','D2-07','D3-01','D3-02','D3-03','D3-04','D3-05','D3-06','D3-08','D6-01','D7-07']);
const tap='TAP version 13\n# Subtest: LOCAL_INDEX_INPUT_FORMAT_DOUBLE\nok 1 - LOCAL_INDEX_INPUT_FORMAT_DOUBLE\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n';
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'intentpass-index-'))),write=(path:string,value:string)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);},reports:Record<string,any>={};write('docs/implementation-spec.md',spec);write('docs/acceptance.csv','OLD_CSV_CLAIM_DO_NOT_TRUST,PASS\n');
  for(let day=1;day<=7;day++){
    const name=`D${day}`,items=acceptanceRequirements(spec).filter(row=>row.day===name).map(row=>({id:row.id,status:row.applicable?(passIds.has(row.id)?'PASS':'BLOCKED'):'NOT_STARTED',...(day===3?{applicable:row.applicable}:{}),reason:'LOCAL_INDEX_INPUT_FORMAT_DOUBLE; no real provider evidence',...(row.id==='D6-01'?{scope:'LOCAL_DETERMINISTIC_APPLICATION_AND_MONAD_NATIVE_TESTS'}:row.id==='D7-07'?{scope:'HONEST_PROFILE_REPORTING_ONLY_NOT_RELEASE_ELIGIBILITY'}:{})}));
    const report={stage:name,settlementRoute:'context-vote-escrow',scope:'LOCAL_INDEX_INPUT_FORMAT_DOUBLE',status:day===3?'PASS':'BLOCKED',...(day===5?{}:{commit:head,worktreeDirty:true}),startedAt:'2026-10-01T00:00:00.000Z',endedAt:'2026-10-01T00:00:01.000Z',runs:commands[day-1].map(command=>({command:'pnpm run '+command,exitCode:command==='doctor'||command==='audit:public'?1:0,evidence:`artifacts/acceptance/day${day}-${command.replaceAll(':','-')}.log`})),...(day>=4?{acceptance:items}:{items}),...(day===7?{profiles:['Full PACT / IMAS / CDAS','PACT-inspired product','Cleanverse CVA/CVI','Privy','Mera','JEV'].map((name,index)=>({name,applicable:index!==0,status:index===0?'NOT_STARTED':'BLOCKED',reason:'LOCAL_INDEX_FORMAT_DOUBLE_NOT_REAL_RELEASE'}))}:{})};
    reports[name]=report;for(const run of report.runs)write(run.evidence,run.command==='pnpm run test:unit'?tap:run.command.startsWith('pnpm run test:contract')?'Ran 1 test suite in 1ms: 1 tests passed, 0 failed, 0 skipped (1 total tests)\n':'LOCAL_INDEX_INPUT_FORMAT_DOUBLE\n');write(`artifacts/acceptance/day${day}.json`,JSON.stringify(report));
  }
  const save=(day:string)=>write(`artifacts/acceptance/day${day.slice(1)}.json`,JSON.stringify(reports[day]));return {root,reports,write,save,meta:{generatedAt,head,worktreeDirty:true,snapshotId:'index-fixture-1'},close:()=>rmSync(root,{recursive:true,force:true})};
}
test('acceptance index retains all 49 normative requirements, historical scopes and missing metadata without inheriting local PASS or legacy CSV claims',()=>{
  const f=fixture();try{const {report}=buildAcceptanceIndex(f.root,f.meta);assert.equal(report.status,'BLOCKED');assert.deepEqual(report.counts,{total:49,applicable:48,PASS:14,FAIL:0,BLOCKED:34,NOT_STARTED:1});assert.equal(report.issues.length,0);assert.deepEqual(report.items.map(row=>row.id),acceptanceRequirements(spec).map(row=>row.id));
    assert.equal(report.items.find(row=>row.id==='D3-07')!.applicable,false);assert.equal(report.items.find(row=>row.id==='D3-07')!.result,'NOT_STARTED');assert.equal(report.items.find(row=>row.id==='D7-07')!.evidenceScope,'HONEST_PROFILE_REPORTING_ONLY_NOT_RELEASE_ELIGIBILITY');assert.equal(report.items.find(row=>row.id==='D5-01')!.commit,null);assert.equal(report.items.find(row=>row.id==='D5-01')!.worktreeDirty,null);assert.ok(report.items.every(row=>row.sourceCoverage==='HISTORICAL_OPERATOR_REPORT_NOT_CURRENT_HEAD_ATTESTATION'));assert.ok(report.stages.every(stage=>stage.reference?.snapshotPath));assert.ok(report.stages.flatMap(stage=>stage.runs).every(run=>run.file.snapshotPath));
    assert.throws(()=>acceptanceRequirements(spec.replace('| D6-07 |','| D6-08 |')),/SPEC_IDS_INVALID/);assert.throws(()=>acceptanceRequirements(spec+'\n| D6-01 | Duplicate | Bad |'),/SPEC_IDS_INVALID/);
  }finally{f.close();}
});
test('D6 measured review PASS requires fixed original development calibration policy and complete evaluation bindings',()=>{
  const paths={policySha256:'artifacts/acceptance/review-policy.json',developmentSha256:'artifacts/acceptance/review-dev-calibrated.json',sourceDevelopmentSha256:'artifacts/acceptance/review-dev.json',holdoutSha256:'artifacts/acceptance/review-holdout.json',criticalSha256:'artifacts/acceptance/review-critical.json'};
  const setup=()=>{const f=fixture();for(const p of [...Object.values(paths),'fixtures/review-manifest.json','fixtures/dev/review-cases.json','fixtures/holdout/review-cases.json'])f.write(p,readFileSync(p,'utf8'));
    // Local index format tests reuse saved public inputs/responses; they make no provider request.
    const now=new Date().toISOString();f.meta.generatedAt=now;f.reports.D6.endedAt=now;
    f.reports.D6.reviewEvidence={version:1,model:'jev-1.13.0',...Object.fromEntries(Object.entries(paths).map(([key,p])=>[key,createHash('sha256').update(readFileSync(p)).digest('hex')]))};
    for(const [id,p,reason] of [['D6-02',paths.holdoutSha256,'COMPLETE_HOLDOUT_MEASUREMENT_QUALITY_REPORTED'],['D6-03',paths.criticalSha256,'COMPLETE_CRITICAL_EVALUATION_REPORT_VALIDATED']])Object.assign(f.reports.D6.acceptance.find((item:{id:string})=>item.id===id),{status:'PASS',scope:'OPERATOR_REPORT_INTEGRITY_NOT_PROVIDER_ATTESTATION',evidence:p,reason});
    f.save('D6');return f;};
  const valid=setup();try{const r=buildAcceptanceIndex(valid.root,valid.meta).report;assert.equal(r.schemaVersion,2);assert.equal(r.issues.length,0);assert.equal(r.counts.PASS,16);assert.equal(r.status,'BLOCKED');assert.equal(r.items.find(i=>i.id==='D6-02')!.result,'PASS');}finally{valid.close();}
  for(const mode of ['wrong-hash','changed-decision','private-path'] as const){const f=setup();try{
    if(mode==='wrong-hash')f.reports.D6.reviewEvidence.policySha256='0'.repeat(64);
    else {
      const policy=JSON.parse(readFileSync(join(f.root,paths.policySha256),'utf8'));
      if(mode==='private-path'){f.write('.env','PRIVATE_SENTINEL_MUST_NOT_BE_READ');policy.developmentReportPath='.env';}
      else {const dev=JSON.parse(readFileSync(join(f.root,paths.developmentSha256),'utf8'));dev.results[4].actual='PASS';f.write(paths.developmentSha256,JSON.stringify(dev));const hash=createHash('sha256').update(readFileSync(join(f.root,paths.developmentSha256))).digest('hex');policy.developmentReportSha256=hash;f.reports.D6.reviewEvidence.developmentSha256=hash;}
      f.write(paths.policySha256,JSON.stringify(policy));f.reports.D6.reviewEvidence.policySha256=createHash('sha256').update(readFileSync(join(f.root,paths.policySha256))).digest('hex');
    }
    f.save('D6');const {report,snapshots}=buildAcceptanceIndex(f.root,f.meta);assert.ok(report.issues.some(i=>i.code==='REAL_REVIEW_EVIDENCE_INVALID'));assert.equal(report.items.find(i=>i.id==='D6-02')!.result,'FAIL');assert.ok(![...snapshots.values()].some(b=>b.includes(Buffer.from('PRIVATE_SENTINEL_MUST_NOT_BE_READ'))));
  }finally{f.close();}}
});
test('missing corrupt duplicate future misrouted inapplicable or contradictory reports never produce an inherited PASS',()=>{
  const variations=[(f:ReturnType<typeof fixture>)=>unlinkSync(join(f.root,'artifacts/acceptance/day2.json')),(f:ReturnType<typeof fixture>)=>f.write('artifacts/acceptance/day2.json','{'),(f:ReturnType<typeof fixture>)=>{f.reports.D2.items[0]=f.reports.D2.items[1];f.save('D2');},(f:ReturnType<typeof fixture>)=>{f.reports.D2.endedAt='2026-10-03T00:00:00.000Z';f.save('D2');},(f:ReturnType<typeof fixture>)=>{f.reports.D2.route='full-pact-reuse';f.save('D2');},(f:ReturnType<typeof fixture>)=>{f.reports.D2.items[4].applicable=false;f.save('D2');},(f:ReturnType<typeof fixture>)=>{f.reports.D2.status='PASS';f.save('D2');},(f:ReturnType<typeof fixture>)=>{f.reports.D2.items[0].status='PASS';f.save('D2');}];
  for(const change of variations){const f=fixture();try{change(f);const {report}=buildAcceptanceIndex(f.root,f.meta);assert.ok(report.issues.some(issue=>issue.stage==='D2'));assert.notEqual(report.items.find(row=>row.id==='D2-05')!.result,'PASS');assert.equal(report.items.find(row=>row.id==='D6-01')!.result,'PASS');assert.notEqual(report.status,'PASS');assert.equal(report.items.length,49);}finally{f.close();}}
  const failed=fixture();try{failed.reports.D5.status='FAIL';failed.save('D5');assert.equal(buildAcceptanceIndex(failed.root,failed.meta).report.items.find(row=>row.id==='D5-01')!.result,'FAIL');}finally{failed.close();}
  const f=fixture();try{f.reports.D7.profiles[1].status='PASS';f.save('D7');assert.equal(buildAcceptanceIndex(f.root,f.meta).report.items.find(row=>row.id==='D7-07')!.result,'FAIL');}finally{f.close();}
});
test('reported success cannot hide incomplete TAP contract output cancelled commands or a failed local run',()=>{
  const variants=[tap.replace('# fail 0','# fail 1'),tap.replace('# cancelled 0','# cancelled 1'),tap.replace('# skipped 0','# skipped 1'),'# Subtest: partial result only\n'];
  for(const output of variants){const f=fixture();try{f.write('artifacts/acceptance/day6-test-unit.log',output);assert.equal(buildAcceptanceIndex(f.root,f.meta).report.items.find(row=>row.id==='D6-01')!.result,'FAIL');}finally{f.close();}}
  for(const phase of ['native','signal','exit','duplicate-command','missing-log'] as const){const f=fixture();try{if(phase==='native')f.write('artifacts/acceptance/day6-test-contract-monad.log','[PASS] A partial test without a completed suite\n');else if(phase==='missing-log')unlinkSync(join(f.root,'artifacts/acceptance/day6-build.log'));else if(phase==='signal')f.reports.D6.runs[0].signal='SIGTERM';else if(phase==='exit')f.reports.D6.runs[0].exitCode=1;else f.reports.D6.runs[0]=f.reports.D6.runs[1];f.save('D6');assert.notEqual(buildAcceptanceIndex(f.root,f.meta).report.items.find(row=>row.id==='D6-01')!.result,'PASS');}finally{f.close();}}
});
test('index refuses private paths symlinks and unsafe report text, and renders literal notes safely in CSV and Markdown',()=>{
  for(const path of ['.env','../secret.txt','https://remote.example/evidence','artifacts/acceptance/private.db']){const f=fixture();try{f.write('.env','LOCAL_PRIVATE_INPUT_MUST_NOT_BE_READ');f.reports.D2.items[4].evidence=path;f.save('D2');const {report,snapshots}=buildAcceptanceIndex(f.root,f.meta);assert.equal(report.items.find(row=>row.id==='D2-05')!.result,'FAIL');assert.ok(![...snapshots.values()].some(bytes=>bytes.includes(Buffer.from('LOCAL_PRIVATE_INPUT_MUST_NOT_BE_READ'))));}finally{f.close();}}
  const f=fixture();try{const target=join(f.root,'artifacts/acceptance/day2-build.log');unlinkSync(target);f.write('private-source','LOCAL_PRIVATE_INPUT_MUST_NOT_BE_READ');symlinkSync(join(f.root,'private-source'),target);assert.equal(buildAcceptanceIndex(f.root,f.meta).report.items.find(row=>row.id==='D2-05')!.result,'FAIL');}finally{f.close();}
  const g=fixture();try{const syntheticCredential='sk-'+randomBytes(32).toString('hex');g.reports.D2.untrustedExtra={apiKey:syntheticCredential};g.save('D2');const {report,snapshots}=buildAcceptanceIndex(g.root,g.meta);assert.equal(report.items.find(row=>row.id==='D2-05')!.result,'FAIL');assert.ok(![...snapshots.values()].some(bytes=>bytes.includes(Buffer.from(syntheticCredential))));assert.ok(!JSON.stringify(report).includes(syntheticCredential));}finally{g.close();}
  const h=fixture();try{h.reports.D2.items[4].reason='=HYPERLINK("https://remote.example", "x")\n<script>|claim</script>';h.save('D2');const rendered=renderAcceptanceIndex(buildAcceptanceIndex(h.root,h.meta).report);assert.ok(rendered.csv.includes("\"'=HYPERLINK(\"\"https://remote.example\"\""));assert.ok(rendered.markdown.includes('&lt;script&gt;\\|claim&lt;/script&gt;'));assert.ok(!rendered.markdown.includes('<script>'));}finally{h.close();}
});
test('refresh pins original reports and logs, archives old tables, and independent check detects output source and snapshot tampering without rerunning stages',()=>{
  const f=fixture();try{const first=writeAcceptanceIndex(f.root,f.meta);assert.equal(checkAcceptanceIndex(f.root).status,'BLOCKED');assert.ok(readFileSync(join(f.root,'artifacts/acceptance/history/index-fixture-1-index/docs__acceptance.csv'),'utf8').includes('OLD_CSV_CLAIM'));const source=first.items.find(row=>row.id==='D2-05')!.evidence!;assert.equal(createHash('sha256').update(readFileSync(join(f.root,source.snapshotPath!))).digest('hex'),source.sha256);
    const cli=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),resolve('scripts/acceptance-index.ts'),'--check'],{cwd:f.root,encoding:'utf8',timeout:15000});assert.equal(cli.status,1,cli.stderr);assert.equal(cli.signal,null);assert.equal(JSON.parse(cli.stdout).status,'BLOCKED');assert.equal(JSON.parse(cli.stdout).counts.PASS,14);
    const csv=readFileSync(join(f.root,'docs/acceptance.csv'),'utf8');f.write('docs/acceptance.csv',csv.replace('D6-01,D6','D6-99,D6'));assert.throws(()=>checkAcceptanceIndex(f.root),/INDEX_STALE_OR_MODIFIED/);f.write('docs/acceptance.csv',csv);
    f.reports.D2.items[4].reason='Changed operator record';f.save('D2');assert.throws(()=>checkAcceptanceIndex(f.root),/INDEX_STALE_OR_MODIFIED/);const second=writeAcceptanceIndex(f.root,{...f.meta,snapshotId:'index-fixture-2'});assert.equal(checkAcceptanceIndex(f.root).status,'BLOCKED');assert.notEqual(second.items.find(row=>row.id==='D2-05')!.evidence!.sha256,source.sha256);assert.equal(createHash('sha256').update(readFileSync(join(f.root,source.snapshotPath!))).digest('hex'),source.sha256);
    const pinned=second.items.find(row=>row.id==='D2-05')!.evidence!.snapshotPath!;f.write(pinned,'Modified snapshot');assert.throws(()=>checkAcceptanceIndex(f.root),/INDEX_SNAPSHOT_INVALID/);assert.ok(!existsSync(join(f.root,'MODEL_OR_WALLET_CALLED')));
  }finally{f.close();}
});
function manualReleaseFixture(){
  const f=fixture(),report=f.reports.D7,sourceCommittedAt='2026-09-30T00:00:00.000Z',checkedAt='2026-10-01T00:00:00.800Z';
  // All content, metadata, timestamps and human assertions here are explicit
  // temporary format doubles. No video, provider, person or release is attested.
  const binding=(name:string,extension:string)=>{const path=`artifacts/release-evidence/${name}.${extension}`,bytes=Buffer.from(`LOCAL_RELEASE_FORMAT_DOUBLE_${name}`);f.write(path,bytes.toString());return {path:join(f.root,path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
  const originals={technicalVideo:binding('technical','mp4'),pitchVideo:binding('pitch','mp4'),cleanverseVideo:binding('cleanverse','mp4'),logo:binding('logo','png'),submissionReceipt:binding('receipt','json'),walkthrough:binding('walkthrough','md'),device:binding('device','md')};
  const assets=Object.entries(originals).filter(([name])=>!['walkthrough','device'].includes(name)).map(([name,b])=>({name,status:name==='submissionReceipt'?'LOCAL_FILE_PRESENT_MANUAL_PLATFORM_VERIFICATION_REQUIRED':'LOCAL_METADATA_PASS',bytes:b.bytes,sha256:b.sha256,...(name.endsWith('Video')?{durationSeconds:2,maximumSeconds:name==='technicalVideo'?180:name==='pitchVideo'?120:300}:{})}));
  const candidate={schemaVersion:1 as const,sourceCommit:head,productUrl:'https://product.example',repositoryUrl:'https://repository.example',technicalVideo:{localPath:originals.technicalVideo.path,publicUrl:'https://video.example/technical'},pitchVideo:{localPath:originals.pitchVideo.path,publicUrl:'https://video.example/pitch'},cleanverseVideo:{localPath:originals.cleanverseVideo.path,publicUrl:'https://video.example/cleanverse'},logoPath:originals.logo.path,submission:{publicUrl:'https://submission.example/receipt',receiptPath:originals.submissionReceipt.path}},assetsSha256=createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
  const byId={'D7-01':[originals.walkthrough],'D7-02':[originals.technicalVideo],'D7-03':[originals.pitchVideo,originals.cleanverseVideo],'D7-04':[originals.device],'D7-05':[originals.logo,originals.walkthrough],'D7-06':[originals.submissionReceipt]};
  const record={schemaVersion:1,scope:'OPERATOR_RECORDED_MANUAL_RELEASE_CHECKS',sourceCommit:head,assetsSha256,reviewedAt:report.startedAt,checks:Object.entries(releaseAssertions).map(([id,keys])=>({id,status:'PASS',reviewer:'FORMAT_DOUBLE',assertions:Object.fromEntries(keys.map(key=>[key,true])),evidence:byId[id as keyof typeof byId]}))};
  const audit={startedAt:report.startedAt,endedAt:'2026-10-01T00:00:00.500Z',scope:'PUBLIC_SOURCE_BUILD_LOG_RAW_BYTES_HEURISTIC_ONLY',status:'PASS',findings:[],unverified:[],manifest:[{path:originals.walkthrough.path.slice(f.root.length+1),bytes:originals.walkthrough.bytes,sha256:originals.walkthrough.sha256,binary:false}]};
  f.write('operator-review.json',JSON.stringify(record));f.write('artifacts/acceptance/public-audit.json',JSON.stringify(audit));
  const review=inspectReleaseReview(join(f.root,'operator-review.json'),{root:f.root,commit:head,sourceCommittedAt,startedAt:report.startedAt,checkedAt,worktreeDirty:false,candidateStatus:'VALID',assetsSha256,candidate,localPassed:true,assets,audit});assert.equal(review.status,'PASS',JSON.stringify(review.issues));
  Object.assign(report,{status:'PASS',worktreeDirty:false,sourceCommittedAt,releaseReview:review,candidate:{status:'VALID',sha256:assetsSha256,sourceMatchesCleanCommit:true,productUrlDeclared:true,repositoryUrlDeclared:true,publicUrlsVerified:true,technicalVideoDeclared:true,pitchVideoDeclared:true,cleanverseVideoDeclared:true,submissionDeclared:true},assets,profiles:releaseProfiles(review.checks)});
  for(const item of report.acceptance)if(item.id!=='D7-07')Object.assign(item,{status:'PASS',scope:'OPERATOR_RECORDED_MANUAL_RELEASE_CHECKS',reason:'LOCAL_FORMAT_DOUBLE_NOT_REAL_RELEASE'});
  report.runs.find((run:{command:string})=>run.command==='pnpm run audit:public').exitCode=0;f.save('D7');return {...f,originals,record};
}
test('index rechecks recorded manual-release assertion and public-file integrity without upgrading other stages or attesting synthetic human/provider provenance',()=>{
  const f=manualReleaseFixture();try{
    const report=buildAcceptanceIndex(f.root,f.meta).report;assert.equal(report.issues.length,0,JSON.stringify(report.issues));assert.equal(report.stages.find(stage=>stage.day==='D7')!.reportStatus,'PASS');assert.equal(report.items.find(item=>item.id==='D7-02')!.result,'PASS');assert.equal(report.items.find(item=>item.id==='D7-02')!.evidenceScope,'OPERATOR_RECORDED_MANUAL_RELEASE_CHECKS');assert.equal(report.status,'BLOCKED');assert.equal(report.counts.PASS,20);assert.ok(report.limits.some(limit=>limit.includes('not independent provider or human-provenance')));assert.ok(report.files.some(file=>file.path==='artifacts/release-evidence/technical.mp4'&&file.snapshotPath===null));
    // A binary BLOCKED audit can be resolved only by the separately scoped
    // operator record and exact original/copy bindings, never by a changed exit.
    const r=f.reports.D7,originalPath='assets/brand/intentpass-logo.png';f.write(originalPath,readFileSync(f.originals.logo.path,'utf8'));const binding={path:originalPath,bytes:f.originals.logo.bytes,sha256:f.originals.logo.sha256},audit=JSON.parse(readFileSync(join(f.root,'artifacts/acceptance/public-audit.json'),'utf8'));audit.status='BLOCKED';audit.unverified=[originalPath];audit.manifest.push({...binding,binary:true});f.write('artifacts/acceptance/public-audit.json',JSON.stringify(audit));r.releaseReview.privacyReview.reviewedUnverified=[binding];r.runs.find((run:{command:string})=>run.command==='pnpm run audit:public').exitCode=1;f.save('D7');const cleared=buildAcceptanceIndex(f.root,f.meta).report;assert.equal(cleared.issues.length,0,JSON.stringify(cleared.issues));assert.equal(cleared.items.find(item=>item.id==='D7-05')!.result,'PASS');assert.equal(cleared.status,'BLOCKED');
  }finally{f.close();}
  for(const mode of ['source','dirty','asset-hash','future','checked-future','assertion','evidence','private-path','env-prefix','profile','metadata','video-swap','video-declaration','oversized-logo','audit-findings','audit-time','audit-exit','audit-duplicate','audit-binary-false','audit-status','media-copy-missing'] as const){
    const f=manualReleaseFixture();try{const r=f.reports.D7;
      if(mode==='source')r.releaseReview.sourceCommit='b'.repeat(40);else if(mode==='dirty')r.worktreeDirty=true;else if(mode==='asset-hash')r.releaseReview.assetsSha256='b'.repeat(64);else if(mode==='future')r.releaseReview.reviewedAt='2026-10-01T00:00:02.000Z';else if(mode==='checked-future')r.releaseReview.timeWindow.checkedAt='2026-10-01T00:00:02.000Z';else if(mode==='assertion')r.releaseReview.checks[1].assertions.TECHNICAL_VIDEO_WITHIN_180_SECONDS=false;else if(mode==='evidence')f.write('artifacts/release-evidence/technical.mp4','CHANGED_FORMAT_DOUBLE');else if(mode==='private-path')r.releaseReview.checks[1].evidence[0].path='.env';else if(mode==='env-prefix'){const path='artifacts/release-evidence/env-private.json';f.write(path,readFileSync(f.originals.technicalVideo.path,'utf8'));r.releaseReview.checks[1].evidence[0].path=path;}else if(mode==='profile')r.profiles[1].status='BLOCKED';else if(mode==='metadata')r.assets[0].durationSeconds=181;else if(mode==='video-swap')r.assets[0].sha256=r.assets[1].sha256;else if(mode==='video-declaration')r.candidate.cleanverseVideoDeclared=false;else if(mode==='oversized-logo'){const bytes=Buffer.alloc(3000001,65),sha256=createHash('sha256').update(bytes).digest('hex');f.write('artifacts/release-evidence/logo.png',bytes.toString());Object.assign(r.assets.find((a:{name:string})=>a.name==='logo'),{bytes:bytes.length,sha256});Object.assign(r.releaseReview.checks[4].evidence[0],{bytes:bytes.length,sha256});}else {
        const a=JSON.parse(readFileSync(join(f.root,'artifacts/acceptance/public-audit.json'),'utf8'));
        if(mode==='audit-findings')a.findings=[{path:'test',line:1,rule:'PRIVATE_FORMAT_DOUBLE'}];else if(mode==='audit-time')a.endedAt='2026-10-01T00:00:02.000Z';else if(mode==='audit-exit')r.runs.find((run:{command:string})=>run.command==='pnpm run audit:public').exitCode=2;else if(mode==='audit-duplicate')a.manifest.push({...a.manifest[0]});else {
          const path=mode==='media-copy-missing'?'artifacts/release-evidence/unreviewed.png':'artifacts/release-evidence/walkthrough.md';if(mode==='media-copy-missing')f.write(path,'EXPLICIT_SYNTHETIC_UNREVIEWED_MEDIA');const bytes=readFileSync(join(f.root,path)),b={path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};a.unverified=[path];a.manifest=[{...b,binary:mode!=='audit-binary-false'}];a.status=mode==='audit-status'?'PASS':'BLOCKED';r.releaseReview.privacyReview.reviewedUnverified=[b];r.runs.find((run:{command:string})=>run.command==='pnpm run audit:public').exitCode=a.status==='PASS'?0:1;
        }f.write('artifacts/acceptance/public-audit.json',JSON.stringify(a));
      }
      f.save('D7');const report=buildAcceptanceIndex(f.root,f.meta).report;assert.ok(report.issues.some(issue=>issue.stage==='D7'),mode);assert.equal(report.items.find(item=>item.id==='D7-02')!.result,'FAIL',mode);assert.equal(report.items.find(item=>item.id==='D6-01')!.result,'PASS');
    }finally{f.close();}
  }
});

function manualDay5Fixture(partial=false){
  const f=fixture(),r=f.reports.D5,sourceCommittedAt='2026-09-30T00:00:00.000Z',h=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
  // Explicit temporary format doubles only. These records do not attest a
  // browser, person, Mera ceremony, public deployment or funds movement.
  const snapshot={chainId:'10143',arbiter:'0x'+'1'.repeat(40),asset:'0x'+'2'.repeat(40),orderId:h(2),contextHash:h(3),buyer:'0x'+'3'.repeat(40),seller:'0x'+'4'.repeat(40),payee:'0x'+'5'.repeat(40),price:'2',bond:'1',deliveryDeadline:'100',settlementDeadline:'200',datasetHash:h(5),serviceTermsHash:h(6),evidenceHash:h(0),voteMask:0,state:'FUNDED',credits:{buyer:'0',payee:'0'},withdrawn:{buyer:'0',payee:'0'},accounting:{locked:'3',outstanding:'0',balance:'3'},block:{number:'10',hash:h(4),timestamp:'50'}};
  const bindings=day5CheckIds.map(id=>{const path=`artifacts/release-evidence/d5/${id}.${id==='D5-04'?'json':'md'}`,bytes=Buffer.from(id==='D5-04'?JSON.stringify(snapshot):`SYNTHETIC_D5_INDEX_FORMAT_DOUBLE_${id}`);f.write(path,bytes.toString());return {path:join(f.root,path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
  const configuration={publicUrl:'https://product.example/intentpass',rpId:'product.example'};
  const context={configuration,observationsStartedAt:'2026-09-30T01:00:00.000Z',observationsEndedAt:'2026-09-30T02:00:00.000Z',primaryContext:'synthetic-profile-A',secondaryContext:{id:'synthetic-profile-B',kind:'NEW_BROWSER_PROFILE'},namespaces:[{namespace:['intentpass','v1','memory',h(1)],objectId:h(1),revision:'1'},{namespace:['intentpass','v1','authorization',h(2)],objectId:h(2),revision:'1'}],originalOrder:{chainId:10143,escrow:'0x'+'1'.repeat(40),taskId:h(1),orderId:h(2),contextHash:h(3),finalizedObservation:{blockNumber:'10',blockHash:h(4),state:'FUNDED',evidenceSha256:bindings[3].sha256}}};
  const record={schemaVersion:1,scope:day5ReviewScope,sourceCommit:head,reviewedAt:'2026-09-30T03:00:00.000Z',context,checks:day5CheckIds.slice(0,partial?2:7).map((id,i)=>({id,status:'PASS',reviewer:'synthetic-reviewer',assertions:Object.fromEntries(day5Assertions[id].map(key=>[key,true])),evidence:[bindings[i]]}))};
  const privatePath=join(f.root,'synthetic-private-record.json');writeFileSync(privatePath,JSON.stringify(record));
  const review=inspectDay5Review(privatePath,{root:f.root,commit:head,sourceCommittedAt,startedAt:r.startedAt,checkedAt:'2026-10-01T00:00:00.800Z',worktreeDirty:false,localPassed:true,expectedPublicConfiguration:configuration});
  Object.assign(r,{commit:head,worktreeDirty:false,sourceCommittedAt,scope:day5ReviewScope,status:review.status,applicationTests:1,publicConfiguration:configuration,day5Review:review,acceptance:review.checks.map(check=>({id:check.id,status:check.status,scope:day5ReviewScope}))});f.save('D5');return {...f,bindings,record};
}
test('D5 index independently checks operator context and original bytes while allowing real new-profile scope without inheriting other stages',()=>{
  for(const partial of [false,true]){const f=manualDay5Fixture(partial);try{
    const result=buildAcceptanceIndex(f.root,f.meta).report;
    assert.equal(result.issues.length,0,JSON.stringify(result.issues));assert.equal(result.items.find(item=>item.id==='D5-01')!.result,'PASS');
    assert.equal(result.items.find(item=>item.id==='D5-04')!.result,partial?'BLOCKED':'PASS');assert.equal(result.items.find(item=>item.id==='D7-04')!.result,'BLOCKED');assert.equal(result.status,'BLOCKED');
    assert.ok(result.files.some(file=>file.path==='artifacts/release-evidence/d5/D5-01.md'&&file.snapshotPath===null));
    const serialized=JSON.stringify(result);assert.ok(!serialized.includes('synthetic-reviewer'));assert.ok(!serialized.includes('synthetic-private-record'));assert.ok(!serialized.includes(f.root));
    f.reports.D5.day5Review.context.secondaryContext.kind='PHYSICAL_DEVICE';f.save('D5');assert.equal(buildAcceptanceIndex(f.root,f.meta).report.items.find(item=>item.id==='D5-02')!.result,'PASS');
  }finally{f.close();}}
});
test('D5 index rejects forged manual PASS source times configuration assertions namespace order and evidence without private reads',()=>{
  for(const mode of ['no-manifest','source','dirty','future-review','old-observation','late-observation','future-check','configuration','scope','assertion','evidence','duplicate','private-path','no-secondary','same-context','namespace','order','no-finalized','finalized-evidence','snapshot-order','snapshot-context','snapshot-block','snapshot-chain','snapshot-state','snapshot-md','status','unit-failed'] as const){
    const f=manualDay5Fixture();try{const r=f.reports.D5,v=r.day5Review;
      if(mode==='no-manifest')delete r.day5Review;else if(mode==='source')v.sourceCommit='b'.repeat(40);else if(mode==='dirty')r.worktreeDirty=true;else if(mode==='future-review')v.reviewedAt='2026-10-01T00:00:02.000Z';else if(mode==='old-observation')v.context.observationsStartedAt='2026-09-29T23:00:00.000Z';else if(mode==='late-observation')v.context.observationsEndedAt='2026-09-30T04:00:00.000Z';else if(mode==='future-check')v.timeWindow.checkedAt='2026-10-01T00:00:02.000Z';else if(mode==='configuration')r.publicConfiguration.publicUrl='https://different.example/';else if(mode==='scope')r.acceptance[0].scope='REAL_PROVIDER_PROOF';else if(mode==='assertion')v.checks[0].assertions.ONLY_CIPHERTEXT_AND_METADATA_PERSISTED=false;else if(mode==='evidence')f.write('artifacts/release-evidence/d5/D5-01.md','CHANGED_SYNTHETIC_BYTES');else if(mode==='duplicate')v.checks[0].evidence.push({...v.checks[0].evidence[0]});else if(mode==='private-path'){f.write('.env','PRIVATE_D5_SENTINEL_MUST_NOT_READ');v.checks[0].evidence[0].path='.env';}else if(mode==='no-secondary')v.context.secondaryContext=null;else if(mode==='same-context')v.context.secondaryContext.id=v.context.primaryContext;else if(mode==='namespace')v.context.namespaces[1].namespace[3]='0x'+'9'.repeat(64);else if(mode==='order')v.context.originalOrder.orderId='0x'+'9'.repeat(64);else if(mode==='no-finalized')v.context.originalOrder.finalizedObservation=null;else if(mode==='finalized-evidence')v.context.originalOrder.finalizedObservation.evidenceSha256='b'.repeat(64);else if(mode.startsWith('snapshot-')){
        const binding=v.checks[3].evidence[0],path=join(f.root,binding.path),snapshot=JSON.parse(readFileSync(path,'utf8'));
        if(mode==='snapshot-order')snapshot.orderId='0x'+'9'.repeat(64);else if(mode==='snapshot-context')snapshot.contextHash='0x'+'9'.repeat(64);else if(mode==='snapshot-block')snapshot.block.hash='0x'+'9'.repeat(64);else if(mode==='snapshot-chain')snapshot.chainId='1';else if(mode==='snapshot-state')snapshot.state='UNREGISTERED';
        const bytes=Buffer.from(JSON.stringify(snapshot));if(mode==='snapshot-md')binding.path='artifacts/release-evidence/d5/chain-observation.md';f.write(binding.path,bytes.toString());binding.bytes=bytes.length;binding.sha256=createHash('sha256').update(bytes).digest('hex');v.context.originalOrder.finalizedObservation.evidenceSha256=binding.sha256;
      }else if(mode==='status')v.status='BLOCKED';else r.runs.find((run:{command:string})=>run.command==='pnpm run test:unit').exitCode=1;
      f.save('D5');const {report,snapshots}=buildAcceptanceIndex(f.root,f.meta);assert.ok(report.issues.some(issue=>issue.stage==='D5'),mode);assert.equal(report.items.find(item=>item.id==='D5-01')!.result,'FAIL',mode);assert.equal(report.items.find(item=>item.id==='D6-01')!.result,'PASS');assert.ok(![...snapshots.values()].some(bytes=>bytes.includes(Buffer.from('PRIVATE_D5_SENTINEL_MUST_NOT_READ'))));
    }finally{f.close();}
  }
});

test('index rejects JSON-escaped public credentials before pinning any report bytes including unknown fields',()=>{
  const secret=['api','key_'].join('')+'A'.repeat(40),escaped=Array.from(secret,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  for(const mode of ['primary','secondary','unknown'] as const){const f=manualDay5Fixture();try{
    const r=f.reports.D5;if(mode==='primary')r.day5Review.context.primaryContext=secret;else if(mode==='secondary')r.day5Review.context.secondaryContext.id=secret;else r.unknownPrivateField=secret;
    f.write('artifacts/acceptance/day5.json',JSON.stringify(r).replace(secret,escaped));
    const {report,snapshots}=buildAcceptanceIndex(f.root,f.meta);assert.ok(report.issues.some(issue=>issue.stage==='D5'&&issue.code==='PUBLIC_REPORT_TEXT_UNSAFE'));assert.equal(report.items.find(item=>item.id==='D5-01')!.result,'FAIL');
    assert.ok(![...snapshots.values()].some(bytes=>bytes.includes(Buffer.from(escaped))||bytes.includes(Buffer.from(secret))));assert.ok(!report.files.some(file=>file.path==='artifacts/acceptance/day5.json'));assert.equal(JSON.stringify(report).includes(secret),false);assert.equal(report.items.find(item=>item.id==='D6-01')!.result,'PASS');
  }finally{f.close();}}
});

test('index rejects duplicate members hiding escaped credentials before public snapshots',()=>{
  const secret=['api','key_'].join('')+'A'.repeat(40),escaped=Array.from(secret,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  for(const field of ['primaryContext','id','unknownPrivateField']){const f=manualDay5Fixture();try{
    let raw=JSON.stringify(f.reports.D5);
    if(field==='unknownPrivateField')raw=raw.replace('{','{"unknownPrivateField":"'+escaped+'","unknownPrivateField":"SYNTHETIC_PUBLIC_VALUE",');
    else if(field==='primaryContext')raw=raw.replace('"primaryContext":','"primaryContext":"'+escaped+'","primaryContext":');
    else raw=raw.replace('"secondaryContext":{"id":','"secondaryContext":{"id":"'+escaped+'","id":');
    f.write('artifacts/acceptance/day5.json',raw);const {report,snapshots}=buildAcceptanceIndex(f.root,f.meta);
    assert.ok(report.issues.some(issue=>issue.stage==='D5'&&issue.code==='JSON_DUPLICATE_KEY'));assert.equal(report.items.find(item=>item.id==='D5-01')!.result,'FAIL');assert.ok(!report.files.some(file=>file.path==='artifacts/acceptance/day5.json'));assert.ok(![...snapshots.values()].some(bytes=>bytes.includes(Buffer.from(escaped))));
  }finally{f.close();}}
});

function manualReleaseV2Fixture(){
  const f=manualReleaseFixture(),r=f.reports.D7;
  // Temporary format doubles only: none of these records attest real sponsors,
  // people, devices, metadata probes, public URLs or product acceptance.
  const binding=(name:string)=>{
    const path=`artifacts/release-evidence/v2-${name}.md`,bytes=Buffer.from(`SYNTHETIC_INDEX_V2_${name}`);
    f.write(path,bytes.toString());return {path:join(f.root,path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  };
  const mera=binding('mera'),privy=binding('privy'),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
  const sourceBytes=Buffer.from('SYNTHETIC_V2_PUBLIC_SOURCE_SNAPSHOT_DOUBLE\n');f.write('apps/web/src/main.ts',sourceBytes.toString());
  const sourceSnapshot={sourceCommit:head,bindings:[{path:'apps/web/src/main.ts',bytes:sourceBytes.length,sha256:createHash('sha256').update(sourceBytes).digest('hex')}]};
  const record={schemaVersion:2,scope:f.record.scope,sourceCommit:head,assetsSha256:f.record.assetsSha256,reviewedAt:f.record.reviewedAt,
    checks:f.record.checks.filter(check=>check.id!=='D7-04'),
    sponsorChecks:(['MERA','PRIVY'] as const).map(id=>({id,status:'PASS' as 'PASS'|'FAIL'|'BLOCKED',reviewer:'SYNTHETIC_OPERATOR',
      assertions:Object.fromEntries(releaseSponsorAssertions[id].map(key=>[key,true])),evidence:[id==='MERA'?mera:privy]})),
    recoveryContext:{configuration:{publicUrl:'https://product.example/',rpId:'product.example'},observationsStartedAt:'2026-09-30T01:00:00.000Z',
      observationsEndedAt:'2026-09-30T02:00:00.000Z',primaryContext:'synthetic-primary',secondaryContext:{id:'synthetic-secondary',kind:'NEW_BROWSER_PROFILE' as 'NEW_BROWSER_PROFILE'|'PHYSICAL_DEVICE'},
      namespaces:[{namespace:['intentpass','v1','memory','synthetic-agent'],objectId:h(1),revision:'1'},
        {namespace:['intentpass','v1','authorization',h(2)],objectId:h(2),revision:'1'}],originalOrder:null}};
  const candidate={schemaVersion:1 as const,sourceCommit:head,productUrl:'https://product.example',repositoryUrl:'https://repository.example',
    technicalVideo:{localPath:f.originals.technicalVideo.path,publicUrl:'https://video.example/technical'},pitchVideo:{localPath:f.originals.pitchVideo.path,publicUrl:'https://video.example/pitch'},
    cleanverseVideo:{localPath:f.originals.cleanverseVideo.path,publicUrl:'https://video.example/cleanverse'},logoPath:f.originals.logo.path,
    submission:{publicUrl:'https://submission.example/receipt',receiptPath:f.originals.submissionReceipt.path}};
  const refresh=()=>{
    f.write('operator-review-v2.json',JSON.stringify(record));
    const review=inspectReleaseReview(join(f.root,'operator-review-v2.json'),{root:f.root,commit:head,sourceCommittedAt:r.sourceCommittedAt,
      startedAt:r.startedAt,checkedAt:'2026-10-01T00:00:00.800Z',worktreeDirty:false,candidateStatus:'VALID',assetsSha256:record.assetsSha256,
      candidate,localPassed:true,assets:r.assets,audit:JSON.parse(readFileSync(join(f.root,'artifacts/acceptance/public-audit.json'),'utf8'))});
    Object.assign(r,{status:review.status,releaseReview:review,profiles:releaseProfiles(review.checks,review),sourceStable:true});
    r.sourceObservation={scope:'START_END_LOCAL_SOURCE_BYTE_COMPARISON_NOT_INDEPENDENT_PROVENANCE',before:structuredClone(sourceSnapshot),after:structuredClone(sourceSnapshot)};
    r.candidate.productOrigin=new URL(candidate.productUrl).origin;
    for(const check of review.checks)Object.assign(r.acceptance.find((item:{id:string})=>item.id===check.id),{status:check.status,scope:review.scope});
    f.save('D7');return review;
  };
  refresh();return {...f,record,mera,privy,refresh};
}
test('v2 index reports independent Mera and Privy profile scope without upgrading new-profile recovery to the physical product story',()=>{
  const f=manualReleaseV2Fixture();try{
    const result=buildAcceptanceIndex(f.root,f.meta).report,stage=result.stages.find(row=>row.day==='D7')!;
    assert.equal(result.issues.length,0,JSON.stringify(result.issues));assert.equal(stage.reportStatus,'BLOCKED');
    assert.equal(stage.profiles.find(row=>row.name==='Mera')!.status,'PASS');assert.equal(stage.profiles.find(row=>row.name==='Privy')!.status,'PASS');
    assert.equal(stage.profiles.find(row=>row.name==='PACT-inspired product')!.status,'BLOCKED');assert.equal(result.items.find(row=>row.id==='D7-04')!.result,'BLOCKED');
    assert.equal(result.items.find(row=>row.id==='D7-02')!.result,'PASS');assert.equal(result.items.find(row=>row.id==='D4-01')!.result,'BLOCKED');
    assert.ok(result.files.some(row=>row.path==='artifacts/release-evidence/v2-mera.md'&&row.snapshotPath===null));
    assert.ok(result.limits.some(limit=>limit.includes('not independent provider or human-provenance')));
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_OPERATOR'),false);assert.equal(JSON.stringify(result).includes(f.root),false);
    f.record.recoveryContext.secondaryContext.kind='PHYSICAL_DEVICE';f.refresh();
    const physical=buildAcceptanceIndex(f.root,f.meta).report;assert.equal(physical.issues.length,0,JSON.stringify(physical.issues));
    assert.equal(physical.items.find(row=>row.id==='D7-04')!.result,'PASS');assert.equal(physical.stages.find(row=>row.day==='D7')!.profiles.find(row=>row.name==='PACT-inspired product')!.status,'PASS');
    assert.equal(physical.status,'BLOCKED');
  }finally{f.close();}
});
test('v2 index retains one sponsor result while the other is BLOCKED or explicitly FAIL and never inherits source-stage eligibility',()=>{
  for(const sponsor of ['MERA','PRIVY'] as const)for(const status of ['BLOCKED','FAIL'] as const){
    const f=manualReleaseV2Fixture();try{
      f.record.sponsorChecks.find(row=>row.id===sponsor)!.status=status;f.refresh();
      const result=buildAcceptanceIndex(f.root,f.meta).report,stage=result.stages.find(row=>row.day==='D7')!,name=sponsor==='MERA'?'Mera':'Privy',other=sponsor==='MERA'?'Privy':'Mera';
      assert.equal(stage.profiles.find(row=>row.name===name)!.status,status);assert.equal(stage.profiles.find(row=>row.name===other)!.status,'PASS');
      assert.equal(result.items.find(row=>row.id==='D7-04')!.reportedResult,status);assert.equal(result.items.find(row=>row.id==='D5-02')!.result,'BLOCKED');
      if(status==='BLOCKED')assert.equal(result.issues.length,0,JSON.stringify(result.issues));
      else{assert.equal(stage.reportStatus,'FAIL');assert.ok(stage.issues.some(issue=>issue.code==='STAGE_REPORTED_FAILURE'));
        assert.equal(stage.issues.some(issue=>issue.code==='MANUAL_RELEASE_EVIDENCE_INVALID'),false,JSON.stringify(stage.issues));}
    }finally{f.close();}
  }
});
test('v2 index independently rechecks exact sponsor bytes and rejects forged profiles, derived physical claims and recovery context',()=>{
  for(const mode of ['bytes','profile','physical','combined','assertion','rp','different-origin','candidate-origin-missing','candidate-origin-mismatch','same-context','early-time','late-time','duplicate','private-path'] as const){
    const f=manualReleaseV2Fixture();try{const r=f.reports.D7,v=r.releaseReview;
      if(mode==='bytes')f.write('artifacts/release-evidence/v2-mera.md','DRIFTED_SYNTHETIC_INDEX_V2_BYTES');
      else if(mode==='profile')r.profiles.find((row:{name:string})=>row.name==='PACT-inspired product').status='PASS';
      else if(mode==='physical')v.physicalSecondDeviceStoryStatus='PASS';
      else if(mode==='combined'){v.checks[3].status='PASS';v.checks[3].assertions.SAME_PASSKEY_SECOND_PHYSICAL_DEVICE_REVIEWED=true;r.acceptance.find((row:{id:string})=>row.id==='D7-04').status='PASS';}
      else if(mode==='assertion')v.sponsorChecks[0].assertions.SAME_PASSKEY_INDEPENDENT_CONTEXT_REVIEWED=false;
      else if(mode==='rp')v.recoveryContext.configuration.rpId='different.example';
      else if(mode==='different-origin')v.recoveryContext.configuration={publicUrl:'https://other.example/',rpId:'other.example'};
      else if(mode==='candidate-origin-missing')delete r.candidate.productOrigin;
      else if(mode==='candidate-origin-mismatch')r.candidate.productOrigin='https://other.example';
      else if(mode==='same-context')v.recoveryContext.secondaryContext.id=v.recoveryContext.primaryContext;
      else if(mode==='early-time')v.recoveryContext.observationsStartedAt='2026-09-29T23:59:59.999Z';
      else if(mode==='late-time')v.recoveryContext.observationsEndedAt='2026-10-01T00:00:00.001Z';
      else if(mode==='duplicate')v.sponsorChecks[0].evidence.push({...v.sponsorChecks[0].evidence[0]});
      else v.sponsorChecks[0].evidence[0].path='artifacts/release-evidence/../private-dont-read.json';
      f.save('D7');const result=buildAcceptanceIndex(f.root,f.meta).report;
      assert.ok(result.issues.some(issue=>issue.stage==='D7'),mode);assert.equal(result.items.find(row=>row.id==='D7-02')!.result,'FAIL',mode);
      assert.equal(result.items.find(row=>row.id==='D6-01')!.result,'PASS');
    }finally{f.close();}
  }
});

test('v2 index rejects decoded synthetic context credentials before saving any public report snapshot',()=>{
  const secret=['api','key_'].join('')+'B'.repeat(40),escaped=Array.from(secret,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  for(const field of ['alias','namespace'] as const)for(const encoded of [false,true]){
    const f=manualReleaseV2Fixture();try{
      const r=f.reports.D7;
      if(field==='alias')r.releaseReview.recoveryContext.primaryContext=secret;
      else r.releaseReview.recoveryContext.namespaces[0].namespace[3]=secret;
      const raw=JSON.stringify(r);f.write('artifacts/acceptance/day7.json',encoded?raw.replace(secret,escaped):raw);
      const {report,snapshots}=buildAcceptanceIndex(f.root,f.meta);
      assert.ok(report.issues.some(issue=>issue.stage==='D7'&&issue.code==='PUBLIC_REPORT_TEXT_UNSAFE'));
      assert.equal(report.items.find(row=>row.id==='D7-02')!.result,'FAIL');assert.equal(report.items.find(row=>row.id==='D6-01')!.result,'PASS');
      assert.equal(report.files.some(file=>file.path==='artifacts/acceptance/day7.json'),false);
      assert.equal([...snapshots.values()].some(bytes=>bytes.includes(Buffer.from(secret))||bytes.includes(Buffer.from(escaped))),false);
      assert.equal(JSON.stringify(report).includes(secret),false);
    }finally{f.close();}
  }
});

test('v2 index accepts shared exact sponsor bytes and rejects an earlier conflicting commitment hidden by combined-map dedup',()=>{
  const f=manualReleaseV2Fixture();try{
    f.record.sponsorChecks[1].evidence=[{...f.mera}];f.refresh();
    const valid=buildAcceptanceIndex(f.root,f.meta).report;assert.equal(valid.issues.length,0,JSON.stringify(valid.issues));
    assert.equal(valid.stages.find(row=>row.day==='D7')!.profiles.find(row=>row.name==='Mera')!.status,'PASS');
    const r=f.reports.D7,v=r.releaseReview;assert.equal(v.checks[3].evidence.length,1);
    v.sponsorChecks[0].evidence[0].sha256='f'.repeat(64);f.save('D7');
    const invalid=buildAcceptanceIndex(f.root,f.meta).report;assert.ok(invalid.issues.some(issue=>issue.stage==='D7'));
    assert.equal(invalid.items.find(row=>row.id==='D7-02')!.result,'FAIL');assert.equal(invalid.items.find(row=>row.id==='D6-01')!.result,'PASS');
  }finally{f.close();}
});

test('v2 manual release claims require an explicit stable source observation while legacy v1 remains compatible',()=>{
  for(const mode of ['flag-missing','flag-false','snapshot-missing','snapshot-drift','snapshot-commit'] as const){
    const f=manualReleaseV2Fixture();try{
      if(mode==='flag-missing')delete f.reports.D7.sourceStable;
      else if(mode==='flag-false')f.reports.D7.sourceStable=false;
      else if(mode==='snapshot-missing')delete f.reports.D7.sourceObservation;
      else if(mode==='snapshot-drift')f.reports.D7.sourceObservation.after.bindings[0].sha256='b'.repeat(64);
      else {f.reports.D7.sourceObservation.before.sourceCommit='b'.repeat(40);f.reports.D7.sourceObservation.after.sourceCommit='b'.repeat(40);}
      f.save('D7');const result=buildAcceptanceIndex(f.root,f.meta).report;
      assert.ok(result.issues.some(issue=>issue.stage==='D7'&&issue.code==='MANUAL_RELEASE_EVIDENCE_INVALID'));
      assert.equal(result.items.find(row=>row.id==='D7-02')!.result,'FAIL');assert.equal(result.items.find(row=>row.id==='D6-01')!.result,'PASS');
    }finally{f.close();}
  }
  const legacy=manualReleaseFixture();try{
    assert.equal(legacy.reports.D7.sourceStable,undefined);
    const result=buildAcceptanceIndex(legacy.root,legacy.meta).report;assert.equal(result.issues.length,0,JSON.stringify(result.issues));
    assert.equal(result.items.find(row=>row.id==='D7-02')!.result,'PASS');
  }finally{legacy.close();}
});
