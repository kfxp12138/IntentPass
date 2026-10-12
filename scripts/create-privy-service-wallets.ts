import {constants,closeSync,existsSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,writeFileSync,type Stats} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {getAddress} from 'viem';
import {z} from 'zod';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {ProviderIdSchema} from '../packages/protocol/src/day4-origin-types.js';
import {strictJsonParse} from './strict-json.js';
import {inspectPrivyServiceOwner,parsePrivyServiceOwnerConfiguration,preparePrivyServiceBootstrap,privyServiceOwnerReadPort,type PrivyServiceOwnerReadPort} from './privy-service-bootstrap.js';
import {readPrivyServiceOwnerConfiguration} from './prepare-privy-service-wallets.js';

type Plan=ReturnType<typeof preparePrivyServiceBootstrap>;
type Role=Plan['roles'][number];
export interface ServiceCreationPort extends PrivyServiceOwnerReadPort {
  createPolicy(request:Role['policyCreate']['request']):Promise<unknown>;
  policy(id:string):Promise<unknown>;
  createWallet(request:Role['walletCreate']['request']&{policy_ids:string[]}):Promise<unknown>;
  wallet(id:string):Promise<unknown>;
}
const fail=(reason:string):never=>{throw new Error(`PRIVY_SERVICE_CREATE_${reason}`);};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function canonicalServicePath(path:string){if(realpathSync(path)!==path)fail('PRIVATE_PATH_INVALID');for(let p=path;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())fail('PRIVATE_PATH_INVALID');if(dirname(p)===p)break;}}
const canonical=canonicalServicePath;
export function readPrivateServiceJson(path:string):unknown {
  let fd:number|undefined;
  try{
    canonical(path);const before=lstatSync(path),limit=1024*1024;
    const valid=(s:Stats)=>s.isFile()&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size>0&&s.size<=limit;
    const same=(s:Stats)=>valid(s)&&s.ino===before.ino&&s.dev===before.dev&&s.size===before.size&&s.mtimeMs===before.mtimeMs;
    if(!valid(before))fail('PRIVATE_FILE_INVALID');fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);if(!same(fstatSync(fd)))fail('PRIVATE_FILE_CHANGED');
    // Saved plans include a source manifest and can legitimately exceed 64 KiB.
    const bytes=Buffer.alloc(limit+1);let size=0;
    while(size<bytes.length){const count=readSync(fd,bytes,size,bytes.length-size,null);if(!count)break;size+=count;}
    canonical(path);if(size!==before.size||size>limit||!same(fstatSync(fd))||!same(lstatSync(path)))fail('PRIVATE_FILE_CHANGED');
    return strictJsonParse(new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,size)));
  }catch{return fail('PRIVATE_FILE_INVALID');}finally{if(fd!==undefined)closeSync(fd);}
}
const privateRead=readPrivateServiceJson;
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
export function privateServiceDirectory(path:string){try{mkdirSync(path,{mode:0o700});syncDirectory(dirname(path));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}canonical(path);if(!lstatSync(path).isDirectory()||(lstatSync(path).mode&0o777)!==0o700)fail('PRIVATE_DIRECTORY_INVALID');}
const privateDirectory=privateServiceDirectory;
/** Immutable, exclusively-created records: an interrupted reservation is never released. */
export function writePrivateServiceJsonOnce(path:string,value:unknown){
  canonical(dirname(path));let fd:number|undefined;
  try{fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}
  finally{if(fd!==undefined)closeSync(fd);}
  syncDirectory(dirname(path));
}
const writeOnce=writePrivateServiceJsonOnce;
/** Reconstruct every executable request from the narrow offline template. */
export function validateServiceCreationPlan(input:unknown,owner:unknown,appId:string):Plan {
  try{
    const raw=z.object({planId:z.uuid(),appId:z.string(),configuration:z.unknown(),scope:z.literal('OFFLINE_OPERATOR_OWNED_PRIVY_SERVICE_WALLET_BOOTSTRAP_NO_EXECUTOR'),roles:z.array(z.unknown()).length(2)}).passthrough().parse(input);
    const config=parsePrivyServiceOwnerConfiguration(owner);if(raw.appId!==appId||!isDeepStrictEqual(raw.configuration,config))return fail('PLAN_MISMATCH');
    const expected=structuredClone(preparePrivyServiceBootstrap(config,appId,raw.planId));const keys:string[]=[];
    for(let i=0;i<2;i++){
      const r=z.object({policyCreate:z.object({request:z.object({idempotency_key:z.uuid()}).passthrough()}).passthrough(),walletCreate:z.object({request:z.object({idempotency_key:z.uuid()}).passthrough()}).passthrough()}).passthrough().parse(raw.roles[i]);
      expected.roles[i].policyCreate.request.idempotency_key=r.policyCreate.request.idempotency_key as ReturnType<typeof import('node:crypto').randomUUID>;expected.roles[i].walletCreate.request.idempotency_key=r.walletCreate.request.idempotency_key as ReturnType<typeof import('node:crypto').randomUUID>;
      keys.push(r.policyCreate.request.idempotency_key,r.walletCreate.request.idempotency_key);
    }
    if(new Set(keys).size!==4||!isDeepStrictEqual(raw.roles,expected.roles))return fail('PLAN_MISMATCH');return expected;
  }catch{return fail('PLAN_INVALID');}
}
const policySchema=z.object({id:ProviderIdSchema,owner_id:ProviderIdSchema,chain_type:z.literal('ethereum'),version:z.literal('1.0'),name:z.string(),rules:z.array(z.object({name:z.string(),method:z.string(),action:z.string(),conditions:z.array(z.unknown())}).strip())}).strip();
const walletSchema=z.object({id:ProviderIdSchema,address:z.string(),owner_id:ProviderIdSchema,chain_type:z.literal('ethereum'),policy_ids:z.array(ProviderIdSchema),additional_signers:z.array(z.unknown()).length(0),display_name:z.string(),external_id:z.string(),exported_at:z.null(),imported_at:z.null(),archived_at:z.null().default(null),automations:z.array(z.unknown()).length(0).default([])}).strip();
function checkedPolicy(raw:unknown,request:Role['policyCreate']['request']){
  try{const p=policySchema.parse(raw);if(p.owner_id!==request.owner_id||p.name!==request.name||!isDeepStrictEqual(p.rules,request.rules))return fail('POLICY_MISMATCH');return p;}catch{return fail('POLICY_INVALID');}
}
function checkedWallet(raw:unknown,request:Role['walletCreate']['request']&{policy_ids:string[]}){
  try{const w=walletSchema.parse(raw),address=getAddress(w.address);if(BigInt(address)===0n||w.owner_id!==request.owner_id||w.display_name!==request.display_name||w.external_id!==request.external_id||!isDeepStrictEqual(w.policy_ids,request.policy_ids))return fail('WALLET_MISMATCH');return {...w,address};}catch{return fail('WALLET_INVALID');}
}
export function serviceCreationPort(client:ReturnType<typeof createPrivyClient>):ServiceCreationPort {
  const policies=client.policies(),wallets=client.wallets();
  return Object.freeze({...privyServiceOwnerReadPort(client),createPolicy:policies.create.bind(policies),policy:policies.get.bind(policies),createWallet:wallets.create.bind(wallets),wallet:wallets.get.bind(wallets)});
}
export async function createServiceWallets(options:{root:string;planId:string;appId:string;approved:boolean;port:ServiceCreationPort}){
  if(options.approved!==true)fail('APPROVAL_REQUIRED');
  const planId=z.uuid().parse(options.planId),root=resolve(options.root);canonical(root);
  const planPath=resolve(root,'.tools/privy-service-wallet-plans',planId+'.json');
  const load=()=>validateServiceCreationPlan(privateRead(planPath),readPrivyServiceOwnerConfiguration(root),options.appId);
  const plan=load(),binding=digest(plan),port=options.port;
  const current=()=>{if(digest(load())!==binding)fail('PLAN_CHANGED');};
  await inspectPrivyServiceOwner(plan.configuration,port);current();
  const directory=resolve(root,'.tools/privy-service-execution');privateDirectory(directory);
  const activePath=resolve(directory,'active-plan.json'),active={schemaVersion:1,planId,binding};
  if(!existsSync(activePath)){try{writeOnce(activePath,active);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  if(!isDeepStrictEqual(privateRead(activePath),active))fail('ORIGINAL_PLAN_REQUIRED');
  let mutations=0;
  const operation=async<T>(step:string,request:unknown,create:()=>Promise<unknown>,check:(raw:unknown)=>T,get:(id:string)=>Promise<unknown>):Promise<T>=>{
    current();const reserved=resolve(directory,step+'.reserved.json'),response=resolve(directory,step+'.response.json');
    const reservation={schemaVersion:1,planId,binding,step,request};
    if(existsSync(reserved)){
      if(!isDeepStrictEqual(privateRead(reserved),reservation))fail('RESERVATION_MISMATCH');
      if(!existsSync(response))fail('OUTCOME_UNKNOWN');
    }else{
      if(existsSync(response))fail('RECORD_INVALID');
      await inspectPrivyServiceOwner(plan.configuration,port);current();
      // Commit and fsync before crossing the external mutation boundary.
      try{writeOnce(reserved,reservation);}catch{fail('OUTCOME_UNKNOWN');}
      current();let result:unknown;
      try{mutations++;result=await create();}catch{fail('OUTCOME_UNKNOWN');}
      try{const text=JSON.stringify(result);if(!text||Buffer.byteLength(text)>65536)fail('RESPONSE_INVALID');writeOnce(response,{binding,step,result});}catch{fail('OUTCOME_UNKNOWN');}
    }
    const stored=z.object({binding:z.literal(binding),step:z.literal(step),result:z.unknown()}).strict().parse(privateRead(response));
    const original=check(stored.result),id=ProviderIdSchema.parse((original as {id:string}).id);
    let actual:unknown;try{actual=await get(id);}catch{fail('READ_UNAVAILABLE');}const verified=check(actual);
    if(!isDeepStrictEqual(original,verified))fail('RESOURCE_CHANGED');current();return verified;
  };
  const roles=[];
  for(const role of plan.roles){
    const policy=await operation(role.policyCreate.stepId,role.policyCreate.request,()=>port.createPolicy(role.policyCreate.request),raw=>checkedPolicy(raw,role.policyCreate.request),id=>port.policy(id));
    const request={...role.walletCreate.request,policy_ids:[policy.id]};
    const wallet=await operation(role.walletCreate.stepId,request,()=>port.createWallet(request),raw=>checkedWallet(raw,request),id=>port.wallet(id));
    roles.push({role:role.role,policyId:policy.id,walletId:wallet.id,address:wallet.address});
  }
  if(new Set(roles.map(r=>r.address.toLowerCase())).size!==2||new Set(roles.map(r=>r.walletId)).size!==2||new Set(roles.map(r=>r.policyId)).size!==2)fail('ROLES_NOT_DISTINCT');
  // Re-read both policies/wallets together after all creations; no stale first role.
  for(let i=0;i<roles.length;i++){
    const role=plan.roles[i],result=roles[i];
    const p=checkedPolicy(await port.policy(result.policyId),role.policyCreate.request);
    const w=checkedWallet(await port.wallet(result.walletId),{...role.walletCreate.request,policy_ids:[result.policyId]});
    if(p.id!==result.policyId||w.id!==result.walletId||w.address!==result.address)fail('RESOURCE_CHANGED');
  }
  await inspectPrivyServiceOwner(plan.configuration,port);current();
  const summary={schemaVersion:1,planId,binding,roles,ownerMetadataVerified:true,initialPolicy:'DENY_ALL',transactionsSent:0,signaturesRequested:0};
  const resultPath=resolve(directory,'verified.json');if(!existsSync(resultPath))writeOnce(resultPath,summary);else if(!isDeepStrictEqual(privateRead(resultPath),summary))fail('RECORD_INVALID');
  return {status:'SERVICE_WALLETS_VERIFIED_DENY_ALL' as const,planId,roles,mutationsThisRun:mutations,transactionsSent:0,signaturesRequested:0,runtimeSignerAssigned:false,canExecute:false,financialAcceptanceStatus:'BLOCKED'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==4||process.argv[2]!=='--execute')fail('ARGUMENT_INVALID');
    const appId=process.env.PRIVY_APP_ID,appSecret=process.env.PRIVY_APP_SECRET;if(!appId||!appSecret)fail('CONFIGURATION_REQUIRED');
    const result=await createServiceWallets({root:process.cwd(),planId:process.argv[3],appId:appId!,approved:true,port:serviceCreationPort(createPrivyClient({appId:appId!,appSecret:appSecret!}))});
    console.log(JSON.stringify({...result,roles:result.roles.map(r=>({role:r.role,address:r.address})),privateJournal:'.tools/privy-service-execution',authorizationPrivateKeyUsed:false}));
  }catch(error){const code=error instanceof Error&&/^PRIVY_SERVICE_(CREATE|OWNER)_[A-Z_]+$/.test(error.message)?error.message:'PRIVY_SERVICE_CREATE_UNAVAILABLE';console.error(JSON.stringify({status:'BLOCKED',reason:code,mayHaveCreatedResources:true,retryCreationAllowed:false,transactionsSent:0,signaturesRequested:0}));process.exitCode=1;}
}
