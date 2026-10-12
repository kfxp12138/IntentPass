import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {createPublicClient,http,type Hex} from 'viem';
import {Day4OriginsRequestSchema,Day4CreationPairConfigSchema,PrivyOriginConfigSchema} from '../packages/protocol/src/day4-origin-types.js';
import {Day4ChainFlowDeploymentSchema} from '../packages/protocol/src/day4-chain-flow-types.js';
import {Day4PolicyProbeAttemptSchema,type Day4PolicyProbeJournal,type Day4PolicyProbeProvider} from '../packages/protocol/src/day4-policy-probe-types.js';
import {inspectDay4PolicyProbe} from '../packages/protocol/src/day4-policy-probe.js';
import {day4ChainFlowPort} from '../packages/protocol/src/day4-chain-flow-port.js';
import {day4CreationPairPort} from '../packages/protocol/src/day4-creation-pair-port.js';
import {day4PolicyProbeProvider} from '../packages/adapters/src/day4-policy-probe-provider.js';
import {PolicyProbeAttemptStore} from '../packages/storage/src/policy-probe-attempt-store.js';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {readPrivateOriginJson} from './private-origin-input.js';
import {strictJsonParse} from './strict-json.js';
import {auditBytes} from './public-audit.js';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {commandExit} from './verification-outcome.js';

const startedAt=new Date().toISOString(),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const worktreeDirty=commandExit(working)!==0||!!working.stdout.trim();
const mode=process.argv.length===2?'prepare':process.argv.length===3&&process.argv[2]==='--execute'?'execute':null;
let before:ReleaseSourceSnapshot|null=null,after:ReleaseSourceSnapshot|null=null;
let compiled:ReturnType<typeof compileDeploymentArtifacts>|null=null,privateBytes:Buffer|null=null,inputPath:string|null=null;
let provider:Day4PolicyProbeProvider|null=null,store:PolicyProbeAttemptStore|null=null;
let report:Record<string,unknown>={status:'FAIL',reason:'DAY4_POLICY_PROBE_INPUT_INVALID'};
let publicRpcInspectionAttempted=false,simulationCallsAttempted=0,privyReadCallsAttempted=0;
const readonlyJournal:Day4PolicyProbeJournal=Object.freeze({get:()=>null,reserve:()=>{throw Error('DAY4_POLICY_PROBE_EXECUTION_DISABLED');},
  recordResponse:()=>{throw Error('DAY4_POLICY_PROBE_EXECUTION_DISABLED');},markUnknown:()=>{throw Error('DAY4_POLICY_PROBE_EXECUTION_DISABLED');},
  recordUnexpectedHash:()=>{throw Error('DAY4_POLICY_PROBE_EXECUTION_DISABLED');}});
