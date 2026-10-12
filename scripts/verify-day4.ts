import {refreshAcceptanceIndex} from './acceptance-index.js';
import {writeStageReport,archiveStageReport} from './stage-report.js';
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {commandExit} from './verification-outcome.js';
import {day4LocalEvidence} from './day4-evidence.js';
import {integrationStatus} from '../packages/adapters/src/status.js';
import {Day4ChainFlowProofSchema} from '../packages/protocol/src/day4-chain-flow-types.js';
import {day4OriginSourceBindings} from './day4-origin-source.js';
import {day4OriginObservation} from './day4-origin-observation.js';
import {day4SubmitRejectionObservation} from './day4-submit-rejection-observation.js';
import {day4PolicyProbeObservation} from './day4-policy-probe-observation.js';
import {day4AssetFailureObservation} from './day4-asset-failure-observation.js';
import {captureReleaseSource,sameReleaseSource} from './release-source.js';
const startedAt=new Date().toISOString(),base='artifacts/acceptance',commands=['typecheck','build','test:unit','test:contract:monad','abi:check','demo:monad-local'];
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const originSourcesBefore=day4OriginSourceBindings();
const rejectionSourceBefore=captureReleaseSource();
mkdirSync(base,{recursive:true});
archiveStageReport('D4',startedAt);
const archiveNames=['day4.json',...commands.map(c=>`day4-${c.replaceAll(':','-')}.log`),'local-monad-demo.json','local-deployment-proof.json','day4-chain-flow.json','day4-chain-flow-inspection.log','day4-origins.json','day4-origins-inspection.log','day4-submit-rejections.json','day4-submit-rejections-inspection.log','day4-policy-probe.json','day4-policy-probe-inspection.log','day4-asset-failures.json','day4-asset-failures-inspection.log'];
if(archiveNames.some(name=>existsSync(`${base}/${name}`))){const history=`${base}/history/${startedAt.replaceAll(':','-')}-D4`;mkdirSync(history,{recursive:true});for(const name of archiveNames)if(existsSync(`${base}/${name}`))copyFileSync(`${base}/${name}`,`${history}/${name}`);}
const runs=commands.map(name=>{const start=new Date().toISOString(),r=spawnSync('pnpm',['run',name],{encoding:'utf8',timeout:240000,maxBuffer:32000000}),evidence=`${base}/day4-${name.replaceAll(':','-')}.log`;writeFileSync(evidence,(r.stdout??'')+(r.stderr??'')+(r.error?'\nLOCAL_COMMAND_ERROR':''));const result={command:'pnpm run '+name,startedAt:start,endedAt:new Date().toISOString(),exitCode:commandExit(r),evidence};console.log(`${name}: exit ${result.exitCode}`);return result;});
function read(name:string):unknown{try{return JSON.parse(readFileSync(`${base}/${name}`,'utf8'));}catch{return null;}}
// The optional public reader runs independently of the six local prerequisites.
// No absent/failed inspection is replaced by a fixture or a stale earlier report.
const inspectionStartedAt=new Date().toISOString(),inspectionRun=spawnSync('pnpm',['run','day4:inspect-flow'],{encoding:'utf8',timeout:240000,maxBuffer:32000000});
const inspectionEndedAt=new Date().toISOString(),inspectionLog=`${base}/day4-chain-flow-inspection.log`;
writeFileSync(inspectionLog,(inspectionRun.stdout??'')+(inspectionRun.stderr??'')+(inspectionRun.error?'\nREAD_ONLY_INSPECTION_COMMAND_ERROR':''));
let inspectionStatus:'CHAIN_FLOW_VERIFIED'|'BLOCKED'|'FAIL'='FAIL',publicRpcInspectionAttempted=false;
try{
  const observation=read('day4-chain-flow.json') as Record<string,unknown>;
  if(!observation||observation.schemaVersion!==1||observation.scope!=='READ_ONLY_ORIGINAL_CHAIN_FLOW_NOT_D4_EXTERNAL_ACCEPTANCE'
    ||typeof observation.startedAt!=='string'||typeof observation.endedAt!=='string'||!Number.isFinite(Date.parse(observation.startedAt))||!Number.isFinite(Date.parse(observation.endedAt))
    ||Date.parse(observation.startedAt)<Date.parse(inspectionStartedAt)||Date.parse(observation.endedAt)<Date.parse(observation.startedAt)
    ||Date.parse(observation.endedAt)>Date.parse(inspectionEndedAt)||observation.sourceCommit!==revision.stdout.trim()
    ||observation.exitCode!==commandExit(inspectionRun)||observation.financialAcceptanceStatus!=='BLOCKED'||observation.transactionsSent!==0
    ||observation.signaturesRequested!==0||observation.canExecute!==false||observation.officialIntegrationVerified!==false
    ||observation.privyOriginVerified!==false||observation.deploymentCreationVerified!==false)throw Error();
  publicRpcInspectionAttempted=observation.publicRpcInspectionAttempted===true;
  if(observation.status==='CHAIN_FLOW_VERIFIED'&&commandExit(inspectionRun)===0&&publicRpcInspectionAttempted){Day4ChainFlowProofSchema.parse(observation.inspection);inspectionStatus='CHAIN_FLOW_VERIFIED';}
  else if(observation.status==='BLOCKED'&&commandExit(inspectionRun)!==0)inspectionStatus='BLOCKED';
}catch{/* Keep FAIL; no raw private input or node errors enter stage evidence. */}
const originsStartedAt=new Date().toISOString(),originsRun=spawnSync('pnpm',['run','day4:inspect-origins'],{encoding:'utf8',timeout:240000,maxBuffer:32000000});
const originsEndedAt=new Date().toISOString(),originsLog=`${base}/day4-origins-inspection.log`;
writeFileSync(originsLog,(originsRun.stdout??'')+(originsRun.stderr??'')+(originsRun.error?'\nREAD_ONLY_ORIGINS_COMMAND_ERROR':''));
const origins=day4OriginObservation(read('day4-origins.json'),{startedAt:originsStartedAt,endedAt:originsEndedAt,
  sourceCommit:revision.stdout.trim(),exitCode:commandExit(originsRun),sourceBindings:originSourcesBefore});
