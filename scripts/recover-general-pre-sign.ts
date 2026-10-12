import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {readPrivateServiceJson,writePrivateServiceJsonOnce,privateServiceDirectory} from './create-privy-service-wallets.js';
import {WorkflowStore} from '../packages/storage/src/workflow-store.js';
import {BackgroundVault} from '../packages/storage/src/background-vault.js';
import {EncryptedWorkflowVault} from '../apps/worker/src/workflow-vault.js';
import {workflowDigest} from '../packages/automation/src/workflow.js';
import {ExecutionScopeSchema,executionScopeHash,assertBackgroundTask} from '../packages/automation/src/background-scope.js';
import {MemoryPayloadSchema} from '../packages/capsule/src/format.js';
import {FileQuoteCatalog} from '../apps/web/src/catalog-api.js';
import {mergeQuoteEvidence} from '../packages/protocol/src/evidence-version.js';
import {committeeHash} from '../packages/protocol/src/escrow.js';
import {loadActivatedReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {reviewSemanticInput} from '../apps/web/src/services/review-key.js';
import {ReviewStore} from '../packages/storage/src/review-store.js';
import {executeProcurement} from '../apps/worker/src/procurement-runtime.js';
import type {GeneralRuntimeConfiguration} from '../apps/worker/src/intentpass-workflows.js';
export function assertKnownPreSignStop(f:{jobStatus:string;result:unknown;stages:string[];authorizationCount:number;signedResponse:boolean;oldEvaluation:string;oldStatus:string;deliveryDeadline:string},now:bigint){
  const r=z.object({status:z.literal('ATTENTION'),reason:z.literal('REVIEW_STOPPED')}).strict().parse(f.result),allowed=new Set(['BACKUP_TASK','CANDIDATE','REVIEW','STOPPED_REVIEW_STOPPED']);
  if(f.jobStatus!=='FAILED'||!f.stages.includes('STOPPED_REVIEW_STOPPED')||f.stages.some(s=>!allowed.has(s))||f.authorizationCount!==0||f.signedResponse||f.oldStatus!=='COMPLETE'||f.oldEvaluation!=='PASS'||now>=BigInt(f.deliveryDeadline))throw Error('GENERAL_PRE_SIGN_RECOVERY_FORBIDDEN');return r;
}
/** One explicitly approved purchase, preserving its original task, budget,
 * owner, business deadline and all failed history. Unknown signing/payment,
 * negative old review, cancellation and expired delivery never get a new slot. */
export async function recoverGeneralPreSign(directory:string,jobId:string,env:NodeJS.ProcessEnv){
  z.uuid().parse(jobId);const store=new WorkflowStore(resolve(directory,'queue.db')),raw=new BackgroundVault(resolve(directory,'vault')),queueVault=new EncryptedWorkflowVault(raw,workflowDigest('IntentPass.GeneralWorkflow.v1'));let rootVault:BackgroundVault|undefined,journal:ReviewStore|undefined;
  try{const job=store.get(jobId);if(!job)throw Error('GENERAL_ORIGINAL_JOB_REQUIRED');const step=store.step(jobId,0);if(!step.dispatched||!step.dispatchRef)throw Error('GENERAL_ORIGINAL_RESULT_REQUIRED');const result=await queueVault.open(step.dispatchRef),memory=MemoryPayloadSchema.parse(await queueVault.open(job.inputRef)),approval=z.object({jobId:z.uuid(),taskId:z.string(),dataset:z.array(z.number()),budgetMinimalUnits:z.string(),payee:z.string(),userReply:z.literal('批准自动采购'),automaticExecutionAndNecessaryTestGasApproved:z.literal(true)}).passthrough().parse(readPrivateServiceJson(resolve(directory,'approved-original-report-procurement.json')));
    const parent=resolve(directory,'procurements',jobId),ref=z.object({scopeHash:z.string(),sellerSubject:z.string()}).strict().parse(readPrivateServiceJson(resolve(parent,'job-reference.json')));rootVault=new BackgroundVault(resolve(parent,'vault'));
    const scope=ExecutionScopeSchema.parse((rootVault.open('checkpoint',createHash('sha256').update(`${ref.scopeHash}:runtime-scope`).digest('hex'),ref.scopeHash) as {scope:unknown}).scope);if(scope.mode!=='general-job'||executionScopeHash(scope)!==ref.scopeHash)throw Error('GENERAL_ORIGINAL_SCOPE_CHANGED');
    const now=BigInt(Math.floor(Date.now()/1000));assertBackgroundTask(scope,memory,now);const runtime=readPrivateServiceJson(resolve(directory,'runtime.json')) as GeneralRuntimeConfiguration&{profileHash:string};const buyer=readPrivateServiceJson(resolve(directory,'connection-consents/buyer.json')) as {subject:string;profileHash:string;address:string};
    if(runtime.profileHash!==scope.profileHash||!isDeepStrictEqual(runtime.profile,scope.profile)||!runtime.walletDelegationApproved||!runtime.localPlaintextProcessingApproved||buyer.profileHash!==scope.profileHash||buyer.address.toLowerCase()!==scope.buyer.toLowerCase()||job.ownerHash!==workflowDigest(buyer.subject)||approval.jobId!==jobId||approval.taskId!==scope.taskId||approval.budgetMinimalUnits!==scope.maxTotalUnits||approval.payee.toLowerCase()!==scope.payee.toLowerCase()||!isDeepStrictEqual(approval.dataset,memory.taskInput!.dataset))throw Error('GENERAL_ORIGINAL_APPROVAL_CHANGED');
    const files=readdirSync(resolve(parent,'vault')),stages:string[]=[];let signedResponse=false;for(const file of files.filter(n=>/^checkpoint-[a-f0-9]{64}\.json$/.test(n))){const value=rootVault.open('checkpoint',file.slice(11,-5),ref.scopeHash) as {stage?:string;at?:string};if(value.stage==='ORIGINAL_SIGNED_GRANT_RESPONSE'||value.stage==='ORIGINAL_UNSIGNED_GRANT')signedResponse=true;if(value.at&&value.stage)stages.push(value.stage);}
    const rule=loadActivatedReviewPolicy(env.REVIEW_POLICY_PATH!,env.JEV_MODEL!),book=await new FileQuoteCatalog(env.QUOTE_CATALOG_PATH!).list();journal=new ReviewStore(env.REVIEW_JOURNAL_DB_PATH!);const matches=[];
    for(const entry of book.entries){try{const evidence={...memory.evidence,documents:mergeQuoteEvidence(entry.documents,memory.evidence.documents,entry.quote.quoteId)},intent={chainId:scope.chainId,arbiter:scope.deployment.arbiter,buyer:scope.buyer,seller:entry.quote.seller,payee:entry.quote.payee,asset:entry.quote.asset,price:entry.quote.amount,bond:'0',reviewer:scope.deployment.reviewer,committeeHash:committeeHash(scope.deployment.committee)},record=journal.get(journal.key(reviewSemanticInput({policy:memory.policy,intent,quote:entry.quote,evidence} as never,rule.model,rule.questionConfigHash)));if(record)matches.push({entry,record});}catch{/* Only an exact compatible original reviewed catalogue entry qualifies. */}}
    if(matches.length!==1)throw Error('GENERAL_ORIGINAL_REVIEW_REQUIRED');const old=matches[0].record,deliveryDeadline=String(BigInt(scope.expiresAt)-BigInt(scope.profile.settlementSeconds)+BigInt(scope.profile.deliverySeconds));
    assertKnownPreSignStop({jobStatus:job.status,result,stages,authorizationCount:files.filter(f=>f.startsWith('authorization-')).length,signedResponse,oldStatus:old.status,oldEvaluation:old.evaluation?.decision??'',deliveryDeadline},now);
    const recovery=resolve(parent,'review-namespace-recovery-v1');privateServiceDirectory(recovery);const reservation=resolve(recovery,'recovery-reserved.json');if(existsSync(reservation))throw Error('GENERAL_ORIGINAL_RECOVERY_RECONCILIATION_REQUIRED');writePrivateServiceJsonOnce(reservation,{jobId,scopeHash:ref.scopeHash,originalReviewContext:old.contextHash,reason:'KNOWN_UNFUNDED_REVIEW_NAMESPACE_COLLISION',originalDeliveryDeadline:deliveryDeadline,reservedAt:String(now)});
    const outcome=await executeProcurement(scope,memory,runtime.actors,recovery,{scopeHash:ref.scopeHash,walletDelegationApproved:true,localPlaintextProcessingApproved:true},env,stage=>console.log(JSON.stringify({jobId,stage})),()=>{}, {entries:[matches[0].entry]},jobId);
    writePrivateServiceJsonOnce(resolve(recovery,'recovery-result.json'),outcome);return {jobId,outcome,originalHistoryPreserved:true};
  }finally{journal?.close();rootVault?.dispose();store.close();raw.dispose();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{if(process.argv.length!==3)throw Error('GENERAL_RECOVERY_ARGUMENT_REQUIRED');const result=await recoverGeneralPreSign(resolve(process.env.AUTOMATION_DATA_DIRECTORY??'.tools/general-automation'),process.argv[2],process.env);console.log(JSON.stringify(result));if(result.outcome.status!=='CONFIRMED')process.exitCode=1;}catch(error){console.error(JSON.stringify({status:'ATTENTION',code:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'GENERAL_RECOVERY_UNAVAILABLE',replaySigningOrPaymentAllowed:false}));process.exitCode=1;}}
