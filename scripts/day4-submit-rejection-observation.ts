import {Day4SubmitRejectionProofSchema,type Day4SubmitObservation} from '../packages/protocol/src/day4-submit-rejection-types.js';
import {sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {verifyDay4OriginArtifactBindings} from './origin-artifact-bindings.js';

export type SubmitRejectionObservation={status:'COMPLETE'|'BLOCKED'|'FAIL';publicRpcInspectionAttempted:boolean;submitCallsAttempted:number;
  observations:{id:Day4SubmitObservation['id'];status:Day4SubmitObservation['status']}[]};
/** Current invocation only. This diagnostic cannot promote official financial
 * acceptance, even when all four independent fixed chain observations complete. */
export function day4SubmitRejectionObservation(input:unknown,expected:{startedAt:string;endedAt:string;source:ReleaseSourceSnapshot;exitCode:number|null},
  readArtifactBytes?:(path:string)=>Buffer):SubmitRejectionObservation{
  const invalid:SubmitRejectionObservation={status:'FAIL',publicRpcInspectionAttempted:false,submitCallsAttempted:0,observations:[]};
  try{
    const o=input as Record<string,unknown>,start=Date.parse(expected.startedAt),end=Date.parse(expected.endedAt);
    const sources=o?.sourceObservation as {before?:unknown;after?:unknown}|undefined;
    if(!o||!Number.isFinite(start)||!Number.isFinite(end)||end<start||o.schemaVersion!==1
      ||o.scope!=='LIVE_FIXED_PUBLIC_MONAD_SUBMIT_CALLS_NOT_D4_EXTERNAL_ACCEPTANCE'
      ||typeof o.startedAt!=='string'||typeof o.endedAt!=='string'||!Number.isFinite(Date.parse(o.startedAt))||!Number.isFinite(Date.parse(o.endedAt))
      ||Date.parse(o.startedAt)<start||Date.parse(o.endedAt)<Date.parse(o.startedAt)||Date.parse(o.endedAt)>end
      ||o.sourceCommit!==expected.source.sourceCommit||o.sourceStable!==true||!sameReleaseSource(sources?.before,expected.source)
      ||!sameReleaseSource(sources?.before,sources?.after)||o.exitCode!==expected.exitCode||typeof o.worktreeDirty!=='boolean'
      ||o.financialAcceptanceStatus!=='BLOCKED'||o.officialIntegrationVerified!==false||o.canPassD4!==false||o.canExecute!==false
      ||o.transactionsSent!==0||o.signaturesRequested!==0||typeof o.publicRpcInspectionAttempted!=='boolean'
      ||!Number.isSafeInteger(o.submitCallsAttempted)||Number(o.submitCallsAttempted)<0||Number(o.submitCallsAttempted)>4
      ||!o.publicRpcInspectionAttempted&&o.submitCallsAttempted!==0)return invalid;
    const observed={publicRpcInspectionAttempted:o.publicRpcInspectionAttempted,submitCallsAttempted:Number(o.submitCallsAttempted)};
    if(o.status==='BLOCKED'&&expected.exitCode===1&&o.reason==='DAY4_SUBMIT_CONFIGURATION_MISSING'
      &&!observed.publicRpcInspectionAttempted&&observed.submitCallsAttempted===0&&Array.isArray(o.artifactBindings)&&o.artifactBindings.length===0
      &&o.inspection===undefined)return {status:'BLOCKED',...observed,observations:[]};
    if((o.status==='BLOCKED'||o.status==='COMPLETE'||o.status==='FAIL')&&o.reason==='DAY4_SUBMIT_FIXED_CALL_OBSERVATIONS'){
      const proof=Day4SubmitRejectionProofSchema.parse(o.inspection);
      if(o.status!==proof.status||expected.exitCode!==(proof.status==='COMPLETE'?0:1)||!observed.publicRpcInspectionAttempted
        ||observed.submitCallsAttempted!==proof.observations.filter(item=>item.call!==null).length
        ||!verifyDay4OriginArtifactBindings(o.artifactBindings,readArtifactBytes,
          {gate:proof.creations.gate.creationBytecodeHash,escrow:proof.creations.escrow.creationBytecodeHash}))return {...invalid,...observed};
      return {status:proof.status,...observed,observations:proof.observations.map(({id,status})=>({id,status}))};
    }
    if(o.status==='BLOCKED'&&expected.exitCode===1&&typeof o.reason==='string'
      &&/^(?:DAY4_(?:SUBMIT|CREATIONS)_(?:CREATIONS_)?(?:READ_UNAVAILABLE|PENDING|CODE_MISSING|BLOCK_UNAVAILABLE|BLOCK_NOT_FINALIZED)|DEPLOYMENT_BUILD_UNAVAILABLE)$/.test(o.reason)
      &&o.inspection===undefined)return {status:'BLOCKED',...observed,observations:[]};
    return {...invalid,...observed};
  }catch{return invalid;}
}