if(JSON.stringify(originSourcesBefore)!==JSON.stringify(day4OriginSourceBindings()))origins.status='FAIL';
const rejectionsStartedAt=new Date().toISOString(),rejectionsRun=spawnSync('pnpm',['run','day4:inspect-submit-rejections'],{encoding:'utf8',timeout:240000,maxBuffer:32000000});
const rejectionsEndedAt=new Date().toISOString(),rejectionsLog=`${base}/day4-submit-rejections-inspection.log`;
writeFileSync(rejectionsLog,(rejectionsRun.stdout??'')+(rejectionsRun.stderr??'')+(rejectionsRun.error?'\nREAD_ONLY_SUBMIT_REJECTIONS_COMMAND_ERROR':''));
const rejections=day4SubmitRejectionObservation(read('day4-submit-rejections.json'),{startedAt:rejectionsStartedAt,endedAt:rejectionsEndedAt,
  source:rejectionSourceBefore,exitCode:commandExit(rejectionsRun)});
if(!sameReleaseSource(rejectionSourceBefore,captureReleaseSource()))rejections.status='FAIL';
const policyStartedAt=new Date().toISOString(),policyRun=spawnSync('pnpm',['run','day4:inspect-policy-probe'],{encoding:'utf8',timeout:240000,maxBuffer:32000000});
const policyEndedAt=new Date().toISOString(),policyLog=`${base}/day4-policy-probe-inspection.log`;
writeFileSync(policyLog,(policyRun.stdout??'')+(policyRun.stderr??'')+(policyRun.error?'\nREAD_ONLY_POLICY_PROBE_COMMAND_ERROR':''));
const policyProbe=day4PolicyProbeObservation(read('day4-policy-probe.json'),{startedAt:policyStartedAt,endedAt:policyEndedAt,
  source:rejectionSourceBefore,exitCode:commandExit(policyRun)});
