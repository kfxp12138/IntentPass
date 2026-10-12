import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createPublicClient,http,parseAbi,getAddress} from 'viem';
import {DemoQuotePlanSchema} from '../packages/protocol/src/demo-quotes.js';
import {CatalogResponseSchema} from '../packages/protocol/src/purchase-api.js';
import {termsHash,verifyQuoteSignature} from '../packages/protocol/src/typed-data.js';
import {isDeepStrictEqual} from 'node:util';
import {privateServiceDirectory,readPrivateServiceJson,writePrivateServiceJsonOnce} from './create-privy-service-wallets.js';
import {DemoTaskQuoteScopeSchema,prepareTaskQuoteBook,inspectQuoteBookSwitch} from './demo-task-quotes.js';

const taskScoped=process.argv.length===4&&process.argv[2]==='--for-task';
if(process.argv.length!==2&&!taskScoped)throw Error('DEMO_QUOTE_ARGUMENT_INVALID');
if(process.env.SETTLEMENT_ASSET_MODE!=='demo-erc20'||process.env.CHAIN_ID!=='10143')throw Error('DEMO_QUOTE_TESTNET_REQUIRED');
const proof=JSON.parse(readFileSync('artifacts/acceptance/escrow-deployment/original-create-proof.json','utf8'));
if(proof.status!=='CONFIRMED'||proof.contractAddress.toLowerCase()!==process.env.ARBITER_ADDRESS?.toLowerCase())throw Error('DEMO_QUOTE_CONFIRMED_DEPLOYMENT_REQUIRED');
const committee=process.env.COMMITTEE_ADDRESSES!.split(',');if(committee.length!==3)throw Error('DEMO_QUOTE_COMMITTEE_REQUIRED');
const seller=getAddress(committee[1]),asset=getAddress(process.env.ASSET_ADDRESS!),arbiter=getAddress(process.env.ARBITER_ADDRESS!);
const client=createPublicClient({transport:http(process.env.MONAD_RPC_URL!,{retryCount:0,timeout:20000,fetchOptions:{redirect:'error'}})});
if(await client.getChainId()!==10143)throw Error('DEMO_QUOTE_CHAIN_MISMATCH');
const abi=parseAbi(['function symbol() view returns(string)','function decimals() view returns(uint8)']);const [symbol,decimals]=await Promise.all([client.readContract({address:asset,abi,functionName:'symbol'}),client.readContract({address:asset,abi,functionName:'decimals'})]);
if(symbol!=='IPTEST'||decimals!==6)throw Error('DEMO_QUOTE_ASSET_METADATA_MISMATCH');
const scope=taskScoped?DemoTaskQuoteScopeSchema.parse(readPrivateServiceJson(resolve(process.argv[3]))):undefined;
if(scope&&scope.buyer.toLowerCase()!==committee[0].toLowerCase())throw Error('DEMO_QUOTE_BUYER_MISMATCH');
const intendedDirectory=scope?resolve('.tools/demo-task-quotes',scope.taskId.slice(2).toLowerCase()):resolve('.tools/demo-quotes');
if(taskScoped)await inspectQuoteBookSwitch(process.env,intendedDirectory);
const scoped=scope?prepareTaskQuoteBook({root:process.cwd(),scope,seller,asset,arbiter}):undefined;
const directory=scoped?.directory??resolve('.tools/demo-quotes');privateServiceDirectory(directory);const planPath=resolve(directory,'plan.json'),catalogue=resolve(directory,'catalogue.json');
if(!existsSync(planPath)){
  const expiresAt=String(BigInt(Math.floor(Date.now()/1000))+86400n);
  const build=(license:string)=>{const quoteId=`0x${randomBytes(32).toString('hex')}`,serviceTerms=`IntentPass test service under quote ${quoteId}, offered by seller ${seller}. The service generates a count, sum, min and max report for the buyer's fixed dataset. ${license}`;return {schemaVersion:1 as const,quoteId,service:'dataset-report' as const,seller,payee:seller,asset,amount:'10',serviceTerms,serviceTermsHash:termsHash(serviceTerms),expiresAt};};
  const plan=DemoQuotePlanSchema.parse({schemaVersion:1,planId:randomUUID(),chainId:'10143',arbiter,asset,seller,assetSymbol:'IPTEST',assetDecimals:6,quotes:[{label:'完整报告许可',quote:build('The license for this exact generated report explicitly permits commercial use and commercial redistribution of the report.')},{label:'仅代码许可',quote:build('The analysis software source code is described as MIT-licensed. No license or permission for commercial use of the generated report is stated.')}]});
  writePrivateServiceJsonOnce(planPath,plan);
}
const plan=DemoQuotePlanSchema.parse(readPrivateServiceJson(planPath));if(plan.seller!==seller||plan.asset!==asset||plan.arbiter!==arbiter)throw Error('DEMO_QUOTE_EXISTING_PLAN_MISMATCH');
if(!existsSync(catalogue))writePrivateServiceJsonOnce(catalogue,{entries:[]});
const currentCatalogue=CatalogResponseSchema.parse(readPrivateServiceJson(catalogue));
if(currentCatalogue.entries.length!==0&&currentCatalogue.entries.length!==2)throw Error('DEMO_QUOTE_EXISTING_CATALOGUE_MISMATCH');
for(const entry of currentCatalogue.entries){const original=plan.quotes.find(e=>e.quote.quoteId.toLowerCase()===entry.quote.quoteId.toLowerCase()),{signature,...unsigned}=entry.quote;if(!original||!isDeepStrictEqual(original.quote,unsigned)||!await verifyQuoteSignature(entry.quote,{chainId:plan.chainId,arbiter:plan.arbiter}))throw Error('DEMO_QUOTE_EXISTING_SIGNATURE_INVALID');}
if(taskScoped&&plan.quotes.some(e=>BigInt(e.quote.expiresAt)<=BigInt(Math.floor(Date.now()/1000))))throw Error('DEMO_QUOTE_TASK_QUOTES_EXPIRED');
const original=readFileSync('.env','utf8');let next=original;
for(const [name,value] of Object.entries({DEMO_QUOTE_DIRECTORY:directory,QUOTE_CATALOG_PATH:catalogue})){const re=new RegExp('^'+name+'=(.*)$','gm'),matches=[...next.matchAll(re)];if(matches.length>1||matches.length&&matches[0][1].trim()&&matches[0][1].trim()!==value&&(!taskScoped||matches[0][1].trim()!==process.env[name]))throw Error('DEMO_QUOTE_ENV_MISMATCH');next=matches.length?next.replace(re,()=>name+'='+value):next.replace(/\s*$/,'\n')+name+'='+value+'\n';}
if(readFileSync('.env','utf8')!==original)throw Error('DEMO_QUOTE_ENV_CHANGED');const tmp='.tools/quote-config-'+randomUUID();writeFileSync(tmp,next,{mode:0o600,flag:'wx'});renameSync(tmp,'.env');
const expired=plan.quotes.some(e=>BigInt(e.quote.expiresAt)<=BigInt(Math.floor(Date.now()/1000)));
console.log(JSON.stringify({status:expired?'DEMO_QUOTES_EXPIRED':currentCatalogue.entries.length===2?'SIGNED_DEMO_QUOTES_ALREADY_PRESENT':'UNSIGNED_DEMO_QUOTES_PREPARED',seller,quotes:2,amountMinimalUnits:'10',amountIPTEST:'0.000010',signaturesRequested:0,transactionsSent:0,catalogueEntries:currentCatalogue.entries.length,taskScoped,...(scope?{taskId:scope.taskId,datasetHash:scope.datasetHash}:{})}));if(expired)process.exitCode=1;
