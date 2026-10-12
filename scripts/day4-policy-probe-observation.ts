import {Day4PolicyProbeProofSchema} from '../packages/protocol/src/day4-policy-probe-types.js';
import {sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {verifyDay4OriginArtifactBindings} from './origin-artifact-bindings.js';

/** The stage runner consumes only its current prepare invocation; it never
 * launches the one-shot POST or accepts an operator file as a denial receipt. */
export function day4PolicyProbeObservation(input:unknown,expected:{startedAt:string;endedAt:string;source:ReleaseSourceSnapshot;exitCode:number|null},
  readArtifactBytes?:(path:string)=>Buffer):{status:'READY'|'BLOCKED'|'FAIL';publicRpcInspectionAttempted:boolean;simulationCallsAttempted:number;privyReadCallsAttempted:number}{
  const invalid={status:'FAIL' as const,publicRpcInspectionAttempted:false,simulationCallsAttempted:0,privyReadCallsAttempted:0};
  try{
    const o=input as Record<string,unknown>,source=o?.sourceObservation as {before?:unknown;after?:unknown}|undefined;
    const start=Date.parse(expected.startedAt),end=Date.parse(expected.endedAt);
    if(!o||!Number.isFinite(start)||!Number.isFinite(end)||end<start||o.schemaVersion!==1||o.mode!=='prepare'
      ||o.scope!=='LIVE_FIXED_ORIGINAL_ORDER_PRIVY_PROBE_NOT_D4_EXTERNAL_ACCEPTANCE'||o.exitCode!==1||expected.exitCode!==1
      ||typeof o.startedAt!=='string'||typeof o.endedAt!=='string'||!Number.isFinite(Date.parse(o.startedAt))||!Number.isFinite(Date.parse(o.endedAt))
      ||Date.parse(o.startedAt)<start||Date.parse(o.endedAt)<Date.parse(o.startedAt)||Date.parse(o.endedAt)>end
      ||o.sourceCommit!==expected.source.sourceCommit||o.sourceStable!==true||!sameReleaseSource(source?.before,expected.source)||!sameReleaseSource(source?.before,source?.after)
      ||o.captureAttempt!==null||o.walletRpcAttempts!==0||o.priorAttempt!==false||o.broadcastOutcome!=='NOT_ATTEMPTED'||o.transactionsSent!==0
      ||o.policyDenialVerified!==false||o.serverRequestId!==null||o.financialAcceptanceStatus!=='BLOCKED'||o.officialIntegrationVerified!==false
      ||o.historicalPolicyAtSendVerified!==false||o.canPassD4!==false||o.canExecute!==false||o.status!=='BLOCKED'
      ||typeof o.worktreeDirty!=='boolean'||typeof o.publicRpcInspectionAttempted!=='boolean'
      ||!Number.isSafeInteger(o.simulationCallsAttempted)||Number(o.simulationCallsAttempted)<0||Number(o.simulationCallsAttempted)>1
      ||!Number.isSafeInteger(o.privyReadCallsAttempted)||Number(o.privyReadCallsAttempted)<0||Number(o.privyReadCallsAttempted)>18)return invalid;
    const observed={publicRpcInspectionAttempted:o.publicRpcInspectionAttempted,simulationCallsAttempted:Number(o.simulationCallsAttempted),privyReadCallsAttempted:Number(o.privyReadCallsAttempted)};
    if(!observed.publicRpcInspectionAttempted&&(observed.simulationCallsAttempted!==0||observed.privyReadCallsAttempted!==0))return invalid;
    if(o.reason==='DAY4_POLICY_PROBE_CONFIGURATION_MISSING'&&o.inspection===undefined&&Array.isArray(o.artifactBindings)&&o.artifactBindings.length===0
      &&!observed.publicRpcInspectionAttempted)return {status:'BLOCKED',...observed};
    if(o.reason==='DAY4_POLICY_PROBE_FIXED_OBSERVATION'){
      const p=Day4PolicyProbeProofSchema.parse(o.inspection);
      if(p.status!=='READY'||p.attempt!==null||p.walletRpcAttempts!==0||!observed.publicRpcInspectionAttempted
        ||observed.simulationCallsAttempted!==1||observed.privyReadCallsAttempted!==18
        ||!verifyDay4OriginArtifactBindings(o.artifactBindings,readArtifactBytes,
          {gate:p.origins.creations.gate.creationBytecodeHash,escrow:p.origins.creations.escrow.creationBytecodeHash}))return {...invalid,...observed};
      return {status:'READY',...observed};
    }
    if(o.inspection===undefined&&typeof o.reason==='string'
      &&/^(?:DAY4_(?:POLICY_PROBE|ORIGINS|FLOW|CREATIONS)_[A-Z_]*(?:UNAVAILABLE|CODE_MISSING|PENDING|NOT_FINALIZED)|PRIVY_ORIGIN_READ_UNAVAILABLE|DEPLOYMENT_BUILD_UNAVAILABLE)$/.test(o.reason))
      return {status:'BLOCKED',...observed};
    return {...invalid,...observed};
  }catch{return invalid;}
}
