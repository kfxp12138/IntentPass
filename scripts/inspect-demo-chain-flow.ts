import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {z} from 'zod';
import {createPublicClient} from 'viem';
import {pacedHttp} from '../packages/adapters/src/paced-rpc.js';
import {configuredAssetMode} from '../packages/protocol/src/asset-mode.js';
import {inspectDay4ChainFlow} from '../packages/protocol/src/day4-chain-flow.js';
import {day4ChainFlowPort} from '../packages/protocol/src/day4-chain-flow-port.js';
import {Day4ChainFlowDeploymentSchema,Day4ChainFlowRequestSchema} from '../packages/protocol/src/day4-chain-flow-types.js';
import {DemoChainFlowReportSchema,demoFlowConfigurationNames,type DemoChainFlowReport} from './demo-chain-flow-observation.js';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {readPrivateOriginJson} from './private-origin-input.js';
import {strictJsonParse} from './strict-json.js';
import {auditBytes} from './public-audit.js';

const startedAt=new Date().toISOString();
let invocationId:string=randomUUID();
let source:ReleaseSourceSnapshot|null=null,status:DemoChainFlowReport['status']='BLOCKED',reason='DEMO_CHAIN_FLOW_CONFIGURATION_MISSING',exitCode:0|1=1;
let deployment:DemoChainFlowReport['deployment']=null,requestIdentity:DemoChainFlowReport['requestIdentity']=null,inspection:DemoChainFlowReport['inspection']=null;
let publicRpcInspectionAttempted=false,privateInputReadAttempted=false,sourceStable=false,missing:DemoChainFlowReport['missing']=[];
const working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'}),worktreeDirty=working.status!==0||!!working.stdout.trim();
try{
  if(process.argv.length===4&&process.argv[2]==='--invocation')invocationId=z.string().uuid().parse(process.argv[3]);
  else if(process.argv.length!==2)throw Error('DEMO_CHAIN_FLOW_ARGUMENT_INVALID');
  source=captureReleaseSource();
  if(existsSync('.env'))loadEnvFile('.env');
  if(configuredAssetMode(process.env)!=='demo-erc20')throw Error('DEMO_CHAIN_FLOW_PROFILE_INVALID');
  missing=demoFlowConfigurationNames.filter(name=>!process.env[name]?.trim());
  if(!missing.length){
    const config=Day4ChainFlowDeploymentSchema.safeParse({chainId:process.env.CHAIN_ID,arbiter:process.env.ARBITER_ADDRESS,asset:process.env.ASSET_ADDRESS,
      gate:process.env.ELIGIBILITY_GATE_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,executor:process.env.PRIVY_EXECUTOR_ADDRESS,
      committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim())});
    if(!config.success)throw Error('DEMO_CHAIN_FLOW_CONFIGURATION_INVALID');deployment=config.data;
    privateInputReadAttempted=true;
    let request;
    try{
      const path=process.env.D4_CHAIN_FLOW_PATH!,before=lstatSync(path);
      if(!before.isFile()||(before.mode&0o777)!==0o600||before.nlink!==1||process.getuid&&before.uid!==process.getuid())throw Error();
      const bytes=readPrivateOriginJson(path),after=lstatSync(path);
      if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||before.size!==after.size||before.mode!==after.mode||before.uid!==after.uid||after.nlink!==1)throw Error();
      request=Day4ChainFlowRequestSchema.parse(strictJsonParse(bytes.toString('utf8')));
    }catch{throw Error('DEMO_CHAIN_FLOW_PRIVATE_INPUT_INVALID');}
    requestIdentity={orderId:request.payload.intent.orderId,contextHash:request.payload.grant.contextHash,transactions:request.transactions};
    let endpoint:URL;try{endpoint=new URL(process.env.MONAD_RPC_URL!);}catch{throw Error('DEMO_CHAIN_FLOW_RPC_INVALID');}
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw Error('DEMO_CHAIN_FLOW_RPC_INVALID');
    const client=createPublicClient({ccipRead:false,transport:pacedHttp(endpoint.href,{timeout:10000,fetchOptions:{redirect:'error'}})});
    publicRpcInspectionAttempted=true;
    inspection=await inspectDay4ChainFlow(request,deployment,day4ChainFlowPort(client,deployment));
    status='CHAIN_FLOW_VERIFIED';reason='DEMO_CONFIGURED_ORIGINAL_PAID_CHAIN_EFFECTS_VERIFIED';exitCode=0;
  }
}catch(error){
  const code=error instanceof Error&&/^(?:DAY4_FLOW_[A-Z_]+|DEMO_CHAIN_FLOW_[A-Z_]+)$/.test(error.message)?error.message:'DEMO_CHAIN_FLOW_READ_UNAVAILABLE';
  reason=code;status=['DEMO_CHAIN_FLOW_READ_UNAVAILABLE','DAY4_FLOW_READ_UNAVAILABLE','DAY4_FLOW_TRANSACTION_PENDING'].includes(code)?'BLOCKED':'FAIL';exitCode=1;inspection=null;
}
try{sourceStable=source!==null&&sameReleaseSource(source,captureReleaseSource());}catch{/* No source provenance is inferred. */}
if(!sourceStable){status='FAIL';reason='DEMO_CHAIN_FLOW_SOURCE_CHANGED';exitCode=1;inspection=null;}
try{
  const report=DemoChainFlowReportSchema.parse({schemaVersion:2,invocationId,assetMode:'demo-erc20',scope:'READ_ONLY_DEMO_ORIGINAL_CHAIN_FLOW_NOT_FULL_D4_ACCEPTANCE',
    startedAt,endedAt:new Date().toISOString(),source,sourceStable,worktreeDirty,status,reason,missing,deployment,requestIdentity,inspection,
    publicRpcInspectionAttempted,privateInputReadAttempted,exitCode,financialAcceptanceStatus:'BLOCKED',canPassD4:false,canExecute:false,identityVerification:false,
    officialIntegrationVerified:false,privyOriginVerified:false,deploymentCreationVerified:false,signaturesRequested:0,transactionsSent:0,
    limits:['Exact original configured ERC20 effects only; no deployment creation, Privy record or JEV provenance.',
      'Historical balances are whole-block endpoints; original receipt events independently bind target transfers.',
      'This diagnostic cannot make D4 or a release PASS; all remaining current-scope gates stay required.']});
  const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  const sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PRIVY_REVIEWER_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY'].map(name=>process.env[name]).filter((v):v is string=>!!v);
  if(auditBytes('demo-chain-flow.json',bytes).length||sensitive.some(v=>bytes.includes(v)))throw Error('PUBLIC_OUTPUT_UNSAFE');
  const folder='artifacts/acceptance/demo-chain-flow';mkdirSync(folder,{recursive:true});const path=`${folder}/${invocationId}.json`;
  writeFileSync(path,bytes,{flag:'wx'});console.log(JSON.stringify({status,reason,missing,financialAcceptanceStatus:'BLOCKED',publicRpcInspectionAttempted,transactionsSent:0,evidence:path,exitCode}));
}catch{console.error('DEMO_CHAIN_FLOW_EVIDENCE_WRITE_UNAVAILABLE');exitCode=1;}
process.exitCode=exitCode;