function unchanged(){
  if(!sameReleaseSource(before,captureReleaseSource()))throw Error('DAY4_POLICY_PROBE_SOURCE_CHANGED');
  const finalWorking=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
  if(commandExit(finalWorking)!==0||working.stdout!==finalWorking.stdout)throw Error('DAY4_POLICY_PROBE_SOURCE_CHANGED');
  compiled?.assertCurrent();
  if(privateBytes&&inputPath&&!privateBytes.equals(readPrivateOriginJson(inputPath)))throw Error('DAY4_POLICY_PROBE_PRIVATE_INPUT_CHANGED');
}
try{
  before=captureReleaseSource();
  if(mode===null||commandExit(working)!==0)throw Error('DAY4_POLICY_PROBE_INPUT_INVALID');
  if(existsSync('.env'))loadEnvFile('.env');
  const names=['CHAIN_ID','DEPLOYER_ADDRESS','CVA_ADDRESS','CVI_VALIDATOR_ADDRESS','CVA_POLICY_ADDRESS','ELIGIBILITY_GATE_ADDRESS','ARBITER_ADDRESS',
    'REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','CLEANVERSE_GATE_NONCE','PRIVY_EXECUTOR_ADDRESS','PRIVY_APP_ID','PRIVY_APP_SECRET','PRIVY_WALLET_ID',
    'PRIVY_POLICY_ID','PRIVY_SIGNER_ID','D4_POLICY_PROBE_PATH',...(mode==='execute'?['PRIVY_AUTHORIZATION_PRIVATE_KEY','D4_POLICY_PROBE_JOURNAL']:[])];
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length)report={status:'BLOCKED',reason:'DAY4_POLICY_PROBE_CONFIGURATION_MISSING',missing};
  else{
    let config,request;
    try{
      const committee=process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim());
      const flow=Day4ChainFlowDeploymentSchema.parse({chainId:process.env.CHAIN_ID,arbiter:process.env.ARBITER_ADDRESS,asset:process.env.CVA_ADDRESS,
        gate:process.env.ELIGIBILITY_GATE_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,committee,executor:process.env.PRIVY_EXECUTOR_ADDRESS});
      const creations=Day4CreationPairConfigSchema.parse({chainId:flow.chainId,deployer:process.env.DEPLOYER_ADDRESS,asset:flow.asset,
        validator:process.env.CVI_VALIDATOR_ADDRESS,policy:process.env.CVA_POLICY_ADDRESS,pool:flow.arbiter,gate:flow.gate,reviewer:flow.reviewer,
        committee,gateNonce:process.env.CLEANVERSE_GATE_NONCE});
      const privy=PrivyOriginConfigSchema.parse({chainId:flow.chainId,arbiter:flow.arbiter,address:flow.executor,
        walletId:process.env.PRIVY_WALLET_ID,policyId:process.env.PRIVY_POLICY_ID,signerId:process.env.PRIVY_SIGNER_ID});
      config={flow,creations,privy};inputPath=process.env.D4_POLICY_PROBE_PATH!;privateBytes=readPrivateOriginJson(inputPath);
      request=Day4OriginsRequestSchema.parse(strictJsonParse(privateBytes.toString('utf8')));
      const sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY'].map(name=>process.env[name]).filter(value=>value&&value.length>=16);
      if([privy.walletId,privy.policyId,privy.signerId,request.privy.transactions.funding.recordId,request.privy.transactions.allocation.recordId]
        .some(id=>sensitive.some(value=>id.includes(value!))))throw Error();
    }catch{throw Error('DAY4_POLICY_PROBE_CONFIGURATION_OR_PRIVATE_INPUT_INVALID');}
    compiled=compileDeploymentArtifacts();
    if(mode==='execute')store=new PolicyProbeAttemptStore(process.env.D4_POLICY_PROBE_JOURNAL!);
    provider=day4PolicyProbeProvider({...config.privy,appId:process.env.PRIVY_APP_ID!,appSecret:process.env.PRIVY_APP_SECRET!,
      authorizationPrivateKey:mode==='execute'?process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY!:''},
      {funding:request.privy.transactions.funding.recordId,allocation:request.privy.transactions.allocation.recordId},store??readonlyJournal);
    const originals=provider.origins,markedProvider:Day4PolicyProbeProvider={snapshot:provider.snapshot.bind(provider),capture:provider.capture.bind(provider),
      origins:Object.freeze({transaction:(id:string)=>{privyReadCallsAttempted++;return originals.transaction(id);},
        wallet:(id:string)=>{privyReadCallsAttempted++;return originals.wallet(id);},policy:(id:string)=>{privyReadCallsAttempted++;return originals.policy(id);}})};
    const client=createPublicClient({ccipRead:false,batch:{multicall:false},transport:http('https://testnet-rpc.monad.xyz',
      {batch:false,retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    publicRpcInspectionAttempted=true;
    const inspection=await inspectDay4PolicyProbe(request,config,compiled.artifacts,{flow:day4ChainFlowPort(client,config.flow),
      creations:day4CreationPairPort(client),provider:markedProvider,simulate:async call=>{
        simulationCallsAttempted++;
        return await client.request({method:'eth_call',params:[{from:call.executor as Hex,to:call.arbiter as Hex,value:'0x0',gas:'0x4c4b40',
          data:call.data as Hex},`0x${BigInt(call.block.number).toString(16)}`]},{retryCount:0,dedupe:false}) as Hex|undefined;
      }},{mode,beforeCapture:unchanged});
    report={status:inspection.status==='UNEXPECTED_BROADCAST'?'FAIL':'BLOCKED',reason:'DAY4_POLICY_PROBE_FIXED_OBSERVATION',inspection};
  }
}catch(error){
  const reason=error instanceof Error&&/^(?:DAY4_(?:POLICY_PROBE|ORIGINS|CREATIONS|FLOW)_[A-Z_]{1,96}|PRIVY_ORIGIN_[A-Z_]{1,96}|POLICY_PROBE_[A-Z_]{1,96}|DEPLOYMENT_[A-Z_]{1,96})$/.test(error.message)
    ?error.message:'DAY4_POLICY_PROBE_INPUT_OR_PROVIDER_INVALID';
  const blocked=/(?:UNAVAILABLE|MISSING|PENDING|NOT_FINALIZED|ATTEMPT_EXISTS|ALREADY_RESERVED|ALREADY_ATTEMPTED|CLOSED)$/.test(reason);
  report={status:blocked?'BLOCKED':'FAIL',reason};
}
try{unchanged();after=captureReleaseSource();}
catch{report={status:'FAIL',reason:'DAY4_POLICY_PROBE_SOURCE_ARTIFACT_OR_PRIVATE_INPUT_CHANGED'};}
try{
  const observed=provider?.snapshot()??{attempt:null,walletRpcAttempts:0 as const,priorAttempt:false};
  if(observed.attempt)Day4PolicyProbeAttemptSchema.parse(observed.attempt);
  if(observed.walletRpcAttempts!==0&&observed.walletRpcAttempts!==1)throw Error();
  const output={schemaVersion:1,scope:'LIVE_FIXED_ORIGINAL_ORDER_PRIVY_PROBE_NOT_D4_EXTERNAL_ACCEPTANCE',mode,startedAt,endedAt:new Date().toISOString(),
    sourceCommit:before?.sourceCommit??null,worktreeDirty,sourceObservation:{before,after},sourceStable:sameReleaseSource(before,after),
    artifactBindings:compiled?.bindings??[],...report,captureAttempt:observed.attempt,walletRpcAttempts:observed.walletRpcAttempts,priorAttempt:observed.priorAttempt,
    publicRpcInspectionAttempted,simulationCallsAttempted,privyReadCallsAttempted,
    broadcastOutcome:observed.attempt?.transactionHash?'HASH_OBSERVED':observed.walletRpcAttempts===0&&!observed.priorAttempt?'NOT_ATTEMPTED':'UNKNOWN',
    transactionsSent:observed.walletRpcAttempts===0&&!observed.priorAttempt?0:null,policyDenialVerified:false,serverRequestId:null,financialAcceptanceStatus:'BLOCKED',
    officialIntegrationVerified:false,historicalPolicyAtSendVerified:false,canPassD4:false,canExecute:false,exitCode:1};
  const bytes=Buffer.from(JSON.stringify(output,null,2)+'\n');
  const sensitive=['TYPESAFE_API_KEY','PRIVY_APP_SECRET','PRIVY_AUTHORIZATION_PRIVATE_KEY','PLANNER_API_KEY'].map(name=>process.env[name]).filter(value=>value&&value.length>=16);
  if(auditBytes('day4-policy-probe.json',bytes).length||sensitive.some(value=>bytes.includes(value!)))throw Error();
  const directory='artifacts/acceptance',path=`${directory}/day4-policy-probe.json`;mkdirSync(directory,{recursive:true});
  if(existsSync(path)){const history=`${directory}/history/${startedAt.replaceAll(':','-')}-day4-policy-probe`;mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/day4-policy-probe.json`);}
  writeFileSync(path,bytes);
  console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,mode,policyDenialVerified:false,
    publicRpcInspectionAttempted,simulationCallsAttempted,privyReadCallsAttempted,walletRpcAttempts:observed.walletRpcAttempts,
    broadcastOutcome:output.broadcastOutcome,transactionsSent:output.transactionsSent,evidence:path,exitCode:1}));
}catch{console.error('DAY4_POLICY_PROBE_EVIDENCE_WRITE_UNAVAILABLE');}
finally{store?.close();}
process.exitCode=1;
