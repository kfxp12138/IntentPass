import {z} from 'zod';
import {lstatSync,realpathSync,openSync,readSync,fstatSync,closeSync,constants} from 'node:fs';
import {resolve,relative,dirname,isAbsolute,sep,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {ReleaseAssetsSchema} from './release-assets.js';
import {auditBytes} from './public-audit.js';
import {strictJsonParse} from './strict-json.js';
import {Day5BrowserContextSchema} from './day5-review-types.js';
import {releaseEvidencePathPattern} from './release-evidence-types.js';
export {releaseEvidencePathPattern} from './release-evidence-types.js';

export const releaseReviewScope='OPERATOR_RECORDED_MANUAL_RELEASE_CHECKS' as const;
export const releaseAssertions={
  'D7-01':['PUBLIC_HTTPS_PRODUCT_ACCESSIBLE','JUDGE_LOGIN_IDENTITY_FUNDS_USABLE','REAL_END_TO_END_FLOW_ACCESSIBLE','NO_AUTHOR_LOCALHOST_OR_STALE_ACCOUNT_DEPENDENCE'],
  'D7-02':['REAL_PRODUCT_OPERATION_REVIEWED','PUBLIC_MONAD_TRANSACTIONS_REVIEWED','KEY_SPONSOR_FUNCTIONS_REVIEWED','NO_SLIDES_OR_CODE_WALKTHROUGH_SUBSTITUTION','TECHNICAL_VIDEO_WITHIN_180_SECONDS'],
  'D7-03':['PITCH_CONTENT_REVIEWED','PITCH_WITHIN_120_SECONDS','CLEANVERSE_CONTENT_REVIEWED','CLEANVERSE_WITHIN_300_SECONDS','REAL_CVI_CHECK_BEFORE_CVA_ACTION_REVIEWED'],
  'D7-04':['TWO_NON_WALLET_NAMESPACES_REVIEWED','SAME_PASSKEY_SECOND_PHYSICAL_DEVICE_REVIEWED','NO_COPIED_PLAINTEXT_KEY_PRF_OR_LOCAL_SESSION','PRIVY_BEYOND_LOGIN_REVIEWED','REAL_PRIVY_ALLOWED_EXECUTION_REVIEWED','REAL_PRIVY_POLICY_DENIAL_REVIEWED'],
  'D7-05':['PUBLIC_REPOSITORY_ACCESSIBLE','RELEASE_COMMIT_AND_BUILD_HISTORY_MATCH','LICENSE_ATTRIBUTION_AI_DISCLOSURE_REVIEWED','DEPLOYED_ADDRESSES_SOURCE_ABI_MATCH','JUDGE_ACCESS_DOCUMENTATION_USABLE','ALL_PUBLIC_SOURCE_BUILD_LOG_MEDIA_PRIVACY_REVIEWED'],
  'D7-06':['ALL_UPLOADED_URLS_ACCESSIBLE','PLATFORM_SAVED_VERSION_REVIEWED','REAL_SUBMISSION_RECEIPT_REVIEWED','NO_PENDING_UPLOAD_CLAIMED_COMPLETE'],
} as const;
export type ReleaseCheckId=keyof typeof releaseAssertions;
const ids=Object.keys(releaseAssertions) as ReleaseCheckId[];
const idSchema=z.enum(ids as [ReleaseCheckId,...ReleaseCheckId[]]),statusSchema=z.enum(['PASS','FAIL','BLOCKED']),shaSchema=z.string().regex(/^[a-f0-9]{64}$/),commitSchema=z.string().regex(/^[a-f0-9]{40}$/),timeSchema=z.iso.datetime();
const absolutePathSchema=z.string().min(1).max(4096).refine(isAbsolute);
const publicEvidenceSchema=z.object({path:z.string().max(4096).regex(releaseEvidencePathPattern),bytes:z.number().int().positive().max(536870912),sha256:shaSchema}).strict();
const evidenceSchema=publicEvidenceSchema.extend({path:absolutePathSchema}).strict();
const assertionSchema=(id:ReleaseCheckId)=>z.object(Object.fromEntries(releaseAssertions[id].map(key=>[key,z.boolean()]))).strict();
function privateCheckSchema(id:ReleaseCheckId){return z.object({id:z.literal(id),status:statusSchema,reviewer:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),assertions:assertionSchema(id),evidence:z.array(evidenceSchema).max(64)}).strict();}
function publicCheckSchema(id:ReleaseCheckId){return z.object({id:z.literal(id),status:statusSchema,assertions:assertionSchema(id),evidence:z.array(publicEvidenceSchema).max(64)}).strict();}
const privateChecks=z.union(ids.map(privateCheckSchema) as [ReturnType<typeof privateCheckSchema>,ReturnType<typeof privateCheckSchema>,...ReturnType<typeof privateCheckSchema>[]]);
const publicChecks=z.union(ids.map(publicCheckSchema) as [ReturnType<typeof publicCheckSchema>,ReturnType<typeof publicCheckSchema>,...ReturnType<typeof publicCheckSchema>[]]);
const ReleaseReviewV1Schema=z.object({schemaVersion:z.literal(1),scope:z.literal(releaseReviewScope),sourceCommit:commitSchema,assetsSha256:shaSchema,reviewedAt:timeSchema,checks:z.array(privateChecks).max(6)}).strict().superRefine((record,ctx)=>{if(new Set(record.checks.map(check=>check.id)).size!==record.checks.length)ctx.addIssue({code:'custom',message:'DUPLICATE_CHECK'});});
export const releaseSponsorAssertions={
  MERA:['TWO_NON_WALLET_NAMESPACES_REVIEWED','SAME_PASSKEY_INDEPENDENT_CONTEXT_REVIEWED','NO_COPIED_PLAINTEXT_KEY_PRF_OR_LOCAL_SESSION','REAL_HUMAN_CEREMONY_NO_VIRTUAL_AUTHENTICATOR'],
  PRIVY:['PRIVY_BEYOND_LOGIN_REVIEWED','REAL_PRIVY_ALLOWED_EXECUTION_REVIEWED','REAL_PRIVY_POLICY_DENIAL_REVIEWED'],
} as const;
type SponsorId=keyof typeof releaseSponsorAssertions;
const sponsorIds=['MERA','PRIVY'] as const;
export const releaseAssertionsV2={...releaseAssertions,'D7-04':[...releaseSponsorAssertions.MERA,...releaseSponsorAssertions.PRIVY,'SAME_PASSKEY_SECOND_PHYSICAL_DEVICE_REVIEWED']} as const;
export function releaseAssertionsFor(version:1|2,id:ReleaseCheckId):readonly string[]{return (version===2?releaseAssertionsV2:releaseAssertions)[id];}
const sponsorCheckSchema=(id:SponsorId,privateRecord:boolean)=>z.object({id:z.literal(id),status:statusSchema,assertions:z.object(Object.fromEntries(releaseSponsorAssertions[id].map(key=>[key,z.boolean()]))).strict(),evidence:z.array(privateRecord?evidenceSchema:publicEvidenceSchema).max(64),...(privateRecord?{reviewer:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)}:{})}).strict();
const privateSponsors=z.union(sponsorIds.map(id=>sponsorCheckSchema(id,true)) as [ReturnType<typeof sponsorCheckSchema>,ReturnType<typeof sponsorCheckSchema>]);
const publicSponsors=z.union(sponsorIds.map(id=>sponsorCheckSchema(id,false)) as [ReturnType<typeof sponsorCheckSchema>,ReturnType<typeof sponsorCheckSchema>]);
const productOriginSchema=z.string().max(2048).refine(value=>{try{return new URL(value).origin===value&&Day5BrowserContextSchema.shape.configuration.safeParse({publicUrl:value+'/',rpId:new URL(value).hostname}).success;}catch{return false;}});
const ReleaseReviewV2Schema=z.object({schemaVersion:z.literal(2),scope:z.literal(releaseReviewScope),sourceCommit:commitSchema,assetsSha256:shaSchema,reviewedAt:timeSchema,checks:z.array(privateChecks).max(5),sponsorChecks:z.array(privateSponsors).max(2),recoveryContext:Day5BrowserContextSchema.nullable()}).strict().superRefine((record,ctx)=>{
  if(new Set(record.checks.map(check=>check.id)).size!==record.checks.length||record.checks.some(check=>check.id==='D7-04'))ctx.addIssue({code:'custom',message:'CHECK_IDS_INVALID'});
  if(new Set(record.sponsorChecks.map(check=>check.id)).size!==record.sponsorChecks.length)ctx.addIssue({code:'custom',message:'DUPLICATE_SPONSOR'});
});
export const ReleaseReviewSchema=z.union([ReleaseReviewV1Schema,ReleaseReviewV2Schema]);
const issueSchema=z.object({code:z.string().regex(/^[A-Z_]+$/),id:idSchema.optional(),sponsor:z.enum(sponsorIds).optional(),evidenceIndex:z.number().int().min(0).max(63).optional()}).strict();
const mediaBindingSchema=z.object({path:z.string().min(1).max(4096),bytes:z.number().int().positive().max(536870912),sha256:shaSchema}).strict();
export const releaseReviewLimits=[
  'Only operator record integrity, fixed assertions and current public evidence byte bindings are checked; this is not independent provider attestation.',
  'A file and operator assertion cannot establish a real provider request, person, physical device, reachable URL, funds transfer or saved platform state.',
  'No model calls, wallet actions, uploads or platform submissions are performed by this validator.',
  'Raw-byte heuristics do not decode media or prove absence of arbitrary private text; binary clearance is an operator manual-review claim.',
  'The private record path and reviewer text are omitted; its hash binds the file read, not its provenance.',
] as const;
const manifestFields={scope:z.literal(releaseReviewScope),status:statusSchema,sha256:shaSchema.nullable(),sourceCommit:commitSchema.nullable(),assetsSha256:shaSchema.nullable(),reviewedAt:timeSchema.nullable(),timeWindow:z.object({sourceCommittedAt:timeSchema.nullable(),startedAt:timeSchema,checkedAt:timeSchema}).strict(),issues:z.array(issueSchema),privacyReview:z.object({status:statusSchema,scope:z.literal('OPERATOR_MANUAL_BINARY_REVIEW_NOT_INDEPENDENT_PRIVACY_ATTESTATION'),reviewedUnverified:z.array(mediaBindingSchema)}).strict(),limits:z.array(z.string())};
const ReleaseReviewManifestV1Schema=z.object({schemaVersion:z.literal(1),...manifestFields,checks:z.array(publicChecks).length(6)}).strict().superRefine((record,ctx)=>{if(record.checks.some((check,index)=>check.id!==ids[index])||record.issues.some(issue=>issue.sponsor!==undefined))ctx.addIssue({code:'custom',message:'CHECK_ORDER_INVALID'});});
const publicChecksV2=z.union(ids.map(id=>id==='D7-04'?publicCheckSchema(id).extend({assertions:z.object(Object.fromEntries(releaseAssertionsV2[id].map(key=>[key,z.boolean()]))).strict()}).strict():publicCheckSchema(id)) as [ReturnType<typeof publicCheckSchema>,ReturnType<typeof publicCheckSchema>,...ReturnType<typeof publicCheckSchema>[]]);
function recoveryScopeValid(context:z.infer<typeof Day5BrowserContextSchema>|null,sourceCommittedAt:string|null,reviewedAt:string|null){return !!context?.secondaryContext&&!!sourceCommittedAt&&!!reviewedAt&&Date.parse(context.observationsStartedAt)>=Date.parse(sourceCommittedAt)&&Date.parse(context.observationsEndedAt)<=Date.parse(reviewedAt);}
function derivedSponsorCheck(sponsors:readonly z.infer<typeof publicSponsors>[],context:z.infer<typeof Day5BrowserContextSchema>|null){
  const mera=sponsors.find(check=>check.id==='MERA'),physical:'PASS'|'FAIL'|'BLOCKED'=context?.secondaryContext?.kind!=='PHYSICAL_DEVICE'?'BLOCKED':mera?.status==='FAIL'?'FAIL':mera?.status==='PASS'?'PASS':'BLOCKED';
  const evidence=[...new Map(sponsors.flatMap(check=>check.evidence).map(binding=>[binding.path,binding])).values()];
  return {physical,check:{id:'D7-04' as const,status:outcome([...sponsors.map(check=>check.status),physical]),assertions:{...Object.assign({},...sponsors.map(check=>check.assertions)),SAME_PASSKEY_SECOND_PHYSICAL_DEVICE_REVIEWED:physical==='PASS'},evidence}};
}
const ReleaseReviewManifestV2Schema=z.object({schemaVersion:z.literal(2),...manifestFields,checks:z.array(publicChecksV2).length(6),sponsorChecks:z.array(publicSponsors).length(2),recoveryContext:Day5BrowserContextSchema.nullable(),productOrigin:productOriginSchema.nullable(),physicalSecondDeviceStoryStatus:statusSchema}).strict().superRefine((record,ctx)=>{
  const fail=()=>ctx.addIssue({code:'custom',message:'SPONSOR_SCOPE_OR_DERIVATION_INVALID'});
  if(auditBytes('release-recovery-context.json',Buffer.from(JSON.stringify(record.recoveryContext))).length)fail();
  if(record.checks.some((check,index)=>check.id!==ids[index])||record.sponsorChecks.some((check,index)=>check.id!==sponsorIds[index])){fail();return;}
  const shared=new Map<string,z.infer<typeof publicEvidenceSchema>>();
  for(const check of record.sponsorChecks){
    if(check.status==='PASS'&&(!releaseSponsorAssertions[check.id].every(key=>check.assertions[key]===true)||!check.evidence.length||record.issues.some(issue=>issue.sponsor===check.id)))fail();
    if(new Set(check.evidence.map(binding=>binding.path)).size!==check.evidence.length)fail();
    for(const binding of check.evidence){const previous=shared.get(binding.path);if(previous&&(previous.bytes!==binding.bytes||previous.sha256!==binding.sha256))fail();shared.set(binding.path,binding);}
  }
  if([...record.checks,...record.sponsorChecks].some(check=>check.status==='PASS')&&(!record.sha256||!record.sourceCommit||!record.assetsSha256||!record.reviewedAt||!record.timeWindow.sourceCommittedAt||Date.parse(record.reviewedAt)<Date.parse(record.timeWindow.sourceCommittedAt)||Date.parse(record.reviewedAt)>Date.parse(record.timeWindow.startedAt)||Date.parse(record.timeWindow.checkedAt)<Date.parse(record.timeWindow.startedAt)))fail();
  if(record.sponsorChecks[0].status==='PASS'&&!recoveryScopeValid(record.recoveryContext,record.timeWindow.sourceCommittedAt,record.reviewedAt))fail();
  if(record.sponsorChecks[0].status==='PASS'&&(!record.productOrigin||!record.recoveryContext||new URL(record.recoveryContext.configuration.publicUrl).origin!==record.productOrigin))fail();
  const derived=derivedSponsorCheck(record.sponsorChecks,record.recoveryContext),combined=record.checks[3];
  if(derived.physical!==record.physicalSecondDeviceStoryStatus||derived.check.status!==combined.status||JSON.stringify(derived.check.assertions)!==JSON.stringify(combined.assertions)||JSON.stringify(derived.check.evidence)!==JSON.stringify(combined.evidence))fail();
  if(record.status!==outcome([...record.checks.map(check=>check.status),...(record.privacyReview.status==='FAIL'?['FAIL']:[])]))fail();
});
export const ReleaseReviewManifestSchema=z.union([ReleaseReviewManifestV1Schema,ReleaseReviewManifestV2Schema]);
export type ReleaseReviewManifest=z.infer<typeof ReleaseReviewManifestSchema>;
export interface ReleaseReviewContext {
  root:string;commit:string|null;sourceCommittedAt:string|null;startedAt:string;checkedAt:string;worktreeDirty:boolean;candidateStatus:'VALID'|'BLOCKED'|'FAIL';assetsSha256:string|null;
  candidate?:z.infer<typeof ReleaseAssetsSchema>;localPassed:boolean;assets:readonly Record<string,unknown>[];audit:unknown;
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type FileIdentity={ino:number;dev:number;size:number;mtimeMs:number};
const sameFile=(before:FileIdentity,after:FileIdentity)=>before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs;
function stableIdentity(path:string,maximum:number){
  if(!isAbsolute(path)||/^\.env(?:\.|$)/.test(basename(path))||/[.]db(?:-|$)/.test(basename(path)))throw new Error('LOCAL_FILE_INVALID');
  const file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink()||file.size<=0||file.size>maximum)throw new Error('LOCAL_FILE_INVALID');return file;
}
/** The private JSON bytes never enter the public manifest. Limit the read itself. */
export function readStableReleaseJson(path:string){
  if(!path.endsWith('.json'))throw new Error('LOCAL_JSON_INVALID');const before=stableIdentity(path,65536),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65537);let bytes=0;
  try{
    if(!sameFile(before,fstatSync(fd)))throw new Error('LOCAL_FILE_CHANGED');
    for(let length;(length=readSync(fd,buffer,bytes,buffer.length-bytes,null))>0;){bytes+=length;if(bytes>65536)throw new Error('LOCAL_FILE_INVALID');}
    if(bytes!==before.size||!sameFile(before,fstatSync(fd))||!sameFile(before,stableIdentity(path,65536)))throw new Error('LOCAL_FILE_CHANGED');
  }finally{closeSync(fd);}
  const result=buffer.subarray(0,bytes);strictJsonParse(result.toString('utf8'));return result;
}
function hashStableLocalFile(path:string){
  const before=stableIdentity(path,536870912),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),chunk=Buffer.alloc(65536),digest=createHash('sha256');let bytes=0;
  try{
    if(!sameFile(before,fstatSync(fd)))throw new Error('LOCAL_FILE_CHANGED');
    for(let length;(length=readSync(fd,chunk,0,chunk.length,null))>0;){bytes+=length;if(bytes>536870912)throw new Error('LOCAL_FILE_INVALID');digest.update(chunk.subarray(0,length));}
    if(bytes!==before.size||!sameFile(before,fstatSync(fd))||!sameFile(before,stableIdentity(path,536870912)))throw new Error('LOCAL_FILE_CHANGED');
  }finally{closeSync(fd);}
  return {bytes,sha256:digest.digest('hex'),identity:before};
}
/** Local metadata probes must refer to the same exact bytes hashed before and after. */
export function inspectStableLocalAsset<T=undefined>(path:string,probe?:()=>T){
  const before=hashStableLocalFile(path),observation=probe?.();
  if(probe){const after=hashStableLocalFile(path);if(!sameFile(before.identity,after.identity)||before.bytes!==after.bytes||before.sha256!==after.sha256)throw new Error('LOCAL_FILE_CHANGED');}
  return {metadata:{bytes:before.bytes,sha256:before.sha256},observation};
}
function emptyCheck(id:ReleaseCheckId){return {id,status:'BLOCKED' as const,assertions:Object.fromEntries(releaseAssertions[id].map(key=>[key,false])),evidence:[]};}
function safePublicPath(path:string){return !isAbsolute(path)&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)&&path.split('/').every(part=>part!=='.'&&part!=='..'&&!part.startsWith('.')&&!/^(?:env|db|database)(?:[_-]|$)/i.test(part)&&!['node_modules','cache'].includes(part)&&!/[.]db(?:-|$)/i.test(part));}
/** Canonical paths only; no symlink in the file or its path, and no private files. */
function publicFile(root:string,path:string){
  const base=realpathSync(root);if(!safePublicPath(path))throw new Error('PUBLIC_PATH_INVALID');const absolute=resolve(base,path);
  if(relative(base,absolute)!==path||!absolute.startsWith(base+sep))throw new Error('PUBLIC_PATH_INVALID');
  for(let current=absolute;current!==base;current=dirname(current))if(lstatSync(current).isSymbolicLink())throw new Error('PUBLIC_SYMLINK_REJECTED');
  const before=lstatSync(absolute);if(!before.isFile()||before.size<=0||before.size>536870912)throw new Error('PUBLIC_FILE_INVALID');
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW),digest=createHash('sha256'),chunk=Buffer.alloc(65536);let bytes=0,unsafe=false,tail=Buffer.alloc(0);
  try{
    const opened=fstatSync(fd);if(before.ino!==opened.ino||before.dev!==opened.dev||before.size!==opened.size||before.mtimeMs!==opened.mtimeMs)throw new Error('PUBLIC_FILE_CHANGED');
    for(let length;(length=readSync(fd,chunk,0,chunk.length,null))>0;){bytes+=length;if(bytes>536870912)throw new Error('PUBLIC_FILE_INVALID');const current=chunk.subarray(0,length);digest.update(current);const inspected=Buffer.concat([tail,current]);unsafe||=auditBytes(path,inspected).length>0;tail=Buffer.from(inspected.subarray(Math.max(0,inspected.length-2048)));}
    const closed=fstatSync(fd),after=lstatSync(absolute);if(bytes!==before.size||closed.ino!==before.ino||closed.dev!==before.dev||closed.size!==before.size||closed.mtimeMs!==before.mtimeMs||after.isSymbolicLink()||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||realpathSync(absolute)!==absolute)throw new Error('PUBLIC_FILE_CHANGED');
  }finally{closeSync(fd);}
  return {unsafe,binding:{path,bytes,sha256:digest.digest('hex')}};
}
/** Reusable by the independent index; output contains only a public relative path. */
export function inspectReleaseEvidence(root:string,input:unknown){
  const evidence=publicEvidenceSchema.parse(input),file=publicFile(root,evidence.path);if(file.binding.bytes!==evidence.bytes||file.binding.sha256!==evidence.sha256)throw new Error('EVIDENCE_BYTES_MISMATCH');if(file.unsafe)throw new Error('PUBLIC_EVIDENCE_UNSAFE');return file.binding;
}
const auditSchema=z.object({startedAt:timeSchema,endedAt:timeSchema,scope:z.literal('PUBLIC_SOURCE_BUILD_LOG_RAW_BYTES_HEURISTIC_ONLY'),status:z.enum(['PASS','FAIL','BLOCKED']),findings:z.array(z.object({path:z.string(),line:z.number(),rule:z.string()})),unverified:z.array(z.string()),manifest:z.array(z.object({path:z.string(),bytes:z.number().int().nonnegative(),sha256:shaSchema,binary:z.boolean()})).min(1)});
function outcome(values:readonly string[]){return values.includes('FAIL')?'FAIL' as const:values.every(value=>value==='PASS')?'PASS' as const:'BLOCKED' as const;}
function metadata(context:ReleaseReviewContext,name:string){const matches=context.assets.filter(asset=>asset.name===name);return matches.length===1?matches[0]:undefined;}

