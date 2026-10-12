import {Day4AssetFailureProofSchema,type Day4AssetFailureObservation} from '../packages/protocol/src/day4-asset-failure-types.js';
import {sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {verifyDay4OriginArtifactBindings} from './origin-artifact-bindings.js';

export type AssetFailureObservation={status:'COMPLETE'|'BLOCKED'|'FAIL';publicRpcInspectionAttempted:boolean;traceCallsAttempted:number;
  observations:{id:Day4AssetFailureObservation['id'];status:Day4AssetFailureObservation['status']}[]};
/** Consume only this invocation's bounded public diagnostic. Verified original
 * failure paths do not establish official asset provenance or external D4 PASS. */
export function day4AssetFailureObservation(input:unknown,expected:{startedAt:string;endedAt:string;source:ReleaseSourceSnapshot;exitCode:number|null},
  readArtifactBytes?:(path:string)=>Buffer):AssetFailureObservation{
  const invalid:AssetFailureObservation={status:'FAIL',publicRpcInspectionAttempted:false,traceCallsAttempted:0,observations:[]};
  let observed:{publicRpcInspectionAttempted:boolean;traceCallsAttempted:number}|undefined;
  try{
    const o=input as Record<string,unknown>,start=Date.parse(expected.startedAt),end=Date.parse(expected.endedAt);
    const sources=o?.sourceObservation as {before?:unknown;after?:unknown}|undefined;
    if(!o||!Number.isFinite(start)||!Number.isFinite(end)||end<start||o.schemaVersion!==1
      ||o.scope!=='LIVE_FIXED_PUBLIC_MONAD_ASSET_FAILURES_NOT_D4_EXTERNAL_ACCEPTANCE'
      ||typeof o.startedAt!=='string'||typeof o.endedAt!=='string'||!Number.isFinite(Date.parse(o.startedAt))||!Number.isFinite(Date.parse(o.endedAt))
      ||Date.parse(o.startedAt)<start||Date.parse(o.endedAt)<Date.parse(o.startedAt)||Date.parse(o.endedAt)>end
      ||o.sourceCommit!==expected.source.sourceCommit||o.sourceStable!==true||!sameReleaseSource(sources?.before,expected.source)
      ||!sameReleaseSource(sources?.before,sources?.after)||o.exitCode!==expected.exitCode||typeof o.worktreeDirty!=='boolean'
      ||o.financialAcceptanceStatus!=='BLOCKED'||o.officialIntegrationVerified!==false||o.canPassD4!==false||o.canExecute!==false
      ||o.transactionsSent!==0||o.signaturesRequested!==0||typeof o.publicRpcInspectionAttempted!=='boolean'
      ||!Number.isSafeInteger(o.traceCallsAttempted)||Number(o.traceCallsAttempted)<0||Number(o.traceCallsAttempted)>3
      ||!o.publicRpcInspectionAttempted&&o.traceCallsAttempted!==0)return invalid;
    observed={publicRpcInspectionAttempted:o.publicRpcInspectionAttempted,traceCallsAttempted:Number(o.traceCallsAttempted)};
    if(o.status==='BLOCKED'&&expected.exitCode===1&&o.reason==='DAY4_ASSET_FAILURE_CONFIGURATION_MISSING'
      &&!observed.publicRpcInspectionAttempted&&observed.traceCallsAttempted===0&&Array.isArray(o.artifactBindings)&&o.artifactBindings.length===0
      &&o.inspection===undefined)return {status:'BLOCKED',...observed,observations:[]};
    if((o.status==='BLOCKED'||o.status==='COMPLETE')&&o.reason==='DAY4_ASSET_FAILURE_FIXED_OBSERVATIONS'){
      const proof=Day4AssetFailureProofSchema.parse(o.inspection);
      if(o.status!==proof.status||expected.exitCode!==(proof.status==='COMPLETE'?0:1)||!observed.publicRpcInspectionAttempted
        ||observed.traceCallsAttempted!==proof.observations.length
        ||proof.creations.some(creation=>!verifyDay4OriginArtifactBindings(o.artifactBindings,readArtifactBytes,
          {gate:creation.gate.creationBytecodeHash,escrow:creation.escrow.creationBytecodeHash})))return {...invalid,...observed};
      return {status:proof.status,...observed,observations:proof.observations.map(({id,status})=>({id,status}))};
    }
    if(o.status==='BLOCKED'&&expected.exitCode===1&&typeof o.reason==='string'
      &&/^(?:DAY4_(?:ASSET_FAILURE|CREATIONS)_(?:CREATIONS_)?(?:READ_UNAVAILABLE|PENDING|CODE_MISSING|BLOCK_UNAVAILABLE|BLOCK_NOT_FINALIZED)|DEPLOYMENT_BUILD_UNAVAILABLE)$/.test(o.reason)
      &&o.inspection===undefined){
      if(!Array.isArray(o.artifactBindings)||o.reason==='DEPLOYMENT_BUILD_UNAVAILABLE'&&observed.publicRpcInspectionAttempted
        ||(observed.publicRpcInspectionAttempted?!verifyDay4OriginArtifactBindings(o.artifactBindings,readArtifactBytes)
          :o.artifactBindings.length!==0||observed.traceCallsAttempted!==0))return {...invalid,...observed};
      return {status:'BLOCKED',...observed,observations:[]};
    }
    return {...invalid,...observed};
  }catch{return observed?{...invalid,...observed}:invalid;}
}
