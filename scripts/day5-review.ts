import {z} from 'zod';
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {auditBytes} from './public-audit.js';
import {readStableReleaseJson,inspectReleaseEvidence,releaseEvidencePathPattern} from './release-review.js';
import {inspectDay5OrderEvidence} from './day5-order-evidence.js';
import {Day5ReviewSchema,Day5ReviewManifestSchema,Day5PublicConfigurationSchema,day5Assertions,day5CheckIds,day5ReviewScope,day5ReviewLimits,type Day5CheckId,type Day5ReviewContext,type Day5ReviewManifest} from './day5-review-types.js';

const time=z.iso.datetime();
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function emptyCheck(id:Day5CheckId):Day5ReviewManifest['checks'][number]{
  return {id,status:'BLOCKED',assertions:Object.fromEntries(day5Assertions[id].map(key=>[key,false])),evidence:[]};
}

/** Validates operator-recorded observations and public bytes, without performing the observations. */
export function inspectDay5Review(path:string|undefined,context:Day5ReviewContext):Day5ReviewManifest{
  // There is no faithful manifest representation of an invalid runner timestamp.
  if(!time.safeParse(context.startedAt).success||!time.safeParse(context.checkedAt).success)throw new Error('DAY5_REVIEW_CONTEXT_INVALID');
  const sourceTime=time.safeParse(context.sourceCommittedAt);
  const result:Day5ReviewManifest={
    schemaVersion:1,scope:day5ReviewScope,status:'BLOCKED',sha256:null,sourceCommit:null,reviewedAt:null,context:null,
    timeWindow:{sourceCommittedAt:sourceTime.success?sourceTime.data:null,startedAt:context.startedAt,checkedAt:context.checkedAt},
    checks:day5CheckIds.map(emptyCheck),issues:[],limits:[...day5ReviewLimits],
  };
  const issue=(code:string,id?:Day5CheckId,evidenceIndex?:number)=>result.issues.push({code,...(id?{id}:{}),...(evidenceIndex!==undefined?{evidenceIndex}:{})});
  if(!path){issue('REVIEW_NOT_CONFIGURED');return Day5ReviewManifestSchema.parse(result);}
  let record:z.infer<typeof Day5ReviewSchema>,bytes:Buffer;
  try{
    bytes=readStableReleaseJson(path);
    record=Day5ReviewSchema.parse(JSON.parse(bytes.toString('utf8')));
  }catch{
    issue('REVIEW_RECORD_INVALID');result.status='FAIL';return Day5ReviewManifestSchema.parse(result);
  }
  // No public fingerprint or metadata for private record bytes containing credentials,
  // including credentials escaped in JSON but exposed after parsing.
  if(auditBytes('day5-review',bytes).length||auditBytes('day5-review',Buffer.from(JSON.stringify(record))).length){
    issue('REVIEW_RECORD_UNSAFE');result.status='FAIL';return Day5ReviewManifestSchema.parse(result);
  }
  // Only strict, privacy-checked record bytes receive a published input digest.
  result.sha256=hash(bytes);
  result.sourceCommit=record.sourceCommit;result.reviewedAt=record.reviewedAt;
  result.context=record.context;
  let bindingFailed=false,configurationMissing=false;
  if(!context.commit||record.sourceCommit!==context.commit||context.worktreeDirty!==false){issue('REVIEW_SOURCE_MISMATCH');bindingFailed=true;}
  if(!sourceTime.success||Date.parse(record.context.observationsStartedAt)<Date.parse(sourceTime.data)
    ||Date.parse(record.context.observationsEndedAt)>Date.parse(record.reviewedAt)
    ||Date.parse(record.reviewedAt)>Date.parse(context.startedAt)
    ||Date.parse(context.checkedAt)<Date.parse(context.startedAt)){
    issue('REVIEW_TIME_INVALID');bindingFailed=true;
  }
  if(context.expectedPublicConfiguration===null){issue('PUBLIC_CONFIGURATION_REQUIRED');configurationMissing=true;}
  else{
    const expected=Day5PublicConfigurationSchema.safeParse(context.expectedPublicConfiguration);
    if(!expected.success){issue('PUBLIC_CONFIGURATION_INVALID');bindingFailed=true;}
    else if(expected.data.publicUrl!==record.context.configuration.publicUrl||expected.data.rpId!==record.context.configuration.rpId){
      issue('PUBLIC_CONFIGURATION_MISMATCH');bindingFailed=true;
    }
  }
  for(const output of result.checks){
    const original=record.checks.find(check=>check.id===output.id);
    if(!original){issue('MANUAL_CHECK_MISSING',output.id);continue;}
    output.status=original.status;output.assertions={...original.assertions};
    const seen=new Set<string>();
    for(let index=0;index<original.evidence.length;index++){
      const evidence=original.evidence[index];
      try{
        const base=realpathSync(context.root),publicPath=relative(base,evidence.path);
        if(evidence.path!==resolve(base,publicPath)||!releaseEvidencePathPattern.test(publicPath)||seen.has(publicPath))throw new Error('EVIDENCE_PATH_INVALID');
        seen.add(publicPath);
        if(auditBytes('day5-review',Buffer.from(publicPath)).length>0)throw new Error('PUBLIC_EVIDENCE_UNSAFE');
        output.evidence.push(inspectReleaseEvidence(context.root,{...evidence,path:publicPath}));
      }catch(error){
        // Filesystem and parser errors may contain private paths; only fixed codes escape.
        const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EVIDENCE_INVALID';
        issue(code,output.id,index);output.status='FAIL';
      }
    }
    if(original.status==='FAIL')issue('MANUAL_CHECK_FAILED',output.id);
    if(original.status==='PASS'){
      if(!day5Assertions[output.id].every(key=>original.assertions[key]===true)||output.evidence.length===0){
        issue('MANUAL_ASSERTIONS_OR_EVIDENCE_INCOMPLETE',output.id);output.status='FAIL';
      }
      if(output.id==='D5-02'&&!record.context.secondaryContext){issue('SECONDARY_CONTEXT_REQUIRED',output.id);output.status='FAIL';}
      if(output.id==='D5-04'||output.id==='D5-05'){
        const order=record.context.originalOrder;
        if(!order){issue('ORIGINAL_ORDER_REQUIRED',output.id);output.status='FAIL';}
        else if(output.id==='D5-04'){
          if(!order.finalizedObservation){issue('FINALIZED_OBSERVATION_REQUIRED',output.id);output.status='FAIL';}
          else if(!output.evidence.some(evidence=>evidence.sha256===order.finalizedObservation!.evidenceSha256)){
            issue('FINALIZED_OBSERVATION_EVIDENCE_MISMATCH',output.id);output.status='FAIL';
          }
          else{
            try{inspectDay5OrderEvidence(context.root,order,output.evidence);}
            catch(error){
              const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'FINALIZED_OBSERVATION_INVALID';
              issue(code,output.id);output.status='FAIL';
            }
          }
        }
      }
      if(context.localPassed!==true){issue('LOCAL_DAY_FIVE_PREREQUISITES_INCOMPLETE',output.id);output.status='FAIL';}
      // Missing deployment configuration must never mask an explicit or derived failure.
      if(output.status==='PASS'&&configurationMissing)output.status='BLOCKED';
    }
    if(bindingFailed)output.status='FAIL';
  }
  result.status=bindingFailed||result.checks.some(check=>check.status==='FAIL')?'FAIL':result.checks.every(check=>check.status==='PASS')?'PASS':'BLOCKED';
  return Day5ReviewManifestSchema.parse(result);
}
