import {z} from 'zod';
import {keccak256,toHex} from 'viem';
import {MemoryPayloadSchema} from '../../../packages/capsule/src/format.js';
import {parseSalesCsv,salesIntentText} from '../../../packages/protocol/src/sales-brief.js';
import {createReport} from '../../../packages/protocol/src/report.js';
import {createEvidenceSalt} from '../../../packages/protocol/src/review-evidence.js';
import {CatalogResponseSchema} from '../../../packages/protocol/src/purchase-api.js';
import {address,positiveUint} from '../../../packages/protocol/src/schemas.js';
export const defaultSalesIntent='Buy a sales summary for my store’s commercial business update. Use the attached daily sales, and deliver the number of days, total revenue, lowest daily revenue and highest daily revenue. I need permission to use the report commercially.';
export const LiveReadinessSchema=z.object({context:z.object({chainId:z.literal('10143'),buyer:address,seller:address,asset:address,arbiter:address}),catalogue:CatalogResponseSchema,balance:z.string().regex(/^\d+$/).nullable(),observedBlock:z.string().nullable(),blockers:z.array(z.string()),checkedAt:z.string(),authorityRecheckedOnExecution:z.literal(true)});
export function buildLiveSalesTask(input:{intent:string;csv:string;source:'sample'|'uploaded';budget:string},context:z.infer<typeof LiveReadinessSchema>['context']){
  if(input.intent.trim().length<10||input.intent.length>2000)throw Error('Write an intent between 10 and 2,000 characters.');
  const data=parseSalesCsv(input.csv,input.source),budget=positiveUint.parse(input.budget),datasetHash=createReport(data.dataset).datasetHash;
  return MemoryPayloadSchema.parse({schemaVersion:1,kind:'memory',policy:{schemaVersion:1,taskId:keccak256(toHex(crypto.randomUUID())),datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget,allowedAsset:context.asset,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'},taskInput:{dataset:data.dataset,buyer:context.buyer,seller:context.seller},evidence:{schemaVersion:2,salt:createEvidenceSalt(),taskText:salesIntentText(input.intent,data),documents:[]}});
}
export function livePurchaseSubmission(memory:ReturnType<typeof MemoryPayloadSchema.parse>,catalogue:unknown){
  const catalog=CatalogResponseSchema.parse(catalogue);if(!catalog.entries.length)throw Error('No signed offer is available.');
  return {action:'submit',confirm:true,submission:{idempotencyKey:memory.policy.taskId,workflow:{name:'Live sales report purchase',version:'1',steps:[{id:'procurement',handler:'intentpass.procurement',effect:'WRITE',retryDelayMs:15000}]},input:{memory,catalogue:catalog},runAt:0}};
}
export const readinessMessages:Record<string,string>={
  LIVE_INTENT_REVIEW_REQUIRED:'The configured review must evaluate the full written intent. Activate the intent-aware review policy before purchasing.',
  BUYER_TEST_TOKENS_REQUIRED:'The buyer has 0 IPTEST. Fund the buyer wallet with test tokens before purchasing.',
  WORKFLOW_CONFIGURATION_REQUIRED:'This service has no connected procurement worker. Start the configured local service or finish server setup.',
  AUTH_CONFIGURATION_REQUIRED:'Sign-in and purchasing are not configured on this service.',
  WORKFLOW_BUYER_CONTEXT_UNAVAILABLE:'Sign in with the original connected buyer account. This account has no configured purchase authority.',
  SIGNED_OFFERS_EXPIRED_OR_INVALID:'The provider’s signed offers have expired or are invalid. The provider must publish fresh offers before a new purchase.',
  SIGNED_OFFERS_REQUIRED:'The provider must sign and publish its service offers before you can buy.',
  CATALOGUE_UNAVAILABLE:'The signed service catalogue is unavailable. No purchase has started.',
  CHAIN_READ_UNAVAILABLE:'Monad balances could not be checked. Recheck the connection before purchasing.',
  WALLET_CONNECTION_REQUIRED:'Finish the buyer and provider wallet connections in Wallets.',
  AUTOMATION_AUTHORITY_EXPIRED:'The connected automation authority has expired.',
  BUYER_GAS_REQUIRED:'The buyer needs more test MON for approval and acceptance fees.',SELLER_GAS_REQUIRED:'The provider needs more test MON for delivery, acceptance and withdrawal fees.',EXECUTOR_GAS_REQUIRED:'The execution wallet needs more test MON for escrow funding and settlement fees.',
  LOGIN_REQUIRED:'Sign in below, then check the service again.',AUTHENTICATION_REJECTED:'Your sign-in expired. Sign in again below.',
};
export function liveError(code:string){return readinessMessages[code]??(/^[A-Z0-9_]+$/.test(code)?`Execution paused: ${code.replaceAll('_',' ').toLowerCase()}.`:code);}
