import {existsSync,readdirSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {getAddress} from 'viem';
import {z} from 'zod';
import {address,digest} from '../packages/protocol/src/schemas.js';
import {datasetSchema,createReport} from '../packages/protocol/src/report.js';
import {DemoQuotePlanSchema,type DemoQuotePlan} from '../packages/protocol/src/demo-quotes.js';
import {termsHash} from '../packages/protocol/src/typed-data.js';
import {CatalogResponseSchema} from '../packages/protocol/src/purchase-api.js';
import {DemoQuoteBook} from '../apps/web/src/demo-quote-api.js';
import {privateServiceDirectory,readPrivateServiceJson,writePrivateServiceJsonOnce} from './create-privy-service-wallets.js';

/** Private operator input for a genuine, seller-signed dataset commitment.
 * Dataset values validate the commitment locally; only its hash enters terms. */
export const DemoTaskQuoteScopeSchema=z.object({schemaVersion:z.literal(1),taskId:digest,buyer:address,datasetHash:digest,dataset:datasetSchema}).strict().superRefine((scope,ctx)=>{
  if(BigInt(scope.buyer)===0n||BigInt(scope.taskId)===0n||createReport(scope.dataset).datasetHash.toLowerCase()!==scope.datasetHash.toLowerCase())ctx.addIssue({code:'custom',message:'ORIGINAL_TASK_DATASET_MISMATCH'});
});
export type DemoTaskQuoteScope=z.infer<typeof DemoTaskQuoteScopeSchema>;
export async function inspectQuoteBookSwitch(env:NodeJS.ProcessEnv,directory:string){
  if(!env.DEMO_QUOTE_DIRECTORY||resolve(env.DEMO_QUOTE_DIRECTORY)===directory)return;
  const previousDirectory=resolve(env.DEMO_QUOTE_DIRECTORY);
  if(env.QUOTE_CATALOG_PATH!==resolve(previousDirectory,'catalogue.json'))throw Error('DEMO_QUOTE_ORIGINAL_CATALOGUE_REQUIRED');
  const previous=new DemoQuoteBook(previousDirectory,env.QUOTE_CATALOG_PATH),status=await previous.status({subject:'local-operator-inspection',wallets:[]});
  if(status.quotes.some(q=>q.status!=='SIGNED'))throw Error('DEMO_QUOTE_ORIGINAL_SIGNING_UNRESOLVED');
}
const licenses=[
  'The license for this exact generated report explicitly permits commercial use and commercial redistribution of the report.',
  'The analysis software source code is described as MIT-licensed. No license or permission for commercial use of the generated report is stated.',
] as const;
function normalize(input:unknown):DemoTaskQuoteScope {
  const scope=DemoTaskQuoteScopeSchema.parse(input);return {...scope,taskId:scope.taskId.toLowerCase(),datasetHash:scope.datasetHash.toLowerCase(),buyer:getAddress(scope.buyer)};
}
function scopedTerms(quoteId:string,seller:string,scope:DemoTaskQuoteScope,index:number){
  return `IntentPass test service under quote ${quoteId}, offered by seller ${seller}. This exact report is for IntentPass task ${scope.taskId}, buyer ${scope.buyer}, and the exact dataset with datasetHash ${scope.datasetHash} (keccak256 of the buyer's canonical JSON dataset). The report computes exactly count, sum, min and max for that dataset. These commitments describe this current report under this quote and seller. ${licenses[index]}`;
}
function check(plan:DemoQuotePlan,scope:DemoTaskQuoteScope,config:{seller:string;asset:string;arbiter:string}){
  if(plan.seller!==getAddress(config.seller)||plan.asset!==getAddress(config.asset)||plan.arbiter!==getAddress(config.arbiter))throw Error('DEMO_QUOTE_EXISTING_PLAN_MISMATCH');
  for(let i=0;i<2;i++){const q=plan.quotes[i].quote;if(q.serviceTerms!==scopedTerms(q.quoteId,plan.seller,scope,i))throw Error('DEMO_QUOTE_EXISTING_TASK_SCOPE_MISMATCH');}
}
/** A deterministic task directory and immutable scope/plan prevent a rerun from
 * regenerating quote IDs or releasing any signature reservation. */
export function prepareTaskQuoteBook(options:{root:string;scope:unknown;seller:string;asset:string;arbiter:string;now?:bigint}){
  const scope=normalize(options.scope),root=resolve(options.root),base=resolve(root,'.tools/demo-task-quotes');privateServiceDirectory(base);
  const directory=resolve(base,scope.taskId.slice(2));privateServiceDirectory(directory);
  const scopePath=resolve(directory,'scope.json'),planPath=resolve(directory,'plan.json'),catalogue=resolve(directory,'catalogue.json');
  if(existsSync(planPath)&&!existsSync(scopePath))throw Error('DEMO_QUOTE_ORIGINAL_TASK_SCOPE_REQUIRED');
  if(!existsSync(planPath)&&(readdirSync(directory).some(name=>/\.(reserved|signed)\.json$/.test(name))||existsSync(catalogue)&&CatalogResponseSchema.parse(readPrivateServiceJson(catalogue)).entries.length))throw Error('DEMO_QUOTE_ORIGINAL_PLAN_REQUIRED');
  if(!existsSync(scopePath))writePrivateServiceJsonOnce(scopePath,scope);
  if(!isDeepStrictEqual(normalize(readPrivateServiceJson(scopePath)),scope))throw Error('DEMO_QUOTE_EXISTING_TASK_SCOPE_MISMATCH');
  if(!existsSync(planPath)){
    const now=options.now??BigInt(Math.floor(Date.now()/1000));if(now<0n)throw Error('DEMO_QUOTE_TIME_INVALID');
    const seller=getAddress(options.seller),asset=getAddress(options.asset),arbiter=getAddress(options.arbiter),expiresAt=String(now+86400n);
    const build=(index:number)=>{const quoteId=`0x${randomBytes(32).toString('hex')}`,serviceTerms=scopedTerms(quoteId,seller,scope,index);return {schemaVersion:1 as const,quoteId,service:'dataset-report' as const,seller,payee:seller,asset,amount:'10',serviceTerms,serviceTermsHash:termsHash(serviceTerms),expiresAt};};
    writePrivateServiceJsonOnce(planPath,DemoQuotePlanSchema.parse({schemaVersion:1,planId:randomUUID(),chainId:'10143',arbiter,asset,seller,assetSymbol:'IPTEST',assetDecimals:6,quotes:[{label:'完整报告许可',quote:build(0)},{label:'仅代码许可',quote:build(1)}]}));
  }
  const plan=DemoQuotePlanSchema.parse(readPrivateServiceJson(planPath));check(plan,scope,options);
  if(!existsSync(catalogue))writePrivateServiceJsonOnce(catalogue,{entries:[]});
  return {directory,catalogue,plan,scope};
}
