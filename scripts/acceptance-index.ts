import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,lstatSync,realpathSync,openSync,readSync,closeSync,fstatSync,constants} from 'node:fs';
import {resolve,relative,sep,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {z} from 'zod';
import {settlementRoute} from '../packages/protocol/src/route.js';
import {completeUnitRun,commandExit} from './verification-outcome.js';
import {auditBytes} from './public-audit.js';
import {inspectEvaluationReport} from './review-report-evidence.js';
import {calibrateDevelopment} from './review-calibration.js';
import {isDeepStrictEqual} from 'node:util';
import {ReleaseReviewManifestSchema,releaseAssertionsFor,releaseProfiles,inspectReleaseEvidence} from './release-review.js';
import {Day5ReviewManifestSchema,Day5PublicConfigurationSchema,day5Assertions,day5ReviewScope} from './day5-review-types.js';
import {inspectDay5OrderEvidence} from './day5-order-evidence.js';
import {strictJsonParse} from './strict-json.js';
import {sameReleaseSource} from './release-source.js';

const base='artifacts/acceptance',specPath='docs/implementation-spec.md';
const counts=[7,7,8,6,7,7,7] as const;
const status=z.enum(['PASS','FAIL','BLOCKED','NOT_STARTED']);
const time=z.iso.datetime();
const itemSchema=z.object({id:z.string().regex(/^D[1-7]-\d{2}$/),status,applicable:z.boolean().optional(),reason:z.string().max(2048).optional(),scope:z.string().max(256).optional(),evidence:z.union([z.string().max(256),z.array(z.string().max(256)).max(12)]).optional()});
const runSchema=z.object({command:z.string().max(80),exitCode:z.number().int().min(0).max(255).nullable(),evidence:z.string().max(256),signal:z.string().nullable().optional(),startedAt:time.optional(),endedAt:time.optional()});
const reviewMetadata=z.object({version:z.literal(1),model:z.string().regex(/^jev-\d+\.\d+\.\d+$/),policySha256:z.string().regex(/^[a-f0-9]{64}$/),developmentSha256:z.string().regex(/^[a-f0-9]{64}$/),sourceDevelopmentSha256:z.string().regex(/^[a-f0-9]{64}$/),holdoutSha256:z.string().regex(/^[a-f0-9]{64}$/),criticalSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const releaseCandidate=z.object({status:z.enum(['VALID','FAIL','BLOCKED']),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),sourceMatchesCleanCommit:z.boolean(),productUrlDeclared:z.boolean(),productOrigin:z.string().max(2048).nullable().optional(),repositoryUrlDeclared:z.boolean(),publicUrlsVerified:z.boolean(),technicalVideoDeclared:z.boolean().optional(),pitchVideoDeclared:z.boolean().optional(),cleanverseVideoDeclared:z.boolean().optional(),submissionDeclared:z.boolean().optional()});
const releaseAsset=z.object({name:z.enum(['technicalVideo','pitchVideo','cleanverseVideo','logo','submissionReceipt']),status:z.string().max(100),bytes:z.number().int().positive().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),durationSeconds:z.number().positive().optional(),maximumSeconds:z.number().positive().optional()});
const reportSchema=z.object({stage:z.string(),status,route:z.string().optional(),settlementRoute:z.string().optional(),scope:z.string().max(256).optional(),commit:z.string().regex(/^[a-f0-9]{40}$/).nullable().optional(),worktreeDirty:z.boolean().optional(),sourceStable:z.boolean().optional(),sourceObservation:z.object({scope:z.literal('START_END_LOCAL_SOURCE_BYTE_COMPARISON_NOT_INDEPENDENT_PROVENANCE'),before:z.unknown().nullable(),after:z.unknown().nullable()}).strict().optional(),startedAt:time,endedAt:time,runs:z.array(runSchema).max(12),items:z.array(itemSchema).optional(),acceptance:z.array(itemSchema).optional(),applicationTests:z.number().int().positive().optional(),reviewEvidence:reviewMetadata.nullable().optional(),profiles:z.array(z.object({name:z.string().max(80),applicable:z.boolean(),status,reason:z.string().max(2048)})).max(8).optional(),sourceCommittedAt:time.nullable().optional(),releaseReview:ReleaseReviewManifestSchema.optional(),day5Review:Day5ReviewManifestSchema.optional(),publicConfiguration:Day5PublicConfigurationSchema.nullable().optional(),candidate:releaseCandidate.optional(),assets:z.array(releaseAsset).max(5).optional()});
const commands=[['typecheck','build','test:unit','test:contract','demo:local','doctor'],['typecheck','build','test:unit','test:contract:monad'],['typecheck','build','test:unit','test:contract','abi:check','demo:local','test:contract:monad','demo:monad-local'],['typecheck','build','test:unit','test:contract:monad','abi:check','demo:monad-local'],['typecheck','build','test:unit'],['typecheck','build','test:unit','test:contract:monad','audit:public'],['typecheck','build','test:unit','audit:public']];
const fallbackScope=['LOCAL_SCHEMA_VECTOR_AND_OWNER_ROUTE_REPORT','LOCAL_PROVIDER_TEST_DOUBLES_ONLY','LOCAL_EVM_TEST_DOUBLES_ONLY','LOCAL_NATIVE_PREREQUISITES_ONLY_NOT_D4_EXTERNAL_ACCEPTANCE','LOCAL_WEBCRYPTO_MERA_SDK_PLATFORM_TEST_DOUBLES_ONLY','LOCAL_DETERMINISTIC_APPLICATION_AND_MONAD_NATIVE_TESTS','HONEST_PROFILE_REPORTING_ONLY_NOT_RELEASE_ELIGIBILITY'];
const localPass=new Set(['D1-02','D1-07','D2-05','D2-06','D2-07','D3-01','D3-02','D3-03','D3-04','D3-05','D3-06','D3-08','D6-01','D7-07']);
const profileNames=['Full PACT / IMAS / CDAS','PACT-inspired product','Cleanverse CVA/CVI','Privy','Mera','JEV'];
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type Requirement={id:string;day:string;scope:string;action:string;expectedResult:string;requiredEvidence:string;applicable:boolean};
type FileRef={path:string;bytes:number;sha256:string;snapshotPath:string|null};
type Issue={stage:string;code:string;path:string};
type Meta={generatedAt:string;head:string|null;worktreeDirty:boolean|null;snapshotId:string};
const metadata=z.object({generatedAt:time,head:z.string().regex(/^[a-f0-9]{40}$/).nullable(),worktreeDirty:z.boolean().nullable(),snapshotId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)}).strict();

