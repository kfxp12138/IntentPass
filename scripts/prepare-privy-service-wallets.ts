import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {constants,lstatSync,realpathSync,mkdirSync,openSync,writeFileSync,fsyncSync,fstatSync,closeSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {createPrivyClient} from '../packages/adapters/src/privy-auth.js';
import {readStableReleaseJson} from './release-review.js';
import {strictJsonParse} from './strict-json.js';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {auditBytes} from './public-audit.js';
import {inspectPrivyServiceOwner,parsePrivyServiceOwnerConfiguration,preparePrivyServiceBootstrap,privyServiceOwnerReadPort,
  PrivyServiceBootstrapError,type PrivyServiceOwnerReadPort,type PrivyServiceOwnerConfiguration} from './privy-service-bootstrap.js';

export const privyServiceOwnerInputName='.tools/privy-service-owner.json';
export const privyServicePlanDirectory='.tools/privy-service-wallet-plans';
const codes=new Set(['PRIVY_SERVICE_ARGUMENT_INVALID','PRIVY_SERVICE_CLOCK_INVALID','PRIVY_SERVICE_SOURCE_UNAVAILABLE','PRIVY_SERVICE_SOURCE_CHANGED',
  'PRIVY_SERVICE_OWNER_INPUT_MISSING','PRIVY_SERVICE_OWNER_INPUT_INVALID','PRIVY_SERVICE_OWNER_CONFIGURATION_INVALID','PRIVY_SERVICE_OWNER_CONFIGURATION_CHANGED','PRIVY_SERVICE_APP_CONFIGURATION_INVALID',
  'PRIVY_SERVICE_OWNER_PORT_INVALID','PRIVY_SERVICE_OWNER_IDENTIFIER_INVALID','PRIVY_SERVICE_OWNER_READ_UNAVAILABLE','PRIVY_SERVICE_OWNER_METADATA_INVALID',
  'PRIVY_SERVICE_OWNER_METADATA_MISMATCH','PRIVY_SERVICE_OWNER_METADATA_CHANGED','PRIVY_SERVICE_PLAN_WRITE_UNAVAILABLE','PRIVY_SERVICE_PUBLIC_OUTPUT_UNSAFE']);
function canonical(path:string){
  if(!isAbsolute(path)||path!==resolve(path)||realpathSync(path)!==path)throw Error('PRIVY_SERVICE_OWNER_INPUT_INVALID');
  for(let current=path;;current=dirname(current)){if(lstatSync(current).isSymbolicLink())throw Error('PRIVY_SERVICE_OWNER_INPUT_INVALID');if(dirname(current)===current)break;}
}
/** Only the fixed ignored operator file; its bytes and fingerprints never enter public evidence. */
export function readPrivyServiceOwnerConfiguration(root=process.cwd()){
  const path=resolve(root,privyServiceOwnerInputName);
  try{
    canonical(root);canonical(path);const before=lstatSync(path);
    if(!before.isFile()||(before.mode&0o777)!==0o600||before.nlink!==1||before.size>65536)throw Error('PRIVY_SERVICE_OWNER_INPUT_INVALID');
    const bytes=readStableReleaseJson(path),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);canonical(path);const after=lstatSync(path);
    if(!after.isFile()||(after.mode&0o777)!==0o600||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)
      throw Error('PRIVY_SERVICE_OWNER_INPUT_INVALID');
    return strictJsonParse(text);
  }catch(error){throw new PrivyServiceBootstrapError(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'
    ?'PRIVY_SERVICE_OWNER_INPUT_MISSING':'PRIVY_SERVICE_OWNER_INPUT_INVALID');}
}
/** A fresh UUID file only; caller-controlled names or paths cannot reach this writer. */
export function writePrivyServiceBootstrapPlan(root:string,plan:ReturnType<typeof preparePrivyServiceBootstrap>,source:ReleaseSourceSnapshot){
  let fd:number|undefined;
  try{
    canonical(root);z.uuid().parse(plan.planId);
    const tools=resolve(root,'.tools');try{mkdirSync(tools,{mode:0o700});}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST'))throw error;}canonical(tools);
    const directory=resolve(root,privyServicePlanDirectory);try{mkdirSync(directory,{mode:0o700});}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST'))throw error;}canonical(directory);
    const parent=lstatSync(directory);if(!parent.isDirectory()||(parent.mode&0o777)!==0o700)throw Error();
    const path=resolve(directory,plan.planId+'.json');fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,JSON.stringify({...plan,source},null,2)+'\n');fsyncSync(fd);const stored=fstatSync(fd);canonical(directory);canonical(path);const current=lstatSync(path),after=lstatSync(directory);
    if((stored.mode&0o777)!==0o600||stored.ino!==current.ino||stored.dev!==current.dev||parent.ino!==after.ino||parent.dev!==after.dev)throw Error();
  }catch{throw new PrivyServiceBootstrapError('PRIVY_SERVICE_PLAN_WRITE_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}
}
const iso=(time:number)=>{try{return Number.isSafeInteger(time)&&time>0?new Date(time).toISOString():null;}catch{return null;}};
export interface PrivyServiceBootstrapRuntime {
  argv?:readonly string[];env?:NodeJS.ProcessEnv;root?:string;clock?:()=>number;
  captureSource?:()=>ReleaseSourceSnapshot;readOwnerConfiguration?:()=>unknown;
  ownerReadPort?:(credentials:{appId:string;appSecret:string})=>PrivyServiceOwnerReadPort;
  writePlan?:(plan:ReturnType<typeof preparePrivyServiceBootstrap>,source:ReleaseSourceSnapshot)=>void;
}
/** Environment is inherited, never loaded here. Preparation reads only public App ID.
 * Inspect captures one official quorum GET capability. There is no mutation mode. */
export async function runPrivyServiceBootstrap(runtime:PrivyServiceBootstrapRuntime={}){
  const args=runtime.argv??process.argv.slice(2),env=runtime.env??process.env,root=runtime.root??process.cwd(),now=runtime.clock??Date.now;
  const mode=args.length===0?'PREPARE' as const:args.length===1&&args[0]==='--inspect'?'INSPECT' as const:null;
  const capture=runtime.captureSource??(()=>captureReleaseSource(root)),readOwner=runtime.readOwnerConfiguration??(()=>readPrivyServiceOwnerConfiguration(root));
  const started=now(),startedAt=iso(started);let source:ReleaseSourceSnapshot|null=null,sourceStable=false,
    status:'PREPARED'|'CURRENT_OPERATOR_OWNER_METADATA_VERIFIED'|'BLOCKED'|'FAIL'='FAIL',reason='PRIVY_SERVICE_ARGUMENT_INVALID',missing:string[]=[],
    plan:ReturnType<typeof preparePrivyServiceBootstrap>|undefined,inspection:Awaited<ReturnType<typeof inspectPrivyServiceOwner>>|undefined,
    planSaved=false,appConfigured=false,readCallsAttempted=0,secret:string|undefined,ownerConfiguration:PrivyServiceOwnerConfiguration|undefined;
  try{
    // Unsupported execution/path arguments fail before any input or source file read.
    if(!mode)throw new PrivyServiceBootstrapError('PRIVY_SERVICE_ARGUMENT_INVALID');
    if(!startedAt)throw new PrivyServiceBootstrapError('PRIVY_SERVICE_CLOCK_INVALID');
    try{source=capture();}catch{throw new PrivyServiceBootstrapError('PRIVY_SERVICE_SOURCE_UNAVAILABLE');}
    const appId=env.PRIVY_APP_ID;let input:unknown;
    if(!appId?.trim())missing.push('PRIVY_APP_ID');
    else if(!z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(appId).success)throw new PrivyServiceBootstrapError('PRIVY_SERVICE_APP_CONFIGURATION_INVALID');
    else appConfigured=true;
    try{input=readOwner();}catch(error){if(error instanceof PrivyServiceBootstrapError&&error.message==='PRIVY_SERVICE_OWNER_INPUT_MISSING')missing.push('PRIVY_SERVICE_OWNER_CONFIG');else throw error;}
    if(missing.length){status='BLOCKED';reason='PRIVY_SERVICE_CONFIGURATION_MISSING';}
    else{
      const config=parsePrivyServiceOwnerConfiguration(input);ownerConfiguration=config;plan=preparePrivyServiceBootstrap(config,appId!);
      if(mode==='INSPECT'){
        if(!env.PRIVY_APP_SECRET?.trim()){status='BLOCKED';reason='PRIVY_SERVICE_APPLICATION_CREDENTIALS_MISSING';missing.push('PRIVY_APP_SECRET');}
        else{
          secret=env.PRIVY_APP_SECRET;const credentials={appId:appId!,appSecret:secret!};
          const port=runtime.ownerReadPort?runtime.ownerReadPort(credentials):privyServiceOwnerReadPort(createPrivyClient(credentials));
          inspection=await inspectPrivyServiceOwner(config,port);readCallsAttempted=inspection.readCallsAttempted;
          status='CURRENT_OPERATOR_OWNER_METADATA_VERIFIED';reason='PRIVY_SERVICE_CURRENT_OWNER_METADATA_VERIFIED_NOT_KEY_POSSESSION';
        }
      }else{status='PREPARED';reason='PRIVY_SERVICE_OFFLINE_PLAN_PREPARED_NOT_CREATED';}
    }
    if(ownerConfiguration){let current:PrivyServiceOwnerConfiguration;try{current=parsePrivyServiceOwnerConfiguration(readOwner());}catch{throw new PrivyServiceBootstrapError('PRIVY_SERVICE_OWNER_CONFIGURATION_CHANGED');}
      if(!isDeepStrictEqual(ownerConfiguration,current))throw new PrivyServiceBootstrapError('PRIVY_SERVICE_OWNER_CONFIGURATION_CHANGED');}
    if(!sameReleaseSource(source,capture()))throw new PrivyServiceBootstrapError('PRIVY_SERVICE_SOURCE_CHANGED');sourceStable=true;
  }catch(error){
    if(error instanceof PrivyServiceBootstrapError)readCallsAttempted=Math.max(readCallsAttempted,error.readCallsAttempted);
    reason=error instanceof Error&&codes.has(error.message)?error.message:'PRIVY_SERVICE_PREPARATION_UNAVAILABLE';
    status=/READ_UNAVAILABLE|SOURCE_UNAVAILABLE|INPUT_MISSING/.test(reason)?'BLOCKED':'FAIL';inspection=undefined;
  }
  const ended=now(),endedAt=ended>=started?iso(ended):null;
  if(!endedAt){status='FAIL';reason='PRIVY_SERVICE_CLOCK_INVALID';inspection=undefined;}
  if((status==='PREPARED'||status==='CURRENT_OPERATOR_OWNER_METADATA_VERIFIED')&&plan&&source&&sourceStable&&endedAt){
    try{(runtime.writePlan??((value,snapshot)=>writePrivyServiceBootstrapPlan(root,value,snapshot)))(plan,source);planSaved=true;}
    catch{status='FAIL';reason='PRIVY_SERVICE_PLAN_WRITE_UNAVAILABLE';inspection=undefined;}
  }
  const report={schemaVersion:1,scope:'OFFLINE_PRIVY_SERVICE_BOOTSTRAP_OPTIONAL_CURRENT_OWNER_GETS_NO_CREATION' as const,mode,status,reason,missing,
    planId:plan?.planId??null,privatePlanSaved:planSaved,appConfigured,startedAt,endedAt,sourceCommit:source?.sourceCommit??null,sourceBindings:source?.bindings??[],sourceStable,
    ownerMetadataVerified:inspection?.ownerMetadataVerified??false,authorizationThreshold:inspection?.authorizationThreshold??null,
    authorizationPublicKeyCount:inspection?.authorizationPublicKeyCount??null,userMemberCount:inspection?.userMemberCount??null,nestedQuorumCount:inspection?.nestedQuorumCount??null,
    readCallsAttempted,ownerIdentifiersRecorded:false,ownerPublicKeysRecorded:false,providerBodiesRecorded:false,inputFingerprintsRecorded:false,
    credentialsRecorded:false,authorizationPrivateKeysRead:false,walletPrivateKeysRead:false,authorizationKeyPossessionVerified:false,runtimeMultisigSupported:false,
    policyInstallationVerified:false,arbiterBound:false,runtimeSignerAssigned:false,canExecute:false,financialAcceptanceStatus:'BLOCKED' as const,
    walletsCreated:0,policiesCreated:0,policiesChanged:0,signaturesRequested:0,transactionsSent:0,
    limits:['The saved private plan is tied to the explicit current application App ID; there is no creation or policy installation executor.',
      'Initial future wallets and policies must retain the selected operator owner and deny all wallet actions; no arbiter or runtime signer is assigned.',
      'Two matching quorum GETs prove current metadata only, not private-key possession or runtime multisig support.',
      'Later creation requires explicit approval and durable original operation reservations; unknown responses never permit a new creation.',
      'A later runtime plan requires a verified deployed arbiter and separate signer authority; existing user policies are outside this scope.']};
  const bytes=Buffer.from(JSON.stringify(report));
  if(auditBytes('privy-service-bootstrap.json',bytes).length||(secret&&secret.length>=16&&bytes.includes(secret))){
    return {report:{...report,status:'FAIL' as const,reason:'PRIVY_SERVICE_PUBLIC_OUTPUT_UNSAFE',sourceCommit:null,sourceBindings:[],sourceStable:false,ownerMetadataVerified:false},exitCode:1};
  }
  return {report,exitCode:status==='PREPARED'||status==='CURRENT_OPERATOR_OWNER_METADATA_VERIFIED'?0:1};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {report,exitCode}=await runPrivyServiceBootstrap(),directory='artifacts/acceptance/privy-service-bootstrap';
  try{mkdirSync(directory,{recursive:true});const path=`${directory}/${Date.now()}-${randomUUID()}.json`;
    writeFileSync(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,mode:report.mode,readCallsAttempted:report.readCallsAttempted,privatePlanSaved:report.privatePlanSaved,canExecute:false,financialAcceptanceStatus:'BLOCKED',evidence:path}));process.exitCode=exitCode;
  }catch{console.error('PRIVY_SERVICE_EVIDENCE_WRITE_UNAVAILABLE');process.exitCode=1;}
}
