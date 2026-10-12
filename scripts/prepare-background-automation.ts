import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {MemoryPayloadSchema} from '../packages/capsule/src/format.js';
import {BackgroundScopeSchema,backgroundScopeHash,assertBackgroundTask} from '../packages/automation/src/background-scope.js';
import {backgroundActorPolicy} from '../packages/adapters/src/privy-background-policy.js';
import {configuredBrowserApi} from '../apps/web/src/browser-api.js';
import {FileQuoteCatalog} from '../apps/web/src/catalog-api.js';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {privateServiceDirectory,readPrivateServiceJson,writePrivateServiceJsonOnce} from './create-privy-service-wallets.js';

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--prepare')throw Error('BACKGROUND_ARGUMENT_INVALID');
    const env=process.env,d=configuredBrowserApi(env)?.configuration.recoveryDeployment;
    if(!d||env.SETTLEMENT_ASSET_MODE!=='demo-erc20'||!env.QUOTE_CATALOG_PATH)throw Error('BACKGROUND_CONFIGURATION_REQUIRED');
    const transfer=z.object({format:z.string(),memory:MemoryPayloadSchema}).strict().parse(readPrivateServiceJson(resolve('.tools/demo-procurement/policy6-task-local.json'))),m=transfer.memory;
    if(!m.taskInput)throw Error('BACKGROUND_TASK_REQUIRED');
    const entry=(await new FileQuoteCatalog(env.QUOTE_CATALOG_PATH).list()).entries.find(e=>e.quote.quoteId.toLowerCase()==='0x0bb83b84721ca36a17c8942b72c1975e5367455c7a352496297042903951074b');
    if(!entry)throw Error('BACKGROUND_QUOTE_REQUIRED');
    const now=BigInt(Math.floor(Date.now()/1000)),scope=BackgroundScopeSchema.parse({version:1,mode:'single-report-background',chainId:'10143',deployment:d,taskId:m.policy.taskId,datasetHash:m.policy.datasetHash,quoteId:entry.quote.quoteId,buyer:m.taskInput.buyer,seller:m.taskInput.seller,payee:entry.quote.payee,maxTotalUnits:'10',maxOrders:1,expiresAt:String(now+86400n),backup:'server-local-aes256gcm'});
    assertBackgroundTask(scope,m,now);
    const roles=['buyer','seller'] as const,client=createPrivyClient({appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!}),found=new Map<string,{id:string;address:string;delegates:number}>();let count=0;
    for await(const wallet of client.wallets().list()){
      if(++count>500)throw Error('BACKGROUND_WALLET_LOOKUP_LIMIT');
      for(const role of roles)if(wallet.address.toLowerCase()===scope[role].toLowerCase()){
        if(found.has(role))throw Error('BACKGROUND_WALLET_AMBIGUOUS');
        found.set(role,{id:wallet.id,address:wallet.address,delegates:wallet.additional_signers.length});
      }
    }
    const parent=resolve('.tools/background-plans');privateServiceDirectory(parent);
    const directory=resolve(parent,backgroundScopeHash(scope));privateServiceDirectory(directory);
    const blockers=['BUYER_AND_SELLER_BACKGROUND_DELEGATION_NOT_INSTALLED','BACKGROUND_RUNTIME_SESSION_ADAPTER_NOT_CONNECTED','INITIAL_LOCAL_BACKUP_TRUST_APPROVAL_REQUIRED'];
    if(BigInt(entry.quote.expiresAt)<=now)blockers.push('SIGNED_QUOTE_EXPIRED');
    if(roles.some(role=>!found.has(role)))blockers.push('ORIGINAL_ROLE_WALLET_NOT_FOUND');
    const plan={scope,scopeHash:backgroundScopeHash(scope),policies:roles.map(role=>({role,blueprint:backgroundActorPolicy(scope,role)})),canExecute:false,blockers,quoteExpiresAt:entry.quote.expiresAt};
    writePrivateServiceJsonOnce(resolve(directory,'plan.json'),plan);
    writePrivateServiceJsonOnce(resolve(directory,'wallet-inventory.json'),Object.fromEntries(found));
    console.log(JSON.stringify({status:'PREPARED_NOT_ENABLED',scopeHash:plan.scopeHash,chainId:scope.chainId,taskId:scope.taskId,datasetHash:scope.datasetHash,maxOrders:1,maxTotalUnits:'10',expiresAt:scope.expiresAt,backup:scope.backup,roles:roles.map(role=>({role,address:scope[role],walletFound:found.has(role),existingAdditionalSignerCount:found.get(role)?.delegates??null})),blockers,canExecute:false,walletsChanged:0,policiesChanged:0,signaturesRequested:0,transactionsSent:0,privateDirectory:directory}));
  }catch(error){const code=error instanceof Error&&/^BACKGROUND_[A-Z_]+$/.test(error.message)?error.message:'BACKGROUND_PREPARATION_UNAVAILABLE';console.error(JSON.stringify({status:'BLOCKED',code,canExecute:false,walletsChanged:0,policiesChanged:0,signaturesRequested:0,transactionsSent:0}));process.exitCode=1;}
}
