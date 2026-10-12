import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {loadActivatedReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {auditBytes} from './public-audit.js';
import {inspectPrivyRoles,parsePrivyRoleConfiguration,preparePrivyRoles,privyRoleReadPort,PrivyRolePreparationError,
  type PrivyRoleConfiguration,type PrivyRoleReadPort} from './privy-role-preparation.js';

export const privyRolePublicConfigurationNames=['SETTLEMENT_ASSET_MODE','CHAIN_ID','ARBITER_ADDRESS','PRIVY_EXECUTOR_ADDRESS',
  'PRIVY_WALLET_ID','PRIVY_POLICY_ID','PRIVY_SIGNER_ID','REVIEWER_ADDRESS','PRIVY_REVIEWER_WALLET_ID','PRIVY_REVIEWER_POLICY_ID',
  'PRIVY_REVIEWER_SIGNER_ID','REVIEW_POLICY_PATH','JEV_MODEL'] as const;
type ActiveRule=ReturnType<typeof loadActivatedReviewPolicy>;
const errors=new Set(['PRIVY_ROLES_ARGUMENT_INVALID','PRIVY_ROLES_CLOCK_INVALID','PRIVY_ROLES_SOURCE_UNAVAILABLE',
  'PRIVY_ROLES_CONFIGURATION_INVALID','PRIVY_ROLES_PORT_INVALID','PRIVY_ROLES_PROVIDER_IDENTIFIER_INVALID','PRIVY_ROLES_READ_UNAVAILABLE',
  'PRIVY_ROLES_CURRENT_CONFIGURATION_INVALID','PRIVY_ROLES_CURRENT_CONFIGURATION_MISMATCH','PRIVY_ROLES_SIGNER_POLICY_MISMATCH',
  'PRIVY_ROLES_POLICY_SCOPE_MISMATCH','PRIVY_ROLES_CURRENT_CONFIGURATION_CHANGED','PRIVY_ROLES_ACTIVE_REVIEW_POLICY_CHANGED',
  'PRIVY_ROLES_SOURCE_CHANGED','REVIEW_POLICY_INVALID','REVIEW_POLICY_ACTIVATION_REQUIRED']);
const iso=(time:number)=>{try{return Number.isSafeInteger(time)&&time>0?new Date(time).toISOString():null;}catch{return null;}};
export interface PrivyRolePreparationRuntime {
  argv?:readonly string[];env?:NodeJS.ProcessEnv;root?:string;clock?:()=>number;
  captureSource?:()=>ReleaseSourceSnapshot;
  loadActiveRule?:(path:string,model:string,root:string)=>ActiveRule;
  readPort?:(config:PrivyRoleConfiguration,credentials:{appId:string;appSecret:string})=>PrivyRoleReadPort;
}
/** Uses inherited environment only. No dotenv file or authorization key is read.
 * Runtime seams are for local tests; CLI arguments cannot supply rules, ABI, URL,
 * client, port, or a policy override. Reports omit provider IDs and provider bodies. */
export async function runPrivyRolePreparation(runtime:PrivyRolePreparationRuntime={}){
  const env=runtime.env??process.env,args=runtime.argv??process.argv.slice(2),root=runtime.root??process.cwd(),now=runtime.clock??Date.now;
  const publicEnv=Object.fromEntries(privyRolePublicConfigurationNames.map(name=>[name,env[name]]));
  const capture=runtime.captureSource??(()=>captureReleaseSource(root)),load=runtime.loadActiveRule??loadActivatedReviewPolicy;
  const mode=args.length===0?'PREPARE':args.length===1&&args[0]==='--inspect'?'INSPECT':null;
  const started=now(),startedAt=iso(started);
  let source:ReleaseSourceSnapshot|null=null,preparation:ReturnType<typeof preparePrivyRoles>|null=null,
    inspection:Awaited<ReturnType<typeof inspectPrivyRoles>>|null=null,readCallsAttempted=0,reviewPolicyIntegrityChecked=false,
    status:'PREPARED'|'CURRENT_ROLES_VERIFIED'|'BLOCKED'|'FAIL'='FAIL',reason='PRIVY_ROLES_ARGUMENT_INVALID',missing:string[]=[],secret:string|undefined;
  try{
    if(!mode)throw new PrivyRolePreparationError('PRIVY_ROLES_ARGUMENT_INVALID');
    if(!startedAt)throw new PrivyRolePreparationError('PRIVY_ROLES_CLOCK_INVALID');
    missing=privyRolePublicConfigurationNames.filter(name=>!publicEnv[name]?.trim());
    try{source=capture();}catch{if(!missing.length)throw new PrivyRolePreparationError('PRIVY_ROLES_SOURCE_UNAVAILABLE');}
    if(missing.length){status='BLOCKED';reason='PRIVY_ROLES_CONFIGURATION_MISSING';}
    else{
      const rule=load(publicEnv.REVIEW_POLICY_PATH!,publicEnv.JEV_MODEL!,root);reviewPolicyIntegrityChecked=true;
      const config=parsePrivyRoleConfiguration({assetMode:publicEnv.SETTLEMENT_ASSET_MODE,chainId:publicEnv.CHAIN_ID,arbiter:publicEnv.ARBITER_ADDRESS,
        executor:{address:publicEnv.PRIVY_EXECUTOR_ADDRESS,walletId:publicEnv.PRIVY_WALLET_ID,policyId:publicEnv.PRIVY_POLICY_ID,signerId:publicEnv.PRIVY_SIGNER_ID},
        reviewer:{address:publicEnv.REVIEWER_ADDRESS,walletId:publicEnv.PRIVY_REVIEWER_WALLET_ID,policyId:publicEnv.PRIVY_REVIEWER_POLICY_ID,signerId:publicEnv.PRIVY_REVIEWER_SIGNER_ID},
        model:rule.model,questionConfigHash:rule.questionConfigHash});
      preparation=preparePrivyRoles(config);status='PREPARED';reason='PRIVY_ROLES_BLUEPRINTS_PREPARED_NOT_INSTALLED';
      if(mode==='INSPECT'){
        missing=['PRIVY_APP_ID','PRIVY_APP_SECRET'].filter(name=>!env[name]?.trim());
        if(missing.length){status='BLOCKED';reason='PRIVY_ROLES_APPLICATION_CONFIGURATION_MISSING';}
        else{
          const credentials={appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!};secret=credentials.appSecret;
          const identifiers=[config.executor.walletId,config.executor.policyId,config.executor.signerId,config.reviewer.walletId,config.reviewer.policyId,config.reviewer.signerId];
          if(secret.length>=16&&identifiers.some(id=>id.includes(secret!)))throw new PrivyRolePreparationError('PRIVY_ROLES_PROVIDER_IDENTIFIER_INVALID');
          const port=runtime.readPort?runtime.readPort(config,credentials):privyRoleReadPort(createPrivyClient(credentials));
          inspection=await inspectPrivyRoles(config,port);readCallsAttempted=inspection.readCallsAttempted;
          status='CURRENT_ROLES_VERIFIED';reason='PRIVY_ROLES_CURRENT_EFFECTIVE_POLICIES_VERIFIED_NOT_EXECUTION';
        }
      }
      if(!isDeepStrictEqual(rule,load(publicEnv.REVIEW_POLICY_PATH!,publicEnv.JEV_MODEL!,root)))throw new PrivyRolePreparationError('PRIVY_ROLES_ACTIVE_REVIEW_POLICY_CHANGED');
    }
    if(source&&!sameReleaseSource(source,capture()))throw new PrivyRolePreparationError('PRIVY_ROLES_SOURCE_CHANGED');
  }catch(error){
    if(error instanceof PrivyRolePreparationError)readCallsAttempted=Math.max(readCallsAttempted,error.readCallsAttempted);
    const known=error instanceof Error&&errors.has(error.message)?error.message:'PRIVY_ROLES_PREPARATION_UNAVAILABLE';
    reason=known;status=/READ_UNAVAILABLE|SOURCE_UNAVAILABLE|REVIEW_POLICY_ACTIVATION_REQUIRED/.test(known)?'BLOCKED':'FAIL';inspection=null;
    if(/SOURCE_CHANGED|ACTIVE_REVIEW_POLICY_CHANGED/.test(known)){preparation=null;reviewPolicyIntegrityChecked=false;}
  }
  const ended=now(),endedAt=ended>=started?iso(ended):null;
  if(!endedAt){status='FAIL';reason='PRIVY_ROLES_CLOCK_INVALID';inspection=null;}
  const base={schemaVersion:1,scope:'PRIVY_TWO_ROLE_PREPARATION_AND_READ_ONLY_CURRENT_POLICY_NOT_EXECUTION' as const,mode,status,reason,missing,
    startedAt,endedAt,sourceCommit:source?.sourceCommit??null,sourceBindings:source?.bindings??[],reviewPolicyIntegrityChecked,reviewPolicyProvenanceAttested:false,
    preparation,inspection,readCallsAttempted,applicationCredentialsRecorded:false,authorizationPrivateKeysRead:false,providerIdentifiersRecorded:false,
    providerBodiesRecorded:false,deploymentVerified:false,historicalPolicyAtSendVerified:false,financialAcceptanceStatus:'BLOCKED' as const,
    canExecute:false as const,walletsCreated:0 as const,policiesChanged:0 as const,signaturesRequested:0 as const,transactionsSent:0 as const,
    limits:['Offline output contains fixed policy blueprints only; it does not install a policy or create a wallet.',
      'Inspect compares only the two chosen signers current effective wallet policies with eight GET method calls on success.',
      'GET matches do not prove authorization-key possession, historical policy, wallet funding, contract deployment, receipt signing, policy denial, or execution.']};
  const bytes=Buffer.from(JSON.stringify(base));
  if(auditBytes('privy-roles.json',bytes).length||secret&&secret.length>=16&&bytes.includes(secret)){
    return {report:{...base,status:'FAIL' as const,reason:'PRIVY_ROLES_PUBLIC_OUTPUT_UNSAFE',sourceCommit:null,sourceBindings:[],preparation:null,inspection:null},exitCode:1};
  }
  return {report:base,exitCode:status==='PREPARED'||status==='CURRENT_ROLES_VERIFIED'?0:1};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {report,exitCode}=await runPrivyRolePreparation(),directory='artifacts/acceptance/privy-role-preparation';
  try{mkdirSync(directory,{recursive:true});const path=`${directory}/${Date.now()}-${randomUUID()}.json`;
    writeFileSync(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,mode:report.mode,readCallsAttempted:report.readCallsAttempted,financialAcceptanceStatus:report.financialAcceptanceStatus,evidence:path}));process.exitCode=exitCode;
  }catch{console.error('PRIVY_ROLES_EVIDENCE_WRITE_UNAVAILABLE');process.exitCode=1;}
}