/** Only fixed public evidence paths; never read .env, databases, arbitrary paths or URLs. */
function readPublic(root:string,path:string,limit:number){
  if(!/^(?:docs\/implementation-spec\.md|docs\/decisions\.md|README\.md|apps\/web\/src\/main\.ts|fixtures\/(?:review-manifest\.json|dev\/review-cases\.json)|artifacts\/acceptance\/(?:day[1-7]\.json|day[1-7]-[a-z-]+\.log|(?:local-escrow-demo|local-monad-demo|local-deployment-proof|monad-contract|public-audit|review-holdout|review-critical|review-dev|review-dev-calibrated|review-policy)\.json))$/.test(path))throw new Error('EVIDENCE_PATH_INVALID');
  const absolute=resolve(root,path);for(let current=absolute;current!==resolve(root);current=dirname(current))if(lstatSync(current).isSymbolicLink())throw new Error('EVIDENCE_SYMLINK_REJECTED');
  if(!realpathSync(absolute).startsWith(realpathSync(root)+sep))throw new Error('EVIDENCE_PATH_INVALID');const s=lstatSync(absolute);if(!s.isFile()||s.size<=0||s.size>limit)throw new Error('EVIDENCE_SIZE_INVALID');return readFileSync(absolute);
}
/** Stream only explicitly public, redacted release evidence; never snapshot large media
 * or private operator records. These supplemental hashes do not attest provenance. */
