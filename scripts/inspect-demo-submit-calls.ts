import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {randomUUID} from 'node:crypto';
import {createPublicClient,encodeFunctionData,keccak256,type Address,type Hex} from 'viem';
import {pacedHttp} from '../packages/adapters/src/paced-rpc.js';
import {configuredAssetMode} from '../packages/protocol/src/asset-mode.js';
import {Day4ChainFlowDeploymentSchema,Day4ChainFlowRequestSchema} from '../packages/protocol/src/day4-chain-flow-types.js';
import {EscrowReader,committeeHash,escrowAbi} from '../packages/protocol/src/index.js';
import {fundingCalldata} from '../packages/protocol/src/funding.js';
import {day4SubmitRejectionPort} from '../packages/protocol/src/day4-submit-rejection-port.js';
import {day4SubmitGas} from '../packages/protocol/src/day4-submit-rejection-types.js';
import {verifyOriginalAuthorization} from '../packages/capsule/src/recovery.js';
import {verifyDeploymentRuntime} from '../packages/protocol/src/deployment-proof.js';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {readPrivateOriginJson} from './private-origin-input.js';
import {strictJsonParse} from './strict-json.js';
import {captureReleaseSource,sameReleaseSource} from './release-source.js';
import {auditBytes} from './public-audit.js';
import {classifyDemoCall,type ExpectedDemoCall} from './demo-call-outcome.js';

