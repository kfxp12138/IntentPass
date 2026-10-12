import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {readPrivateServiceJson,privateServiceDirectory} from './create-privy-service-wallets.js';
import {MemoryPayloadSchema} from '../packages/capsule/src/format.js';
import {GeneralConnectionPlanSchema,GeneralConnectionConsentSchema} from '../packages/protocol/src/general-connection.js';
import {GeneralAutomationProfileSchema,generalProfileHash} from '../packages/automation/src/general-profile.js';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {WorkflowStore} from '../packages/storage/src/workflow-store.js';
import {BackgroundVault} from '../packages/storage/src/background-vault.js';
import {EncryptedWorkflowVault} from '../apps/worker/src/workflow-vault.js';
import {WorkflowWorker} from '../apps/worker/src/workflow-worker.js';
import {intentpassWorkflowRegistry} from '../apps/worker/src/intentpass-workflows.js';
import {workflowDigest} from '../packages/automation/src/workflow.js';
export const ProcurementMemoryInputSchema=z.union([MemoryPayloadSchema,z.object({format:z.string().min(1).max(128),memory:MemoryPayloadSchema}).strict()]);
/** Trusted local submission. Owner comes from the verified owner's immutable
 * initial consent and current provider account, never a claimed browser token.
 * No new plaintext task file, signature or transaction is created by this CLI;
 * the already running worker processes the encrypted queue with its live guards.
 */
export async function enqueueGeneralProcurement(input:unknown,directory:string,env:NodeJS.ProcessEnv,readUser?:(subject:string)=>Promise<Awaited<ReturnType<ReturnType<ReturnType<typeof createPrivyClient>['users']>['_get']>>>){
  const parsed=ProcurementMemoryInputSchema.parse(input),memory='memory'in parsed?parsed.memory:parsed;if(!memory.taskInput)throw Error('GENERAL_TASK_INPUT_REQUIRED');
  const plan=GeneralConnectionPlanSchema.parse(readPrivateServiceJson(resolve(directory,'connection-plan.json'))),runtime=z.object({profile:GeneralAutomationProfileSchema,profileHash:z.string(),walletDelegationApproved:z.literal(true),localPlaintextProcessingApproved:z.literal(true)}).passthrough().parse(readPrivateServiceJson(resolve(directory,'runtime.json'))),profile=runtime.profile;
  if(!profile.enabled||runtime.profileHash!==generalProfileHash(profile)||plan.profileHash!==runtime.profileHash||memory.taskInput.buyer.toLowerCase()!==profile.buyer.toLowerCase()||memory.taskInput.seller.toLowerCase()!==profile.seller.toLowerCase()||memory.policy.allowedAsset.toLowerCase()!==profile.deployment.asset.toLowerCase())throw Error('GENERAL_PROCUREMENT_CONFIGURATION_CHANGED');
  const consent=GeneralConnectionConsentSchema.extend({subject:z.string().min(1).max(512),address:z.string()}).strict().parse(readPrivateServiceJson(resolve(directory,'connection-consents/buyer.json')));
  if(consent.role!=='buyer'||consent.planId!==plan.planId||consent.profileHash!==plan.profileHash||consent.address.toLowerCase()!==profile.buyer.toLowerCase())throw Error('GENERAL_PROCUREMENT_OWNER_REQUIRED');
  const user=readUser?await readUser(consent.subject):await createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!}).users()._get(consent.subject);
  if(user.id!==consent.subject||!user.linked_accounts.some(a=>a.type==='wallet'&&a.chain_type==='ethereum'&&a.address.toLowerCase()===profile.buyer.toLowerCase()))throw Error('GENERAL_PROCUREMENT_OWNER_CHANGED');
  const raw=new BackgroundVault(resolve(directory,'vault')),vault=new EncryptedWorkflowVault(raw,workflowDigest('IntentPass.GeneralWorkflow.v1')),store=new WorkflowStore(resolve(directory,'queue.db'));
  try{const worker=new WorkflowWorker(store,vault,intentpassWorkflowRegistry()),key=workflowDigest({operation:'IntentPass.ApprovedTaskProcurement.v1',profileHash:plan.profileHash,taskId:memory.policy.taskId.toLowerCase(),policyVersion:memory.policy.version});
    const job=await worker.submit({idempotencyKey:key,workflow:{name:'原报告后台采购与结算',version:'1',steps:[{id:'procurement',handler:'intentpass.procurement',effect:'WRITE',retryDelayMs:15000}]},input:memory,runAt:0},consent.subject);
    return {jobId:job.id,status:job.status,taskId:memory.policy.taskId,datasetHash:memory.policy.datasetHash,budgetUnits:memory.policy.budget,ownerVerified:true as const,queueInputEncrypted:true as const,queueWillExecuteApprovedProcurement:true as const};
  }finally{store.close();raw.dispose();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{if(process.argv.length!==3)throw Error('GENERAL_PROCUREMENT_ARGUMENT_REQUIRED');const directory=resolve(process.env.AUTOMATION_DATA_DIRECTORY??'.tools/general-automation');privateServiceDirectory(directory);const result=await enqueueGeneralProcurement(readPrivateServiceJson(resolve(process.argv[2])),directory,process.env);console.log(JSON.stringify(result));}catch(error){console.error(JSON.stringify({status:'ATTENTION',code:error instanceof Error&&/^GENERAL_[A-Z_]+$/.test(error.message)?error.message:'GENERAL_PROCUREMENT_SUBMISSION_UNAVAILABLE',retryWithNewKeyAllowed:false}));process.exitCode=1;}}