if(!sameReleaseSource(rejectionSourceBefore,captureReleaseSource()))policyProbe.status='FAIL';
const assetFailuresStartedAt=new Date().toISOString(),assetFailuresRun=spawnSync('pnpm',['run','day4:inspect-asset-failures'],{encoding:'utf8',timeout:240000,maxBuffer:32000000});
const assetFailuresEndedAt=new Date().toISOString(),assetFailuresLog=`${base}/day4-asset-failures-inspection.log`;
writeFileSync(assetFailuresLog,(assetFailuresRun.stdout??'')+(assetFailuresRun.stderr??'')+(assetFailuresRun.error?'\nREAD_ONLY_ASSET_FAILURES_COMMAND_ERROR':''));
const assetFailures=day4AssetFailureObservation(read('day4-asset-failures.json'),{startedAt:assetFailuresStartedAt,endedAt:assetFailuresEndedAt,
  source:rejectionSourceBefore,exitCode:commandExit(assetFailuresRun)});
if(!sameReleaseSource(rejectionSourceBefore,captureReleaseSource()))assetFailures.status='FAIL';
const endedAt=new Date().toISOString(),localPassed=day4LocalEvidence({startedAt,endedAt,exits:runs.map(r=>r.exitCode),unit:readFileSync(`${base}/day4-test-unit.log`,'utf8'),contracts:read('monad-contract.json'),demo:read('local-monad-demo.json'),creationProof:read('local-deployment-proof.json'),minimumTests:330});
const reasons=['No public Monad order using official CVA/CVI and actual Privy funding/settlement/withdrawal evidence.','No actual ineligible official-identity wallet and public asset-rule rejection.','Local direct-call guards exercised; official deployed-contract bypass attempt not executed.','Local SDK policy scope checked; no actual simulation-success/Privy-policy-denial pair.','Local transfer-failure and preserved-credit checks exercised; official controllable asset environment missing.','Local status semantics checked; actual authenticated browser and public transaction walkthrough missing.'];
const acceptance=reasons.map((reason,index)=>({id:`D4-0${index+1}`,status:localPassed?'BLOCKED':'FAIL',reason,localEvidence:localPassed?'PASS':'FAIL',scope:'REAL_PROVIDER_PUBLIC_MONAD_OFFICIAL_CVA_CVI_REQUIRED'}));
if(inspectionStatus==='CHAIN_FLOW_VERIFIED')acceptance[0].reason='Configured original chain effects verified; official provenance, original creation/provider associations and remaining D4 evidence are still required.';
if(origins.status==='ORIGINS_VERIFIED')acceptance[0].reason='Configured original creations, chain effects and live Privy records verified; official qualification, historical policy and remaining D4 evidence still required.';
if(localPassed&&(inspectionStatus==='FAIL'||origins.status==='FAIL')){acceptance[0].status='FAIL';acceptance[0].reason='A current read-only original-flow or origins inspection failed; no stale or local proof accepted.';}
if(localPassed&&rejections.status==='FAIL')for(const index of [1,2]){acceptance[index].status='FAIL';acceptance[index].reason='The current fixed direct-submit call inspection failed; no stale, local or manually asserted rejection accepted.';}
if(localPassed&&rejections.status==='COMPLETE'){
  acceptance[1].reason='Fixed original ineligible submit returned the expected rejection at a canonical finalized height; official identity provenance and full D4 evidence remain required.';
  acceptance[2].reason='Fixed signature and receipt-context mutations returned exact guards after a successful control; official deployment provenance and full D4 evidence remain required.';
}
if(localPassed&&policyProbe.status==='FAIL'){acceptance[3].status='FAIL';acceptance[3].reason='The current fixed policy-probe preparation failed; no actual policy denial is inferred.';}
if(localPassed&&policyProbe.status==='READY')acceptance[3].reason='Original paid-order view simulated successfully with stable current wallet policy; actual single-attempt Privy response and documented denial classification remain required.';
if(localPassed&&assetFailures.status==='FAIL'){acceptance[4].status='FAIL';acceptance[4].reason='The current original failure inspection failed; no stale, local or manually asserted asset failure or preserved-credit proof accepted.';}
if(localPassed&&assetFailures.status==='COMPLETE')acceptance[4].reason='Three original reverted transactions matched exact configured failure paths and preserved block-end ledgers; official asset/identity provenance and full D4 evidence remain required.';
const result={startedAt,endedAt,stage:'D4',environment:{node:process.version,platform:process.platform},route:'context-vote-escrow',commit:commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty:commandExit(working)!==0||!!working.stdout.trim(),status:localPassed&&inspectionStatus!=='FAIL'&&origins.status!=='FAIL'&&rejections.status!=='FAIL'&&policyProbe.status!=='FAIL'&&assetFailures.status!=='FAIL'?'BLOCKED':'FAIL',deterministicChecks:localPassed?'PASS':'FAIL',scope:'LOCAL_NATIVE_PREREQUISITES_AND_READ_ONLY_CHAIN_DIAGNOSTICS_NOT_D4_EXTERNAL_ACCEPTANCE',runs,applicationTests:Number(readFileSync(`${base}/day4-test-unit.log`,'utf8').match(/^# pass (\d+)$/m)?.[1]??0),acceptance,integrations:integrationStatus(),readOnlyChainFlow:{status:inspectionStatus,startedAt:inspectionStartedAt,endedAt:inspectionEndedAt,exitCode:commandExit(inspectionRun),evidence:'artifacts/acceptance/day4-chain-flow.json',log:inspectionLog,canPassD4:false},readOnlyOrigins:{...origins,startedAt:originsStartedAt,endedAt:originsEndedAt,exitCode:commandExit(originsRun),evidence:'artifacts/acceptance/day4-origins.json',log:originsLog,canPassD4:false},readOnlySubmitRejections:{...rejections,startedAt:rejectionsStartedAt,endedAt:rejectionsEndedAt,exitCode:commandExit(rejectionsRun),evidence:'artifacts/acceptance/day4-submit-rejections.json',log:rejectionsLog,canPassD4:false},readOnlyPolicyProbe:{...policyProbe,startedAt:policyStartedAt,endedAt:policyEndedAt,exitCode:commandExit(policyRun),evidence:'artifacts/acceptance/day4-policy-probe.json',log:policyLog,canPassD4:false},readOnlyAssetFailures:{...assetFailures,startedAt:assetFailuresStartedAt,endedAt:assetFailuresEndedAt,exitCode:commandExit(assetFailuresRun),evidence:'artifacts/acceptance/day4-asset-failures.json',log:assetFailuresLog,canPassD4:false},localEvidence:['artifacts/acceptance/monad-contract.json','artifacts/acceptance/local-monad-demo.json','artifacts/acceptance/local-deployment-proof.json'],privyReadCallsAttempted:origins.privyReadCallsAttempted+policyProbe.privyReadCallsAttempted,jevCallsAdded:0,publicRpcInspectionAttempted:publicRpcInspectionAttempted||origins.publicRpcInspectionAttempted||rejections.publicRpcInspectionAttempted||policyProbe.publicRpcInspectionAttempted||assetFailures.publicRpcInspectionAttempted,traceCallsAttempted:assetFailures.traceCallsAttempted,publicTransactionsAdded:0,physicalDeviceChecksAdded:0};
writeFileSync(`${base}/day4.json`,JSON.stringify(result,null,2)+'\n');writeStageReport(result);refreshAcceptanceIndex();
console.log(JSON.stringify({status:result.status,deterministicChecks:result.deterministicChecks,acceptance}));process.exitCode=1;