const startedAt=new Date().toISOString(),id=randomUUID(),observations:Record<string,unknown>[]=[];
let source:ReturnType<typeof captureReleaseSource>|undefined,sourceStable=false,status:'PASS'|'FAIL'|'BLOCKED'='BLOCKED',reason='DEMO_CALL_READ_UNAVAILABLE',publicRpcInspectionAttempted=false,inspection:unknown;
try{
  if(process.argv.length!==2)throw Error('DEMO_CALL_ARGUMENT_INVALID');source=captureReleaseSource();if(existsSync('.env'))loadEnvFile('.env');
  if(configuredAssetMode(process.env)!=='demo-erc20')throw Error('DEMO_CALL_PROFILE_INVALID');if(!process.env.D4_CHAIN_FLOW_PATH)throw Error('DEMO_CALL_CONFIGURATION_MISSING');
  let request,d;
  try{request=Day4ChainFlowRequestSchema.parse(strictJsonParse(readPrivateOriginJson(process.env.D4_CHAIN_FLOW_PATH).toString('utf8')));d=Day4ChainFlowDeploymentSchema.parse({chainId:process.env.CHAIN_ID,arbiter:process.env.ARBITER_ADDRESS,asset:process.env.ASSET_ADDRESS,gate:process.env.ELIGIBILITY_GATE_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,executor:process.env.PRIVY_EXECUTOR_ADDRESS,committee:process.env.COMMITTEE_ADDRESSES?.split(',').map(s=>s.trim())});}catch{throw Error('DEMO_CALL_INPUT_INVALID');}
  const {gate,...recovery}=d;
  let p;try{p=await verifyOriginalAuthorization(request.payload,[request.payload.intent.buyer],recovery);}catch{throw Error('DEMO_CALL_ORIGINAL_AUTHORIZATION_INVALID');}
  const endpoint=new URL(process.env.MONAD_RPC_URL!);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw Error('DEMO_CALL_ENDPOINT_INVALID');
  const compilation=compileDeploymentArtifacts({assetMode:'demo-erc20'}),members=committeeHash(d.committee),data=fundingCalldata(p);
  const client=createPublicClient({ccipRead:false,transport:pacedHttp(endpoint.href,{timeout:10000,fetchOptions:{redirect:'error'}})}),port=day4SubmitRejectionPort(client);
  publicRpcInspectionAttempted=true;if(await client.getChainId()!==10143)throw Error('DEMO_CALL_CHAIN_MISMATCH');
  const tip=await client.getBlock({blockTag:'finalized'}),tx=await client.getTransaction({hash:request.transactions.funding as Hex});
  if(tip.number===null||tip.hash===null||tx.blockNumber===null||tx.blockNumber<=0n||tx.blockNumber>tip.number||tx.input.toLowerCase()!==data.toLowerCase()||tx.from.toLowerCase()!==d.executor.toLowerCase()||tx.to?.toLowerCase()!==d.arbiter.toLowerCase()||tx.chainId!==10143)throw Error('DEMO_CALL_ORIGINAL_TRANSACTION_MISMATCH');
  const height=tx.blockNumber-1n,historical=await client.getBlock({blockNumber:height});
  if(historical.number!==height||historical.hash===null)throw Error('DEMO_CALL_HISTORICAL_BLOCK_INVALID');
  const reader=new EscrowReader(client,{chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:gate as Address,reviewer:d.reviewer as Address,committeeHash:members});
  const before=await reader.readAt(p.intent.orderId,height),current=await reader.readAt(p.intent.orderId,tip.number);
  if(before.state!=='UNREGISTERED'||current.state!=='ALLOCATED_PAID'||current.credits.payee!=='0'||current.withdrawn.payee!==p.intent.price)throw Error('DEMO_CALL_ORIGINAL_STATE_MISMATCH');
  const code=await client.getCode({address:d.arbiter as Address,blockNumber:height});if(!code||code==='0x')throw Error('DEMO_CALL_RUNTIME_MISSING');
  const runtimeCodeHash=verifyDeploymentRuntime(compilation.artifacts.escrow,code,[d.asset,gate,d.reviewer,members]);
  const invalidSignature=('0x'+'00'.repeat(65)) as Hex;
  const calls:{id:string;expected:ExpectedDemoCall;from:string;data:Hex;height:bigint}[]=[
    {id:'ORIGINAL_ALLOWED_CONTROL',expected:'SUCCESS',from:d.executor,data,height},
    {id:'OWNER_SIGNATURE_INVALID',expected:'InvalidSignature()',from:d.executor,data:fundingCalldata({...p,ownerSignature:invalidSignature}),height},
    {id:'RECEIPT_SIGNATURE_INVALID',expected:'InvalidSignature()',from:d.executor,data:fundingCalldata({...p,receipt:{...p.receipt,signature:invalidSignature}}),height},
    {id:'PAYEE_TAMPERED',expected:'ContextMismatch()',from:d.executor,data:fundingCalldata({...p,intent:{...p.intent,payee:p.intent.buyer}}),height},
    {id:'ASSET_TAMPERED',expected:'ContextMismatch()',from:d.executor,data:fundingCalldata({...p,intent:{...p.intent,asset:d.arbiter}}),height},
    {id:'WRONG_EXECUTOR',expected:'WrongExecutor()',from:p.intent.buyer,data,height},
    {id:'ORIGINAL_REPLAY_USED',expected:'AlreadyConsumed()',from:d.executor,data,height:tip.number},
    {id:'REPEAT_SETTLEMENT',expected:'InvalidState()',from:d.executor,data:encodeFunctionData({abi:escrowAbi,functionName:'settle',args:[p.intent.orderId as Hex]}),height:tip.number},
    {id:'REPEAT_WITHDRAWAL',expected:'NoCredit()',from:p.intent.payee,data:encodeFunctionData({abi:escrowAbi,functionName:'withdraw',args:[p.intent.orderId as Hex]}),height:tip.number},
  ];
  for(const call of calls){
    const outcome=await port.submitCall({from:call.from as Address,to:d.arbiter as Address,value:0n,gas:day4SubmitGas,data:call.data,blockNumber:call.height}),result=classifyDemoCall(call.expected,outcome);
    observations.push({id:call.id,status:result,expected:call.expected,blockNumber:String(call.height),calldataHash:keccak256(call.data),simulatedCaller:call.from,outcome});
    if(call.id==='ORIGINAL_ALLOWED_CONTROL'&&result!=='PASS')throw Error('DEMO_CALL_BASELINE_NOT_VERIFIED');
  }
  const after=await reader.readAt(p.intent.orderId,height),currentAfter=await reader.readAt(p.intent.orderId,tip.number),hEnd=await client.getBlock({blockNumber:height}),tEnd=await client.getBlock({blockNumber:tip.number});
  if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(current)!==JSON.stringify(currentAfter)||hEnd.hash!==historical.hash||tEnd.hash!==tip.hash||await client.getChainId()!==10143)throw Error('DEMO_CALL_SNAPSHOT_CHANGED');
  compilation.assertCurrent();sourceStable=sameReleaseSource(source,captureReleaseSource());if(!sourceStable)throw Error('DEMO_CALL_SOURCE_CHANGED');
  status=observations.some(o=>o.status==='FAIL')?'FAIL':observations.some(o=>o.status==='BLOCKED')?'BLOCKED':'PASS';reason='FIXED_FINALIZED_CALL_CONTROLS_AND_REJECTIONS';
  inspection={orderId:p.intent.orderId,chainId:'10143',arbiter:d.arbiter,asset:d.asset,runtimeCodeHash,historicalBlock:{number:String(height),hash:historical.hash,timestamp:String(historical.timestamp)},finalizedAnchor:current.block,historicalState:before.state,currentState:current.state,snapshotsUnchanged:true,artifactBindings:compilation.bindings};
}catch(error){reason=error instanceof Error&&/^(?:DEMO_CALL|DEPLOYMENT)_[A-Z_]+$/.test(error.message)?error.message:'DEMO_CALL_READ_UNAVAILABLE';status=/(?:MISSING|UNAVAILABLE)$/.test(reason)||observations.some(o=>o.status==='BLOCKED')?'BLOCKED':'FAIL';}
const report={schemaVersion:1,id,startedAt,endedAt:new Date().toISOString(),scope:'FIXED_DEMO_HISTORICAL_AND_FINALIZED_ETH_CALLS_NOT_TRANSACTION_ROLLBACK_OR_PRIVY_POLICY_ACCEPTANCE',status,reason,source,sourceStable,inspection,observations,publicRpcInspectionAttempted,canExecute:false,signaturesRequested:0,transactionsSent:0,financialAcceptanceStatus:'BLOCKED',canPassD4:false,
  limits:['Historical controls are block-end simulations, not exact transaction-prestate replay or actual submitted failure evidence.','No private task evidence or raw authorization is published. Old permission is used only for historical read simulation, never renewed.','No Privy policy-denial, asset-transfer failure transaction, physical device or final release acceptance is inferred.']};
const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
if(auditBytes('demo-submit-calls.json',bytes).length){console.error('DEMO_CALL_PUBLIC_OUTPUT_UNSAFE');process.exitCode=1;}
else{mkdirSync('artifacts/acceptance/demo-submit-calls',{recursive:true});const path=`artifacts/acceptance/demo-submit-calls/${id}.json`;writeFileSync(path,bytes,{flag:'wx'});console.log(JSON.stringify({status,reason,observations:observations.map(o=>({id:o.id,status:o.status})),transactionsSent:0,financialAcceptanceStatus:'BLOCKED',evidence:path}));process.exitCode=status==='PASS'?0:1;}