/** Strict operator-record validation. No private configuration or URLs are read here. */
export function inspectReleaseReview(path:string|undefined,context:ReleaseReviewContext):ReleaseReviewManifest {
  type WorkingReview=Omit<z.infer<typeof ReleaseReviewManifestV1Schema>,'schemaVersion'>&{schemaVersion:1|2;sponsorChecks?:z.infer<typeof publicSponsors>[];recoveryContext?:z.infer<typeof Day5BrowserContextSchema>|null;productOrigin?:string|null;physicalSecondDeviceStoryStatus?:'PASS'|'FAIL'|'BLOCKED'};
  const result:WorkingReview={schemaVersion:1,scope:releaseReviewScope,status:'BLOCKED',sha256:null,sourceCommit:null,assetsSha256:null,reviewedAt:null,timeWindow:{sourceCommittedAt:context.sourceCommittedAt,startedAt:context.startedAt,checkedAt:context.checkedAt},checks:ids.map(emptyCheck),issues:[],privacyReview:{status:'BLOCKED',scope:'OPERATOR_MANUAL_BINARY_REVIEW_NOT_INDEPENDENT_PRIVACY_ATTESTATION',reviewedUnverified:[]},limits:[...releaseReviewLimits]};
  const issue=(code:string,id?:ReleaseCheckId,evidenceIndex?:number,sponsor?:SponsorId)=>{result.issues.push({code,...(id?{id}:{}),...(sponsor?{sponsor}:{}),...(evidenceIndex===undefined?{}:{evidenceIndex})});};
  let audit:z.infer<typeof auditSchema>|undefined;
  try{
    audit=auditSchema.parse(context.audit);const expected=audit.findings.length?'FAIL':audit.unverified.length?'BLOCKED':'PASS';
    if(audit.status!==expected||new Set(audit.unverified).size!==audit.unverified.length||new Set(audit.manifest.map(file=>file.path)).size!==audit.manifest.length||Date.parse(context.checkedAt)<Date.parse(context.startedAt)||Date.parse(audit.startedAt)<Date.parse(context.startedAt)||Date.parse(audit.endedAt)<Date.parse(audit.startedAt)||Date.parse(audit.endedAt)>Date.parse(context.checkedAt))throw new Error();
    if(audit.findings.length){issue('PUBLIC_AUDIT_FINDINGS');result.privacyReview.status='FAIL';}
  }catch{issue('PUBLIC_AUDIT_INVALID');result.privacyReview.status='FAIL';}
  if(!path){issue('REVIEW_NOT_CONFIGURED');result.status=result.privacyReview.status==='FAIL'?'FAIL':'BLOCKED';return ReleaseReviewManifestSchema.parse(result);}
  let record:z.infer<typeof ReleaseReviewSchema>;
  try{
    const bytes=readStableReleaseJson(path),input=strictJsonParse(bytes.toString('utf8'));
    // v2 adds publicly retained aliases/namespaces. Inspect both raw and decoded
    // private input before any input hash or normalized context is published.
    if(input&&typeof input==='object'&&'schemaVersion' in input&&input.schemaVersion===2
      &&(auditBytes('release-review-v2.json',bytes).length||auditBytes('release-review-v2.json',Buffer.from(JSON.stringify(input))).length))throw Error('REVIEW_RECORD_UNSAFE');
    record=ReleaseReviewSchema.parse(input);result.sha256=hash(bytes);
  }
  catch{issue('REVIEW_RECORD_INVALID');result.status='FAIL';return ReleaseReviewManifestSchema.parse(result);}
  result.sourceCommit=record.sourceCommit;result.assetsSha256=record.assetsSha256;result.reviewedAt=record.reviewedAt;
  if(record.schemaVersion===2){
    result.schemaVersion=2;result.recoveryContext=record.recoveryContext;result.physicalSecondDeviceStoryStatus='BLOCKED';result.productOrigin=null;
    try{const origin=new URL(context.candidate!.productUrl!).origin;if(productOriginSchema.safeParse(origin).success)result.productOrigin=origin;}catch{/* Absent declarations never acquire a product origin. */}
    result.sponsorChecks=sponsorIds.map(id=>({id,status:'BLOCKED',assertions:Object.fromEntries(releaseSponsorAssertions[id].map(key=>[key,false])),evidence:[]}));
  }
  let bindingFailed=false,bindingBlocked=false;
  if(!context.commit||record.sourceCommit!==context.commit||context.worktreeDirty){issue('REVIEW_SOURCE_MISMATCH');bindingFailed=true;}
  if(!context.sourceCommittedAt||!timeSchema.safeParse(context.sourceCommittedAt).success||Date.parse(record.reviewedAt)<Date.parse(context.sourceCommittedAt)||Date.parse(record.reviewedAt)>Date.parse(context.startedAt)){issue('REVIEW_TIME_INVALID');bindingFailed=true;}
  if(context.candidateStatus==='BLOCKED'){issue('RELEASE_CANDIDATE_REQUIRED');bindingBlocked=true;}
  else if(context.candidateStatus!=='VALID'||!context.candidate||context.candidate.sourceCommit!==record.sourceCommit||!context.assetsSha256||record.assetsSha256!==context.assetsSha256){issue('REVIEW_ASSETS_MISMATCH');bindingFailed=true;}
  const normalize=(id:ReleaseCheckId,original:{status:'PASS'|'FAIL'|'BLOCKED';assertions:Record<string,boolean>;evidence:z.infer<typeof evidenceSchema>[]} |undefined,check:{status:'PASS'|'FAIL'|'BLOCKED';assertions:Record<string,boolean>;evidence:z.infer<typeof publicEvidenceSchema>[]},keys:readonly string[],sponsor?:SponsorId)=>{
    if(!original){issue('MANUAL_CHECK_MISSING',id,undefined,sponsor);if(bindingFailed)check.status='FAIL';return;}
    check.assertions={...original.assertions};check.status=original.status;
    if(bindingFailed)check.status='FAIL';else if(bindingBlocked&&check.status==='PASS')check.status='BLOCKED';
    const seen=new Set<string>();
    for(const [index,evidence] of original.evidence.entries())try{
      const base=realpathSync(context.root),relativePath=relative(base,evidence.path);
      if(evidence.path!==resolve(base,relativePath)||!releaseEvidencePathPattern.test(relativePath)||seen.has(relativePath))throw new Error('EVIDENCE_PATH_INVALID');seen.add(relativePath);
      check.evidence.push(inspectReleaseEvidence(context.root,{...evidence,path:relativePath}));
    }catch(error){issue(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EVIDENCE_INVALID',id,index,sponsor);check.status='FAIL';}
    if(original.status==='PASS'&&(!keys.every(key=>check.assertions[key]===true)||original.evidence.length===0)){issue('MANUAL_ASSERTIONS_OR_EVIDENCE_INCOMPLETE',id,undefined,sponsor);check.status='FAIL';}
    if(original.status==='FAIL')issue('MANUAL_CHECK_FAILED',id,undefined,sponsor);
  };
  for(const id of ids){
    if(record.schemaVersion===2&&id==='D7-04')continue;
    normalize(id,record.checks.find(check=>check.id===id),result.checks.find(check=>check.id===id)!,releaseAssertions[id]);
  }
  if(record.schemaVersion===2){
    for(const check of result.sponsorChecks!)normalize('D7-04',record.sponsorChecks.find(original=>original.id===check.id),check,releaseSponsorAssertions[check.id],check.id);
    const mera=result.sponsorChecks![0];
    if(mera.status==='PASS'){
      let valid=recoveryScopeValid(record.recoveryContext,context.sourceCommittedAt,record.reviewedAt);
      try{valid=valid&&!!context.candidate?.productUrl&&new URL(record.recoveryContext!.configuration.publicUrl).origin===new URL(context.candidate!.productUrl!).origin;}catch{valid=false;}
      if(!valid){issue('MERA_RECOVERY_CONTEXT_INVALID','D7-04',undefined,'MERA');mera.status='FAIL';}
    }
    const derived=derivedSponsorCheck(result.sponsorChecks!,record.recoveryContext);
    result.physicalSecondDeviceStoryStatus=derived.physical;result.checks[3]=derived.check;
  }
  const requireBinding=(id:ReleaseCheckId,name:string,expectedStatus:string,maximumSeconds?:number)=>{
    const check=result.checks.find(check=>check.id===id)!;if(check.status!=='PASS')return;
    const asset=metadata(context,name);if(!asset||asset.status!==expectedStatus||typeof asset.bytes!=='number'||typeof asset.sha256!=='string'){issue('REQUIRED_ASSET_METADATA_MISSING',id);check.status=asset?.status==='FAIL'?'FAIL':'BLOCKED';return;}
    if(!Number.isSafeInteger(asset.bytes)||asset.bytes<=0||!shaSchema.safeParse(asset.sha256).success||(maximumSeconds!==undefined&&(typeof asset.durationSeconds!=='number'||!Number.isFinite(asset.durationSeconds)||asset.durationSeconds<=0||asset.durationSeconds>maximumSeconds||asset.maximumSeconds!==maximumSeconds))||(name==='logo'&&asset.bytes>3000000)){issue('REQUIRED_ASSET_METADATA_INVALID',id);check.status='FAIL';return;}
    if(!check.evidence.some(evidence=>evidence.bytes===asset.bytes&&evidence.sha256===asset.sha256)){issue('REQUIRED_ASSET_EVIDENCE_MISSING',id);check.status='FAIL';}
  };
  requireBinding('D7-02','technicalVideo','LOCAL_METADATA_PASS',180);requireBinding('D7-03','pitchVideo','LOCAL_METADATA_PASS',120);requireBinding('D7-03','cleanverseVideo','LOCAL_METADATA_PASS',300);requireBinding('D7-05','logo','LOCAL_METADATA_PASS');requireBinding('D7-06','submissionReceipt','LOCAL_FILE_PRESENT_MANUAL_PLATFORM_VERIFICATION_REQUIRED');
  for(const [id,available] of [['D7-01',!!context.candidate?.productUrl],['D7-05',!!context.candidate?.repositoryUrl&&!!context.candidate.productUrl],['D7-06',!!context.candidate?.submission&&!!context.candidate.technicalVideo&&!!context.candidate.pitchVideo&&!!context.candidate.cleanverseVideo]] as const){const check=result.checks.find(check=>check.id===id)!;if(check.status==='PASS'&&!available){issue('REQUIRED_PUBLIC_DECLARATION_MISSING',id);check.status='BLOCKED';}}
  const privacy=result.checks.find(check=>check.id==='D7-05')!;
  if(!context.localPassed&&privacy.status==='PASS'){issue('LOCAL_RELEASE_PREREQUISITES_INCOMPLETE','D7-05');privacy.status='FAIL';}
  if(result.privacyReview.status==='FAIL')privacy.status='FAIL';
  else if(audit&&privacy.status==='PASS'){
    for(const path of audit.unverified)try{
      const expected=audit.manifest.find(file=>file.path===path);if(!expected||!expected.binary)throw new Error('AUDIT_UNVERIFIED_BINDING_INVALID');
      const current=publicFile(context.root,path);if(current.binding.bytes!==expected.bytes||current.binding.sha256!==expected.sha256)throw new Error('AUDIT_UNVERIFIED_BYTES_CHANGED');if(current.unsafe)throw new Error('PUBLIC_AUDIT_FINDINGS');
      if(!privacy.evidence.some(evidence=>evidence.bytes===expected.bytes&&evidence.sha256===expected.sha256))throw new Error('MANUAL_MEDIA_EVIDENCE_MISSING');result.privacyReview.reviewedUnverified.push(current.binding);
    }catch(error){issue(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'AUDIT_UNVERIFIED_BINDING_INVALID','D7-05');privacy.status='FAIL';}
    result.privacyReview.status=privacy.status==='PASS'?'PASS':'FAIL';
  }
  result.status=bindingFailed?'FAIL':outcome([...result.checks.map(check=>check.status),...(result.privacyReview.status==='FAIL'?['FAIL']:[])]);
  return ReleaseReviewManifestSchema.parse(result);
}

/** Profile state follows required manual checks, never a local test count. */
export function releaseProfiles(checks:readonly {id:ReleaseCheckId;status:'PASS'|'FAIL'|'BLOCKED'}[],review?:ReleaseReviewManifest){
  const required:{name:string;ids:ReleaseCheckId[]}[]=[{name:'PACT-inspired product',ids:[...ids]},{name:'Cleanverse CVA/CVI',ids:['D7-01','D7-02','D7-03','D7-05','D7-06']},{name:'Privy',ids:['D7-01','D7-02','D7-04','D7-05','D7-06']},{name:'Mera',ids:['D7-01','D7-02','D7-04','D7-05','D7-06']},{name:'JEV',ids:['D7-01','D7-02','D7-05','D7-06']}];
  const checked=review?.schemaVersion===2?ReleaseReviewManifestV2Schema.safeParse(review):undefined;
  const matching=checked?.success&&checks.length===checked.data.checks.length&&checks.every((check,index)=>check.id===checked.data.checks[index].id&&check.status===checked.data.checks[index].status);
  return [{name:'Full PACT / IMAS / CDAS',applicable:false,status:'NOT_STARTED' as const,reason:'Owner approved original Monad route; no Full PACT eligibility claimed.'},...required.map(profile=>{
    const sponsor=profile.name==='Mera'?'MERA':profile.name==='Privy'?'PRIVY':undefined;
    const separate=review?.schemaVersion===2&&sponsor;
    const statuses=(separate?profile.ids.filter(id=>id!=='D7-04'):profile.ids).map(id=>checks.find(check=>check.id===id)?.status??'BLOCKED');
    if(separate)statuses.push(matching?checked.data.sponsorChecks.find(check=>check.id===sponsor)!.status:'FAIL');
    return {name:profile.name,applicable:true,status:outcome(statuses),reason:'Derived from required operator-recorded manual release checks; not independent provider attestation or goal completion.'};
  })];
}