function releaseFileRef(root:string,path:string):FileRef{
  if(!/^(?:artifacts\/release-evidence\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:json|log|md|txt|png|jpg|jpeg|webp|mp4|mov)|assets\/brand\/intentpass-logo\.png|artifacts\/acceptance\/day1-preview\.png)$/.test(path))throw Error('RELEASE_EVIDENCE_PATH_INVALID');
  const absolute=resolve(root,path);for(let current=absolute;current!==resolve(root);current=dirname(current))if(lstatSync(current).isSymbolicLink())throw Error('RELEASE_EVIDENCE_SYMLINK_REJECTED');
  if(!realpathSync(absolute).startsWith(realpathSync(root)+sep))throw Error('RELEASE_EVIDENCE_PATH_INVALID');const stat=lstatSync(absolute);if(!stat.isFile()||stat.size<=0||stat.size>536870912)throw Error('RELEASE_EVIDENCE_SIZE_INVALID');
  const hash=createHash('sha256'),buffer=Buffer.alloc(65536),fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);let tail=Buffer.alloc(0),size=0;
  const opened=fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev){closeSync(fd);throw Error('RELEASE_EVIDENCE_CHANGED_DURING_READ');}
  try{for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;const chunk=buffer.subarray(0,n);hash.update(chunk);size+=n;const combined=Buffer.concat([tail,chunk]);if(auditBytes(path,combined).length)throw Error('PUBLIC_RELEASE_EVIDENCE_TEXT_UNSAFE');tail=Buffer.from(combined.subarray(Math.max(0,combined.length-2048)));}}finally{closeSync(fd);}
  const after=lstatSync(absolute);if(size!==stat.size||after.isSymbolicLink()||after.ino!==stat.ino||after.dev!==stat.dev||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||realpathSync(absolute)!==absolute)throw Error('RELEASE_EVIDENCE_CHANGED_DURING_READ');return {path,bytes:size,sha256:hash.digest('hex'),snapshotPath:null};
}
export function acceptanceRequirements(text:string):Requirement[]{
  const rows=text.split('\n').filter(line=>/^\| D[1-7]-\d{2} \|/.test(line)).map(line=>{const cells=line.split('|').slice(1,-1).map(cell=>cell.trim());if(![3,4].includes(cells.length)||cells.some(cell=>!cell))throw new Error('SPEC_TABLE_INVALID');const [id,action,expectedResult,requiredEvidence]=cells,day=id.slice(0,2);return {id,day,scope:id==='D3-07'?'full-pact-reuse':id==='D3-08'?settlementRoute:'all',action,expectedResult,requiredEvidence:requiredEvidence??'实际命令/响应/链上状态/实机记录，按主规格',applicable:id!=='D3-07'};});
  const ids=counts.flatMap((count,i)=>Array.from({length:count},(_,j)=>`D${i+1}-${String(j+1).padStart(2,'0')}`));if(rows.length!==49||rows.some((row,i)=>row.id!==ids[i]))throw new Error('SPEC_IDS_INVALID');return rows;
}
export function buildAcceptanceIndex(root:string,meta:Meta){
  metadata.parse(meta);const spec=readPublic(root,specPath,100000),requirements=acceptanceRequirements(spec.toString('utf8')),files=new Map<string,FileRef>(),issues:Issue[]=[],snapshots=new Map<string,Buffer>();
  const prefix=`${base}/index-snapshots/${meta.snapshotId}`;
  const pin=(path:string,bytes:Buffer,snapshotName?:string)=>{const ref={path,bytes:bytes.length,sha256:sha(bytes),snapshotPath:snapshotName?`${prefix}/${snapshotName}`:null};files.set(path,ref);if(ref.snapshotPath)snapshots.set(ref.snapshotPath,bytes);return ref;};
  const source=pin(specPath,spec,'implementation-spec.md');
  const stages=Array.from({length:7},(_,index)=>{
    const day=`D${index+1}`,path=`${base}/day${index+1}.json`,required=requirements.filter(row=>row.day===day),stageIssues:Issue[]=[],add=(code:string,at=path)=>{const issue={stage:day,code,path:at};stageIssues.push(issue);issues.push(issue);};
    let report:z.infer<typeof reportSchema>|undefined,raw:Buffer|undefined,reference:FileRef|undefined;
    try{
      raw=readPublic(root,path,1000000);if(auditBytes(path,raw).length)throw new Error('PUBLIC_REPORT_TEXT_UNSAFE');
      const original=strictJsonParse(raw.toString('utf8'));
      // Decode escapes before publishing a snapshot, including unknown fields
      // that the report schema may strip. Raw text alone misses escaped keys.
      if(auditBytes(path,Buffer.from(JSON.stringify(original))).length)throw new Error('PUBLIC_REPORT_TEXT_UNSAFE');
      reference=pin(path,raw,`inputs/day${index+1}.json`);report=reportSchema.parse(original);
      if(report.stage!==day||(report.route??report.settlementRoute)!==settlementRoute||report.route&&report.settlementRoute&&report.route!==report.settlementRoute)throw new Error('REPORT_STAGE_ROUTE_INVALID');
      if(report.startedAt>report.endedAt||report.endedAt>meta.generatedAt)throw new Error('REPORT_TIME_INVALID');
      if(!!report.items===!!report.acceptance)throw new Error('REPORT_ITEM_ARRAY_INVALID');const items=report.items??report.acceptance!;
      if(items.length!==required.length||new Set(items.map(item=>item.id)).size!==items.length||required.some(row=>!items.some(item=>item.id===row.id)))throw new Error('REPORT_IDS_INVALID');
      if(items.some(item=>item.applicable!==undefined&&item.applicable!==(item.id!=='D3-07'))||items.some(item=>item.id==='D3-07'&&(item.applicable!==false||item.status!=='NOT_STARTED')))throw new Error('REPORT_APPLICABILITY_INVALID');
      const expected=commands[index].map(command=>'pnpm run '+command);if(report.runs.length!==expected.length||new Set(report.runs.map(run=>run.command)).size!==expected.length||report.runs.some(run=>!expected.includes(run.command)))throw new Error('REPORT_COMMANDS_INVALID');
      for(const run of report.runs){const name=run.command.slice('pnpm run '.length),expectedPath=`${base}/day${index+1}-${name.replaceAll(':','-')}.log`;if(run.evidence!==expectedPath)throw new Error('RUN_EVIDENCE_PATH_INVALID');
        if(run.startedAt&&run.startedAt<report.startedAt||run.endedAt&&run.endedAt>report.endedAt||run.startedAt&&run.endedAt&&run.startedAt>run.endedAt)throw new Error('RUN_TIME_INVALID');
        const bytes=readPublic(root,run.evidence,32000000);if(auditBytes(run.evidence,bytes).length)throw new Error('PUBLIC_EVIDENCE_TEXT_UNSAFE');pin(run.evidence,bytes,`logs/${relative(base,run.evidence)}`);
        if(run.signal||run.exitCode===null)add('RUN_INCOMPLETE',run.evidence);
      }
      let manualDay5Valid=false;
      if(day==='D5'&&items.some(item=>item.status==='PASS'))try{
        // Recheck the public manifest and original byte bindings without reading
        // any private operator record or trusting the report's PASS flag.
        const review=report.day5Review,context=review?.context;
        if(!review||!context||!review.sha256||!report.commit||report.worktreeDirty!==false||!report.sourceCommittedAt||!report.publicConfiguration||report.scope!==day5ReviewScope||review.sourceCommit!==report.commit||!isDeepStrictEqual(context.configuration,report.publicConfiguration)||review.timeWindow.sourceCommittedAt!==report.sourceCommittedAt||review.timeWindow.startedAt!==report.startedAt||Date.parse(review.timeWindow.checkedAt)<Date.parse(report.startedAt)||Date.parse(review.timeWindow.checkedAt)>Date.parse(report.endedAt)||!review.reviewedAt||Date.parse(context.observationsStartedAt)<Date.parse(report.sourceCommittedAt)||Date.parse(context.observationsEndedAt)>Date.parse(review.reviewedAt)||Date.parse(review.reviewedAt)>Date.parse(report.startedAt)||review.issues.some(issue=>!issue.id||review.checks.some(check=>check.id===issue.id&&check.status==='PASS')))throw Error();
        for(const check of review.checks){
          const item=items.find(item=>item.id===check.id);
          if(!item||item.status!==check.status||item.scope!==day5ReviewScope)throw Error();
          if(check.status==='PASS'&&(!check.evidence.length||day5Assertions[check.id].some(key=>check.assertions[key]!==true)))throw Error();
          const paths=new Set<string>();
          for(const binding of check.evidence){if(paths.has(binding.path))throw Error();paths.add(binding.path);const file={...inspectReleaseEvidence(root,binding),snapshotPath:null};files.set(file.path,file);}
          if(check.status==='PASS'&&check.id==='D5-02'&&!context.secondaryContext)throw Error();
          if(check.status==='PASS'&&['D5-04','D5-05'].includes(check.id)&&!context.originalOrder)throw Error();
          if(check.status==='PASS'&&check.id==='D5-04')inspectDay5OrderEvidence(root,context.originalOrder,check.evidence);
        }
        const aggregate=review.checks.some(check=>check.status==='FAIL')?'FAIL':review.checks.every(check=>check.status==='PASS')?'PASS':'BLOCKED';
        if(review.status!==aggregate||report.status!==aggregate||!report.applicationTests)throw Error();
        manualDay5Valid=true;
      }catch{add('MANUAL_D5_EVIDENCE_INVALID');}
      let manualReleaseValid=false;
      const claimsManualRelease=day==='D7'&&(items.some(item=>item.status==='PASS'&&item.id!=='D7-07')||report.profiles?.some(profile=>profile.applicable&&profile.status==='PASS'));
      if(claimsManualRelease)try{
        const review=report.releaseReview,candidate=report.candidate;
        if(!review||review.issues.some(issue=>!issue.id||review.checks.some(check=>check.id===issue.id&&check.status==='PASS'))||!review.sha256||!report.commit||report.worktreeDirty!==false||!report.sourceCommittedAt||review.sourceCommit!==report.commit||review.timeWindow.sourceCommittedAt!==report.sourceCommittedAt||review.timeWindow.startedAt!==report.startedAt||Date.parse(review.timeWindow.checkedAt)<Date.parse(report.startedAt)||Date.parse(review.timeWindow.checkedAt)>Date.parse(report.endedAt)||!review.reviewedAt||Date.parse(review.reviewedAt)<Date.parse(report.sourceCommittedAt)||Date.parse(review.reviewedAt)>Date.parse(report.startedAt)||!candidate||candidate.status!=='VALID'||!candidate.sourceMatchesCleanCommit||!candidate.sha256||candidate.sha256!==review.assetsSha256)throw Error();
        if(review.schemaVersion===2&&(candidate.productOrigin!==review.productOrigin||report.sourceStable!==true||!report.sourceObservation||!sameReleaseSource(report.sourceObservation.before,report.sourceObservation.after)||!report.sourceObservation.before||typeof report.sourceObservation.before!=='object'||!('sourceCommit' in report.sourceObservation.before)||report.sourceObservation.before.sourceCommit!==report.commit))throw Error();
        if(review.schemaVersion===2)for(const check of review.sponsorChecks)for(const binding of check.evidence){const file={...inspectReleaseEvidence(root,binding),snapshotPath:null};files.set(file.path,file);}
        for(const check of review.checks){
          const item=items.find(item=>item.id===check.id);if(!item||item.status!==check.status||check.status==='PASS'&&item.scope!=='OPERATOR_RECORDED_MANUAL_RELEASE_CHECKS')throw Error();
          if(check.status==='PASS'&&(check.evidence.length===0||releaseAssertionsFor(review.schemaVersion,check.id).some(key=>!check.assertions[key as keyof typeof check.assertions])))throw Error();
          for(const binding of check.evidence){const file={...inspectReleaseEvidence(root,binding),snapshotPath:null};files.set(file.path,file);}
        }
        if(review.status!==(review.checks.some(check=>check.status==='FAIL')?'FAIL':review.checks.every(check=>check.status==='PASS')?'PASS':'BLOCKED'))throw Error();
        const passed=(id:string)=>review.checks.some(check=>check.id===id&&check.status==='PASS'),assets=report.assets??[];
        if(new Set(assets.map(asset=>asset.name)).size!==assets.length)throw Error();
        const hasAssetEvidence=(id:string,name:string)=>{const asset=assets.find(asset=>asset.name===name);return !!asset&&review.checks.find(check=>check.id===id)?.evidence.some(file=>file.bytes===asset.bytes&&file.sha256===asset.sha256);};
        const validVideo=(name:string,maximum:number)=>{const asset=assets.find(asset=>asset.name===name);return !!asset&&asset.status==='LOCAL_METADATA_PASS'&&!!asset.bytes&&!!asset.sha256&&!!asset.durationSeconds&&asset.durationSeconds<=maximum&&asset.maximumSeconds===maximum;};
        if(passed('D7-01')&&!candidate.productUrlDeclared||passed('D7-02')&&(!candidate.technicalVideoDeclared||!validVideo('technicalVideo',180))||passed('D7-03')&&(!candidate.pitchVideoDeclared||!candidate.cleanverseVideoDeclared||!validVideo('pitchVideo',120)||!validVideo('cleanverseVideo',300))||passed('D7-05')&&(!candidate.repositoryUrlDeclared||!candidate.productUrlDeclared||!assets.some(asset=>asset.name==='logo'&&asset.status==='LOCAL_METADATA_PASS'&&!!asset.bytes&&asset.bytes<=3000000&&!!asset.sha256))||passed('D7-06')&&(!candidate.submissionDeclared||!candidate.technicalVideoDeclared||!candidate.pitchVideoDeclared||!candidate.cleanverseVideoDeclared||!assets.some(asset=>asset.name==='submissionReceipt'&&asset.status==='LOCAL_FILE_PRESENT_MANUAL_PLATFORM_VERIFICATION_REQUIRED'&&!!asset.bytes&&!!asset.sha256)))throw Error();
        for(const [id,name] of [['D7-02','technicalVideo'],['D7-03','pitchVideo'],['D7-03','cleanverseVideo'],['D7-05','logo'],['D7-06','submissionReceipt']])if(passed(id)&&!hasAssetEvidence(id,name))throw Error();
        if(passed('D7-05')){
          if(review.privacyReview.status!=='PASS')throw Error();
          const auditPath=`${base}/public-audit.json`,auditBytesRaw=readPublic(root,auditPath,8000000);if(auditBytes(auditPath,auditBytesRaw).length)throw Error();
          const audit=z.object({scope:z.literal('PUBLIC_SOURCE_BUILD_LOG_RAW_BYTES_HEURISTIC_ONLY'),status:z.enum(['PASS','BLOCKED']),startedAt:time,endedAt:time,findings:z.array(z.unknown()).length(0),unverified:z.array(z.string()).max(200),manifest:z.array(z.object({path:z.string(),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),binary:z.boolean()})).min(1)}).parse(JSON.parse(auditBytesRaw.toString('utf8')));
          const auditRun=report.runs.find(run=>run.command==='pnpm run audit:public');
          if(audit.status!==(audit.unverified.length?'BLOCKED':'PASS')||auditRun?.exitCode!==(audit.status==='PASS'?0:1)||Date.parse(audit.startedAt)<Date.parse(report.startedAt)||Date.parse(audit.endedAt)>Date.parse(review.timeWindow.checkedAt)||Date.parse(audit.startedAt)>Date.parse(audit.endedAt)||new Set(audit.unverified).size!==audit.unverified.length||new Set(audit.manifest.map(file=>file.path)).size!==audit.manifest.length||review.privacyReview.reviewedUnverified.length!==audit.unverified.length)throw Error();
          for(const path of audit.unverified){const binding=review.privacyReview.reviewedUnverified.find(item=>item.path===path),audited=audit.manifest.find(item=>item.path===path);if(!binding||!audited?.binary||!review.checks.find(check=>check.id==='D7-05')?.evidence.some(file=>file.bytes===audited.bytes&&file.sha256===audited.sha256))throw Error();const file=path.startsWith('artifacts/release-evidence/')?{...inspectReleaseEvidence(root,binding),snapshotPath:null}:releaseFileRef(root,path);if(file.bytes!==binding.bytes||file.sha256!==binding.sha256||file.bytes!==audited.bytes||file.sha256!==audited.sha256)throw Error();files.set(file.path,file);}
          pin(auditPath,auditBytesRaw);
        }
        const expectedProfiles=releaseProfiles(review.checks,review);if(!isDeepStrictEqual(report.profiles,expectedProfiles))throw Error();
        manualReleaseValid=true;
      }catch{add('MANUAL_RELEASE_EVIDENCE_INVALID');}
      for(const item of items){if(item.status==='PASS'&&!localPass.has(item.id)){
        if(day==='D5'&&manualDay5Valid){/* Operator scope, source/context and public bytes checked above; not human provenance. */}
        else if(day==='D7'&&manualReleaseValid){/* Recorded manual assertions and current public evidence bytes checked above; not provenance. */}
        else if(day!=='D6'||!['D6-02','D6-03'].includes(item.id)||!report.reviewEvidence)add('EXTERNAL_PASS_REQUIRES_NEW_VERIFIER_FORMAT');
        else try {
          const meta=report.reviewEvidence,paths={policySha256:`${base}/review-policy.json`,developmentSha256:`${base}/review-dev-calibrated.json`,sourceDevelopmentSha256:`${base}/review-dev.json`,holdoutSha256:`${base}/review-holdout.json`,criticalSha256:`${base}/review-critical.json`};
          const texts=new Map<string,string>();for(const [field,target] of Object.entries(paths)){const bytes=readPublic(root,target,4000000);if(sha(bytes)!==meta[field as keyof typeof paths]||auditBytes(target,bytes).length)throw Error();pin(target,bytes);texts.set(target,bytes.toString('utf8'));}
          const policy=JSON.parse(texts.get(paths.policySha256)!),dev=JSON.parse(texts.get(paths.developmentSha256)!),original=JSON.parse(texts.get(paths.sourceDevelopmentSha256)!);
          if(policy.model!==meta.model||policy.developmentReportPath!==paths.developmentSha256||policy.developmentReportSha256!==meta.developmentSha256
            ||dev.calibration?.sourceReportPath!==paths.sourceDevelopmentSha256||dev.calibration?.sourceReportSha256!==meta.sourceDevelopmentSha256)throw Error();
          const cases=readPublic(root,'fixtures/dev/review-cases.json',4000000),manifest=JSON.parse(readPublic(root,'fixtures/review-manifest.json',100000).toString('utf8'));
          const entry=manifest.files.find((row:{path:string})=>row.path==='fixtures/dev/review-cases.json'),calibrated=calibrateDevelopment(original,cases.toString('utf8'),entry.sha256);
          if(calibrated.model!==meta.model||calibrated.minConfidence!==dev.minConfidence||calibrated.questionConfigHash!==dev.questionConfigHash||!isDeepStrictEqual(calibrated.results,dev.results)||!isDeepStrictEqual(calibrated.summary,dev.summary))throw Error();
          const mode=item.id==='D6-02'?'holdout':'critical',target=mode==='holdout'?paths.holdoutSha256:paths.criticalSha256;
          const checked=inspectEvaluationReport(mode,target,{model:meta.model,policyPath:paths.policySha256,root,now:new Date(report.endedAt)});
          if(checked.status!=='PASS'||item.scope!==checked.scope||item.reason!==checked.reason||item.evidence!==target)throw Error();
        }catch{add('REAL_REVIEW_EVIDENCE_INVALID');}
      }if(item.status==='NOT_STARTED'&&item.id!=='D3-07')add('APPLICABLE_ITEM_NOT_STARTED');
        for(const evidence of item.evidence?(Array.isArray(item.evidence)?item.evidence:[item.evidence]):[]){const target=evidence.split('#')[0];if(!files.has(target))try{const bytes=readPublic(root,target,4000000);if(auditBytes(target,bytes).length)throw new Error('PUBLIC_EVIDENCE_TEXT_UNSAFE');pin(target,bytes);}catch(error){add((error as NodeJS.ErrnoException).code==='ENOENT'?'EVIDENCE_MISSING':error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EVIDENCE_INVALID',target);}}
      }
      const unit=report.runs.find(run=>run.command==='pnpm run test:unit')!,unitText=readPublic(root,unit.evidence,32000000).toString('utf8'),pass=Number(unitText.match(/^# pass (\d+)$/m)?.[1]??0);
      const allLocal=report.runs.filter(run=>!['pnpm run doctor','pnpm run audit:public'].includes(run.command)).every(run=>run.exitCode===0&&!run.signal);
      if(items.some(item=>item.status==='PASS'&&item.id!=='D1-07'&&item.id!=='D7-07')&&(!allLocal||!completeUnitRun(unitText,1)||report.applicationTests!==undefined&&pass!==report.applicationTests))add('PASS_WITH_INCOMPLETE_LOCAL_RUN');
      for(const run of report.runs.filter(run=>run.command.startsWith('pnpm run test:contract'))){const text=readPublic(root,run.evidence,32000000).toString('utf8');if(items.some(item=>item.status==='PASS'&&item.id!=='D1-07')&&!/Ran \d+ test suites?[^\n]*: [1-9]\d* tests passed, 0 failed, 0 skipped \([1-9]\d* total tests\)/.test(text))add('PASS_WITH_INCOMPLETE_CONTRACT_RUN',run.evidence);}
      if(report.status==='FAIL')add('STAGE_REPORTED_FAILURE');
      if(report.status==='PASS'&&items.filter(item=>item.applicable!==false).some(item=>item.status!=='PASS')||report.status!=='FAIL'&&items.some(item=>item.status==='FAIL'))add('REPORT_AGGREGATE_CONFLICT');
      if(day==='D6'&&items.some(item=>item.id==='D6-01'&&item.status==='PASS'&&item.scope!=='LOCAL_DETERMINISTIC_APPLICATION_AND_MONAD_NATIVE_TESTS'))add('REPORT_PASS_SCOPE_INVALID');
      if(day==='D7'){
        const profiles=report.profiles;if(!profiles||profiles.length!==profileNames.length||new Set(profiles.map(p=>p.name)).size!==profileNames.length||profileNames.some(name=>!profiles.some(profile=>profile.name===name))||profiles.some(p=>p.applicable!==(p.name!==profileNames[0]))||profiles[0].status!=='NOT_STARTED'||profiles.some(p=>p.applicable&&p.status==='PASS')&&!manualReleaseValid||items.some(item=>item.id==='D7-07'&&item.status==='PASS'&&item.scope!=='HONEST_PROFILE_REPORTING_ONLY_NOT_RELEASE_ELIGIBILITY'))add('REPORT_PROFILE_SCOPE_INVALID');
      }
      return {day,reportStatus:report.status,scope:report.scope??fallbackScope[index],commit:report.commit??null,worktreeDirty:report.worktreeDirty??null,startedAt:report.startedAt,endedAt:report.endedAt,reference,runs:report.runs.map(run=>({...run,file:files.get(run.evidence)!})),reportedItems:items,profiles:report.profiles??[],issues:stageIssues,sourceCoverage:'HISTORICAL_OPERATOR_REPORT_NOT_CURRENT_HEAD_ATTESTATION'};
    }catch(error){const missing=(error as NodeJS.ErrnoException).code==='ENOENT',code=missing?'REPORT_OR_LOG_MISSING':error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'REPORT_INVALID';add(code);return {day,reportStatus:report?.status??null,scope:report?.scope??fallbackScope[index],commit:report?.commit??null,worktreeDirty:report?.worktreeDirty??null,startedAt:report?.startedAt??null,endedAt:report?.endedAt??null,reference:reference??null,runs:[],reportedItems:[],profiles:[],issues:stageIssues,sourceCoverage:'INCOMPLETE_OR_INVALID_REPORT'};}
  });
  const items=requirements.map(requirement=>{const stage=stages.find(stage=>stage.day===requirement.day)!,reported=stage.reportedItems.find(item=>item.id===requirement.id),invalid=stage.issues.length>0,missing=stage.issues.some(issue=>issue.code==='REPORT_OR_LOG_MISSING');
    const result=!requirement.applicable?'NOT_STARTED':invalid?(missing?'BLOCKED':'FAIL'):reported?.status==='NOT_STARTED'?'BLOCKED':reported?.status??'BLOCKED';
    return {...requirement,result,reportedResult:reported?.status??null,evidence:stage.reference,commit:stage.commit,worktreeDirty:stage.worktreeDirty,startedAt:stage.startedAt,endedAt:stage.endedAt,evidenceScope:reported?.scope??stage.scope,integrity:invalid?'INCOMPLETE_OR_INVALID':'STRUCTURE_AND_CURRENT_REFERENCES_CHECKED_NOT_PROVENANCE',reason:invalid?stage.issues.map(issue=>issue.code).join('; '):reported?.reason??'No recorded acceptance result.',sourceCoverage:stage.sourceCoverage};
  });
  const totals={PASS:items.filter(item=>item.result==='PASS').length,FAIL:items.filter(item=>item.result==='FAIL').length,BLOCKED:items.filter(item=>item.result==='BLOCKED').length,NOT_STARTED:items.filter(item=>item.result==='NOT_STARTED').length};
  const overall=items.some(item=>item.applicable&&item.result==='FAIL')?'FAIL':items.filter(item=>item.applicable).every(item=>item.result==='PASS')?'PASS':'BLOCKED';
  const report={schemaVersion:2,scope:'HISTORICAL_STAGE_REPORT_INDEX_NOT_INDEPENDENT_PROVIDER_OR_CURRENT_HEAD_ACCEPTANCE',route:settlementRoute,...meta,status:overall,source,counts:{total:items.length,applicable:items.filter(item=>item.applicable).length,...totals},stages,items,files:[...files.values()],issues,limits:['No stage commands, provider calls, wallet actions, deployment or physical device checks executed by indexing.','Hashes bind bytes available at indexing, not provider provenance or the full dirty tested source.','Local formats, D6 fixed review report integrity and D5/D7 recorded manual assertions/current public evidence byte bindings supported; not independent provider or human-provenance attestation.','Missing historical commit/worktree metadata stays null; no current revision is substituted.','Supplemental references without snapshotPath are current bytes and may change; primary reports/logs are pinned.']};
  return {report,snapshots};
}
function safeCsv(value:unknown){const raw=String(value??''),text=/^[=+\-@\t\r]/.test(raw)?"'"+raw:raw;return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;}
function md(value:unknown){return String(value??'未记录').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replace(/[\r\n]/g,' ');}
export function renderAcceptanceIndex(report:ReturnType<typeof buildAcceptanceIndex>['report']){
  const headers=['id','day','scope','action','expected_result','required_evidence','applicable','result','evidence_path','commit','reviewer','notes','reported_result','report_sha256','started_at','ended_at','worktree_dirty','evidence_scope','evidence_integrity','source_coverage'];
  const csv=[headers,...report.items.map(row=>[row.id,row.day,row.scope,row.action,row.expectedResult,row.requiredEvidence,row.applicable,row.result,row.evidence?.snapshotPath??'',row.commit??'','Stage report index; no rerun',row.reason,row.reportedResult??'',row.evidence?.sha256??'',row.startedAt??'',row.endedAt??'',row.worktreeDirty??'',row.evidenceScope,row.integrity,row.sourceCoverage])].map(row=>row.map(safeCsv).join(',')).join('\n')+'\n';
  const markdown=`# IntentPass 验收状态索引\n\n路线：${report.route} / PACT-inspired。记录索引总体：${report.status}；${report.counts.total} 条、${report.counts.applicable} 条适用。记录状态 PASS=${report.counts.PASS}，FAIL=${report.counts.FAIL}，BLOCKED=${report.counts.BLOCKED}；不适用保留 NOT_STARTED=${report.counts.NOT_STARTED}。\n\n这是最后一份可用阶段报告所记录的历史状态，不是本轮独立复跑、当前 HEAD 或实际提供方验收证明。生成时间 ${report.generatedAt}；生成时 HEAD ${report.head??'未记录'}，工作区修改 ${report.worktreeDirty??'未记录'}。每份原报告保留自己的 commit、时间、dirty 和范围；缺失版本不填当前 HEAD。\n\n来源：主规格 ${report.source.path}，SHA-256 ${report.source.sha256}。源码/供应商资料与本索引的哈希仅绑定当前文件字节。原阶段 JSON 和专属运行日志有独立快照，附加证据只显示当时可读取的字节摘要，不证明它属于原运行。\n\n| ID | 适用 | 记录结果 | 原报告结果 | 原报告 commit / dirty | 时间 | 验证范围 | 原始报告快照 | 原因 |\n|---|---|---|---|---|---|---|---|---|\n${report.items.map(row=>`| ${row.id} | ${row.applicable} | ${row.result} | ${row.reportedResult??'缺失'} | ${row.commit??'未记录'} / ${row.worktreeDirty??'未记录'} | ${row.startedAt??'未记录'} → ${row.endedAt??'未记录'} | ${md(row.evidenceScope)} | ${row.evidence?.snapshotPath??'缺失'} | ${md(row.reason)} |`).join('\n')}\n\nD3-07 依据负责人已批准的路线设 applicable=false，保持 NOT_STARTED；不计为 PASS。D7-07 的 PASS 仅为分开报告各 profile，不等于任一产品/bounty 通过。\n\n使用 pnpm acceptance:index 刷新；pnpm acceptance:index:check 只检查当前输入/生成文件/快照是否一致，不运行阶段或真实接入。总体非 PASS 时两个命令保持非零，即使索引格式一致。阶段入口保存其自身结果后自动刷新索引，不把全项目 BLOCKED 改成阶段 FAIL。\n\n机器证据在 artifacts/acceptance/index.json；完整要求和记录见 docs/acceptance.csv。\n`;
  return {csv,markdown};
}
export function writeAcceptanceIndex(root:string,meta:Meta){
  const {report,snapshots}=buildAcceptanceIndex(root,meta),rendered=renderAcceptanceIndex(report),directory=resolve(root,base);mkdirSync(directory,{recursive:true});
  for(const path of snapshots.keys())if(existsSync(resolve(root,path)))throw new Error('INDEX_SNAPSHOT_ALREADY_EXISTS');
  const archive=resolve(root,`${base}/history/${meta.snapshotId}-index`);for(const path of ['docs/acceptance.csv','docs/acceptance-index.md',`${base}/index.json`])if(existsSync(resolve(root,path))){mkdirSync(archive,{recursive:true});copyFileSync(resolve(root,path),resolve(archive,path.replaceAll('/','__')));}
  for(const [path,bytes] of snapshots){const absolute=resolve(root,path);if(existsSync(absolute))throw new Error('INDEX_SNAPSHOT_ALREADY_EXISTS');mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,bytes,{flag:'wx'});}
  const result={...report,outputs:{csvSha256:sha(Buffer.from(rendered.csv)),markdownSha256:sha(Buffer.from(rendered.markdown))}};
  writeFileSync(resolve(root,'docs/acceptance.csv'),rendered.csv);writeFileSync(resolve(root,'docs/acceptance-index.md'),rendered.markdown);writeFileSync(resolve(root,`${base}/index.json`),JSON.stringify(result,null,2)+'\n');return result;
}
export function checkAcceptanceIndex(root:string){
  const stored=JSON.parse(readFileSync(resolve(root,`${base}/index.json`),'utf8')),meta=metadata.parse({generatedAt:stored.generatedAt,head:stored.head,worktreeDirty:stored.worktreeDirty,snapshotId:stored.snapshotId}),{report,snapshots}=buildAcceptanceIndex(root,meta),rendered=renderAcceptanceIndex(report),expected={...report,outputs:{csvSha256:sha(Buffer.from(rendered.csv)),markdownSha256:sha(Buffer.from(rendered.markdown))}};
  if(JSON.stringify(stored)!==JSON.stringify(expected)||readFileSync(resolve(root,'docs/acceptance.csv'),'utf8')!==rendered.csv||readFileSync(resolve(root,'docs/acceptance-index.md'),'utf8')!==rendered.markdown)throw new Error('INDEX_STALE_OR_MODIFIED');
  for(const [path,bytes] of snapshots){const absolute=resolve(root,path);if(lstatSync(absolute).isSymbolicLink()||!realpathSync(absolute).startsWith(realpathSync(root)+sep)||sha(readFileSync(absolute))!==sha(bytes))throw new Error('INDEX_SNAPSHOT_INVALID');}return stored as typeof expected;
}
export function refreshAcceptanceIndex(root=process.cwd()){
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}),generatedAt=new Date().toISOString();return writeAcceptanceIndex(root,{generatedAt,head:commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty:commandExit(working)===0?!!working.stdout.trim():null,snapshotId:generatedAt.replaceAll(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex')});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(process.argv.slice(2).some(arg=>arg!=='--check'))throw new Error('INDEX_ARGUMENT_INVALID');const result=process.argv.includes('--check')?checkAcceptanceIndex(process.cwd()):refreshAcceptanceIndex();console.log(JSON.stringify({status:result.status,scope:result.scope,counts:result.counts,issues:result.issues}));process.exitCode=result.status==='PASS'?0:1;}catch(error){console.error(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'ACCEPTANCE_INDEX_UNAVAILABLE');process.exitCode=1;}
}
