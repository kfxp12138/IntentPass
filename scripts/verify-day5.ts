import {refreshAcceptanceIndex} from './acceptance-index.js';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,copyFileSync} from 'node:fs';
import {commandExit,completeUnitRun} from './verification-outcome.js';
import {settlementRoute} from '../packages/protocol/src/route.js';
import {loadEnvFile} from 'node:process';
import {inspectDay5Review} from './day5-review.js';
import {Day5PublicConfigurationSchema,day5ReviewScope} from './day5-review-types.js';
import {writeStageReport} from './stage-report.js';
if(existsSync('.env'))loadEnvFile('.env');
const startedAt=new Date().toISOString(),directory='artifacts/acceptance';
// Capture the source before archiving or writing this run's own evidence.
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'}),commit=commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty=commandExit(working)!==0||!!working.stdout.trim();
const committed=commit?spawnSync('git',['show','-s','--format=%cI',commit],{encoding:'utf8'}):undefined,committedTime=committed&&commandExit(committed)===0?Date.parse(committed.stdout.trim()):NaN,sourceCommittedAt=Number.isFinite(committedTime)?new Date(committedTime).toISOString():null;
mkdirSync(directory,{recursive:true});
if(existsSync(`${directory}/day5.json`)) {
  const history=`${directory}/history/${startedAt.replaceAll(':','-')}-D5`;mkdirSync(history,{recursive:true});
  copyFileSync(`${directory}/day5.json`,`${history}/day5.json`);
  if(existsSync('docs/day5-report.md'))copyFileSync('docs/day5-report.md',`${history}/day5-report.md`);
  for(const name of ['typecheck','build','test-unit'])if(existsSync(`${directory}/day5-${name}.log`))copyFileSync(`${directory}/day5-${name}.log`,`${history}/day5-${name}.log`);
}
const runs=[];
for(const name of ['typecheck','build','test:unit']) {
  const result=spawnSync('pnpm',['run',name],{encoding:'utf8',timeout:180000,maxBuffer:32000000}),evidence=`${directory}/day5-${name.replaceAll(':','-')}.log`;
  writeFileSync(evidence,(result.stdout??'')+(result.stderr??'')+(result.error?'\nLOCAL_COMMAND_ERROR':''));
  runs.push({command:`pnpm run ${name}`,exitCode:commandExit(result),evidence});console.log(`${name}: exit ${commandExit(result)}`);
}
const unit=readFileSync(`${directory}/day5-test-unit.log`,'utf8');
const localPassed=runs.every(r=>r.exitCode===0)&&completeUnitRun(unit,497)&&[
  'WebCrypto capsules round-trip export','namespace, RP, credential, object, revision, IV and ciphertext changes fail authentication',
  'actual Mera SDK pins credential','durable ciphertext store isolates owners and CAS','authorization namespace is bound to original order',
  'capsule HTTP authenticates first',
  'encrypted original authorization recovers expired history','restored context, policy, evidence, preparation and all original signatures',
  'recovery rejects divergent chain anchors','Capsule SDK limits endpoints','task memory preserves original dataset',
  'browser configuration exposes only explicit public metadata','browser session uses server-verified identity',
  'actual Privy browser SDK is wrapped','logout invalidates an in-flight verified response',
  'session API authenticates caller','restored order refresh uses current verified wallet','logout while order refresh is waiting',
  'logout during login cleans the pending SDK session',
  'authenticated HTTP SDK connects signed catalog','browser rejects changed original policy','browser rejects inconsistent PASS',
  'task change or candidate reset','explicit quote file validates finite catalog','review policy loader rejects blocked or tampered results',
  'purchase configuration wires real ports','purchase SDK validates response',
  'authorization preparation and owner finalization','authorization preparation rejects semantic-only PASS',
  'owner finalization rejects changed grant','browser permission preparation preserves original candidate',
  'purchase preflight binds exact funding','purchase preflight reports registration','purchase preflight rejects substituted permission',
  'authenticated preflight HTTP and SDK','preflight SDK matches response anchors',
  'authorization UI duration is integer bounded','authorization preview preserves uint256 amounts',
  'Privy owner adapter sends only the canonical Grant','Privy Grant adapter rejects changed deployment',
  'one SDK instance cannot open concurrent signing frames','Privy wallet frame checks exact origin',
  'browser signing rechecks verified account','purchase owner signing refreshes preflight','purchase signing blocks before wallet',
  'signed authorization backup seals both namespaces', 'original authorization backup keeps one immutable ciphertext',
  'lost backup upload response remains UNKNOWN', 'backup session or view change prevents disclosure',
  'Capsule upload SDK rejects altered ciphertext echo',
  'exact asset approval verifies original signatures', 'Privy asset approval sends one canonical fixed-asset transaction',
  'Privy asset approval stops before send', 'Grant signing and exact asset approval share one SDK operation lock',
  'approval reconciliation requires canonical transaction', 'approval reconciliation leaves pending',
  'durable approval reservations survive restart', 'authenticated approval HTTP reserves once',
  'approval reconciliation HTTP leaves missing receipts', 'approval SDK validates record and receipt anchors',
  'approval flow reserves before wallet', 'approval flow keeps uncertain reservation locked',
  'browser asset approval checks verified subject',
  'funding worker verifies original permission', 'funding worker never resends unknown broadcast',
  'funding worker rejects changed original signatures', 'funding worker waits for receipts',
  'funding send leases survive store restart', 'canonical funding port requires original executor transaction',
  'authenticated funding HTTP requires owner', 'funding HTTP and SDK concurrent original-order submits',
  'funding browser flow keeps lost committed HTTP response', 'funding browser flow query has no payment side effect',
  'funding SDK validates complete original calldata', 'funding configuration requires durable path',
  'fulfillment delivery recomputes original report','fulfillment delivery rejects changed chain anchors',
  'fulfillment acceptance fixes original evidence','fulfillment acceptance forbids mixed evidence',
  'fulfillment authenticated HTTP and SDK','fulfillment SDK rejects substituted execution targets',
  'Privy fulfillment seller sends exactly one canonical original delivery',
  'Privy fulfillment committee signs only fixed original acceptance',
  'Privy fulfillment rejects missing consent',
  'Privy fulfillment uncertain sends or signatures never retry',
  'delivery durable original-order slot survives restart', 'delivery receipt requires exact seller calldata',
  'delivery reconciliation preserves pending', 'delivery authenticated HTTP and SDK reserve once',
  'delivery SDK rejects changed public anchors', 'delivery configuration requires explicit durable path',
  'delivery flow reserves before the seller wallet', 'delivery flow lost committed reservations',
  'browser delivery wrapper checks verified seller', 'delivery flow changed subject or malformed reservation',
  'delivery flow rejects stale proof and terminal regression',
  'acceptance durable fixed-member reservation survives restart',
  'acceptance signature verification binds exact original member',
  'acceptance authenticated HTTP and SDK reserve once',
  'acceptance lost reservation replies never reopen',
  'acceptance SDK rejects replaced signer', 'acceptance configuration requires durable absolute path',
  'acceptance flow requires first durable reservation', 'acceptance flow unknown reserve or signing outcome',
  'acceptance flow lost signature publication', 'browser acceptance wrapper rechecks fixed member',
  'acceptance controller rejects changed record digests',
  'vote preparation verifies the exact member signature', 'vote SDK validation rejects changed signature commitments',
  'vote receipt proves one original Accepted event', 'vote reader rejects wrong member or altered calldata',
  'vote journal persists one global member send slot', 'vote HTTP and SDK require original recorded signature',
  'vote lost reserve response never grants another send slot', 'vote SDK rejects replaced signature and calldata commitments',
  'Privy vote sends one exact original accept transaction', 'Privy vote rejects missing consent and invalid signatures',
  'Privy vote unknown send never retries', 'vote flow obtains the first durable slot',
  'vote flow lost reservations and unknown wallet sends', 'vote session changes during preparation or logout',
  'vote controller rejects replaced commitments and terminal regression', 'acceptance handoff reuses the recorded original signature',
  'role handoff verifies the full original buyer or seller', 'member import recompiles the fixed evidence',
  'retaining a saved member signature requires an existing exact slot', 'member controls require separate sign export and vote consent',
  'member controls reject tampered reports and discard import after logout',
  'withdrawal preparation binds original beneficiary credit', 'withdrawal rejects wrong beneficiaries and altered original signatures',
  'withdrawal confirmation requires exact original Withdrawn and token Transfer', 'withdrawal pending or reverted receipts never claim transfer',
  'withdrawal proof validators reject substituted amounts roles and final state',
  'withdrawal journal persists one live attempt', 'withdrawal HTTP requires authentication original beneficiary',
  'withdrawal lost reserve replies and concurrent calls', 'withdrawal retry requires canonical reverted original hash',
  'withdrawal pending receipts never release a send slot', 'withdrawal SDK rejects changed original authority',
  'withdrawal controls require independent consent', 'withdrawal controls preserve finalized failure',
  'withdrawal controls show identity blocking', 'withdrawal controls lock lost reservation outcomes',
  'withdrawal controls reject stale finalized refreshes', 'withdrawal controls let the authenticated original payee',
  'withdrawal controls claim the entire original timeout refund',
  'allocation preparation selects only the original settlement', 'allocation gates mirror both positive original credits',
  'allocation proof requires one exact original Allocated event', 'allocation timeout proofs preserve the original full refund',
  'allocation reader rejects unrelated transactions missing events', 'allocation pending and reverted receipts never claim new credits',
  'allocation role and historical signature checks precede chain access',
  'allocation readonly worker observes an eligible original order',
  'allocation original port rechecks finalized eligibility before send',
  'allocation original worker confirms only the complete original event',
  'allocation authenticated API requires explicit confirmation',
  'allocation authenticated reconciliation binds a lost original hash',
  'allocation SDK validates full original records and exact receipts',
  'allocation flow binds explicit original action queries first',
  'allocation flow preserves lost trigger locks',
  'allocation flow stops changed deadline stale snapshots',
  'allocation controls display original settle timeout refund',
  'allocation controls reset confirmation on refresh',
  'allocation controls keep lost outcomes locked',
  'restored pair decrypts both original namespaces in either order',
  'restored pair rejects different Passkeys policies datasets roles',
  'restored context refuses replacement stale terminal regressions',
  'restored unregistered authorization remains readonly',
  'restored context preserves an already signed original',
  'restored order controls require current original buyer',
  'restored original authorization seeds allocation and withdrawal controls',
  'independent example CLI actually proposes reviews prepares',
  'independent example SDK preparation and finalization recheck',
  'independent example refuses missing consent arbitrary calls',
  'independent example summaries omit private evidence',
  'independent example never retries a lost original submission',
  'independent example health preserves unready state',
  'independent example SDK binds proposed policy evidence',
  'absent and partial D5 records remain BLOCKED',
  'a complete synthetic record binds current bytes in manual D5 scope',
  'source mismatch dirty worktree and missing commit time fail',
  'missing expected HTTPS and RP configuration blocks PASS',
  'a genuinely separate browser profile is an allowed D5 context',
  'D5-04 inspects snapshot contents and rejects a different order chain context block or state',
  'D5-04 requires one bounded public snapshot JSON',
  'credentials pasted into otherwise valid public aliases URLs or paths fail',
  'D5 index independently checks operator context and original bytes',
  'D5 index rejects forged manual PASS source times configuration assertions namespace order and evidence',
  'index rejects JSON-escaped public credentials before pinning any report bytes',
  'index rejects duplicate members hiding escaped credentials before public snapshots',
  'strict JSON rejects duplicate decoded member names',
  'D5 private duplicate members cannot hide escaped credentials',
].every(name=>unit.includes(`# Subtest: ${name}`));
let publicConfiguration:ReturnType<typeof Day5PublicConfigurationSchema.parse>|null=null;
try{
  if(process.env.PUBLIC_HTTPS_URL&&process.env.MERA_RP_ID)publicConfiguration=Day5PublicConfigurationSchema.parse({publicUrl:new URL(process.env.PUBLIC_HTTPS_URL).href,rpId:process.env.MERA_RP_ID});
}catch{/* Invalid or absent public declarations cannot prove a real secure context. */}
const day5Review=inspectDay5Review(process.env.D5_REVIEW_PATH,{root:process.cwd(),commit,sourceCommittedAt,startedAt,checkedAt:new Date().toISOString(),worktreeDirty,localPassed,expectedPublicConfiguration:publicConfiguration});
const items=day5Review.checks.map(check=>({id:check.id,status:check.status,scope:day5ReviewScope,reason:check.status==='PASS'?'Operator assertions, original context and current public evidence bytes validated; no independent provider or human attestation.':check.status==='FAIL'?'Manual check or required record/source/time/context/evidence/local prerequisite failed; see day5Review issues.':'Actual operator record or required configuration/context/evidence is missing; local tests do not establish real browser acceptance.'}));
const status=!localPassed||day5Review.status==='FAIL'?'FAIL':day5Review.status;
const report={stage:'D5',route:settlementRoute,commit,sourceCommittedAt,worktreeDirty,status,scope:day5ReviewScope,environment:{node:process.version},startedAt,endedAt:new Date().toISOString(),localChecks:localPassed?'PASS':'FAIL',deterministicChecks:localPassed?'PASS':'FAIL',runs,items,applicationTests:Number(unit.match(/^# pass (\d+)$/m)?.[1]??0),publicConfiguration,day5Review,passkeyCeremoniesPerformedByVerifier:0,physicalDeviceChecksPerformedByVerifier:0,providerCallsAdded:0,walletActionsAdded:0};
writeFileSync(`${directory}/day5.json`,JSON.stringify(report,null,2)+'\n');
writeStageReport({...report,acceptance:items,manualReview:day5Review});
refreshAcceptanceIndex();
console.log(JSON.stringify({stage:'D5',status,localChecks:report.localChecks,scope:report.scope,items,issues:day5Review.issues}));process.exitCode=status==='PASS'?0:1;
