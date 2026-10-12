import {Day4OriginsProofSchema} from '../packages/protocol/src/day4-origin-types.js';
import {verifyDay4OriginArtifactBindings} from './origin-artifact-bindings.js';

export type OriginSourceBinding={path:string;bytes:number;sha256:string};
export type OriginObservation={status:'ORIGINS_VERIFIED'|'BLOCKED'|'FAIL';publicRpcInspectionAttempted:boolean;privyReadInspectionAttempted:boolean;privyReadCallsAttempted:number};
/** Consume this run's read-only report. A current provider association never
 * makes official qualification or complete D4 acceptance pass. */
export function day4OriginObservation(input:unknown,expected:{startedAt:string;endedAt:string;sourceCommit:string;exitCode:number|null;sourceBindings:OriginSourceBinding[]},
  readArtifactBytes?: (path:string)=>Buffer):OriginObservation{
  const invalid:OriginObservation={status:'FAIL',publicRpcInspectionAttempted:false,privyReadInspectionAttempted:false,privyReadCallsAttempted:0};
  try{
    const o=input as Record<string,unknown>,start=Date.parse(expected.startedAt),end=Date.parse(expected.endedAt);
    if(!o||!Number.isFinite(start)||!Number.isFinite(end)||end<start||o.schemaVersion!==1
      ||o.scope!=='READ_ONLY_ORIGINAL_CREATIONS_CHAIN_AND_LIVE_PRIVY_ASSOCIATIONS_NOT_D4_EXTERNAL_ACCEPTANCE'
      ||typeof o.startedAt!=='string'||typeof o.endedAt!=='string'||!Number.isFinite(Date.parse(o.startedAt))||!Number.isFinite(Date.parse(o.endedAt))
      ||Date.parse(o.startedAt)<start||Date.parse(o.endedAt)<Date.parse(o.startedAt)||Date.parse(o.endedAt)>end
      ||!/^[a-f0-9]{40}$/.test(expected.sourceCommit)||o.sourceCommit!==expected.sourceCommit||o.exitCode!==expected.exitCode
      ||!expected.sourceBindings.length||JSON.stringify(o.sourceBindings)!==JSON.stringify(expected.sourceBindings)
      ||typeof o.worktreeDirty!=='boolean'||o.financialAcceptanceStatus!=='BLOCKED'||o.officialIntegrationVerified!==false
      ||o.historicalPolicyAtSendVerified!==false||o.withdrawalProviderOriginVerified!==false||o.canExecute!==false
      ||o.transactionsSent!==0||o.signaturesRequested!==0||typeof o.publicRpcInspectionAttempted!=='boolean'
      ||typeof o.privyReadInspectionAttempted!=='boolean'||!Number.isSafeInteger(o.privyReadCallsAttempted)
      ||Number(o.privyReadCallsAttempted)<0||Number(o.privyReadCallsAttempted)>6
      ||o.privyReadInspectionAttempted!==(Number(o.privyReadCallsAttempted)>0))return invalid;
    const observed={publicRpcInspectionAttempted:o.publicRpcInspectionAttempted,privyReadInspectionAttempted:o.privyReadInspectionAttempted,privyReadCallsAttempted:Number(o.privyReadCallsAttempted)};
    if(o.status==='BLOCKED'&&expected.exitCode===1&&typeof o.reason==='string'&&/^(?:DAY4_(?:ORIGINS|CREATIONS|FLOW)_[A-Z_]+|PRIVY_ORIGIN_[A-Z_]+)$/.test(o.reason))return {status:'BLOCKED',...observed};
    if(o.status==='ORIGINS_VERIFIED'&&expected.exitCode===0&&observed.publicRpcInspectionAttempted&&observed.privyReadCallsAttempted===6){
      const proof=Day4OriginsProofSchema.parse(o.inspection);
      if(proof.privy.observedAtUnixMs<Date.parse(o.startedAt)||proof.privy.observedAtUnixMs>Date.parse(o.endedAt))return {status:'FAIL',...observed};
      if(!verifyDay4OriginArtifactBindings(o.artifactBindings,readArtifactBytes,{gate:proof.creations.gate.creationBytecodeHash,escrow:proof.creations.escrow.creationBytecodeHash}))return {status:'FAIL',...observed};
      return {status:'ORIGINS_VERIFIED',...observed};
    }
    return {status:'FAIL',...observed};
  }catch{return invalid;}
}
