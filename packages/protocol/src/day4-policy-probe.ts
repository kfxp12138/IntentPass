import {isDeepStrictEqual} from 'node:util';
import {encodeFunctionData,keccak256,type Hex} from 'viem';
import {Day4OriginsRequestSchema,Day4CreationPairConfigSchema,PrivyOriginConfigSchema,type Day4CreationPairPort,
  type Day4CreationPairConfig,type PrivyOriginConfig} from './day4-origin-types.js';
import {Day4ChainFlowDeploymentSchema,Day4ChainBlockSchema,type Day4ChainFlowPort,type Day4ChainFlowDeployment} from './day4-chain-flow-types.js';
import {inspectDay4Origins} from './day4-origins.js';
import {inspectPrivyOrigin} from '../../adapters/src/privy-origin.js';
import {escrowAbi} from './escrow-abi.js';
import {Day4PolicyProbeCallSchema,Day4PolicyProbeProofSchema,Day4PolicyProbeAttemptSchema,day4PolicyProbeOrderResult,
  type Day4PolicyProbeCall,type Day4PolicyProbeProvider,type Day4PolicyProbeProof} from './day4-policy-probe-types.js';

function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const fail=(code:string):never=>{throw Error('DAY4_POLICY_PROBE_'+code);};
const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export interface Day4PolicyProbePorts{
  flow:Day4ChainFlowPort;creations:Day4CreationPairPort;provider:Day4PolicyProbeProvider;
  simulate(call:Day4PolicyProbeCall):Promise<Hex|undefined>;
}
/** Prepare is read-only. Execute is a dedicated, permanently single-attempt
 * negative probe; its response cannot be classified as policy denial yet. */
export async function inspectDay4PolicyProbe(input:unknown,
  configInput:{flow:Day4ChainFlowDeployment;creations:Day4CreationPairConfig;privy:PrivyOriginConfig},
  artifactsInput:{gate:unknown;escrow:unknown},portsInput:Day4PolicyProbePorts,
  options:{mode:'prepare'|'execute';beforeCapture?:()=>void}):Promise<Day4PolicyProbeProof>{
  let request,config,artifacts,ports,mode,beforeCapture,originalFlow,originalCreations;
  try{
    request=freeze(Day4OriginsRequestSchema.parse(structuredClone(input)));
    config=freeze({flow:Day4ChainFlowDeploymentSchema.parse(structuredClone(configInput.flow)),
      creations:Day4CreationPairConfigSchema.parse(structuredClone(configInput.creations)),privy:PrivyOriginConfigSchema.parse(structuredClone(configInput.privy))});
    artifacts=freeze(structuredClone(artifactsInput));
    mode=options.mode;beforeCapture=options.beforeCapture;
    if(!['prepare','execute'].includes(mode)||beforeCapture!==undefined&&typeof beforeCapture!=='function')return fail('INPUT_INVALID');
    const f=portsInput.flow,c=portsInput.creations,p=portsInput.provider,r=p.origins;
    originalFlow=f;originalCreations=c;
    ports=Object.freeze({flow:Object.freeze({blockTag:f.blockTag,chainId:f.chainId.bind(f),block:f.block.bind(f),transaction:f.transaction.bind(f),
      receipt:f.receipt.bind(f),orderAt:f.orderAt.bind(f),balance:f.balance.bind(f)}),
      creations:Object.freeze({blockTag:c.blockTag,chainId:c.chainId.bind(c),block:c.block.bind(c),transaction:c.transaction.bind(c),receipt:c.receipt.bind(c),
        code:c.code.bind(c),gateConfiguration:c.gateConfiguration.bind(c),escrowConfiguration:c.escrowConfiguration.bind(c)}),
      provider:Object.freeze({origins:Object.freeze({wallet:r.wallet.bind(r),policy:r.policy.bind(r),transaction:r.transaction.bind(r)}),
        capture:p.capture.bind(p),snapshot:p.snapshot.bind(p)}),simulate:portsInput.simulate.bind(portsInput)});
  }catch{return fail('INPUT_INVALID');}
  const origins=await inspectDay4Origins(request,config,artifacts,{flow:ports.flow,creations:ports.creations,privy:ports.provider.origins});
  const call=freeze(Day4PolicyProbeCallSchema.parse({chainId:'10143',walletId:config.privy.walletId,policyId:config.privy.policyId,signerId:config.privy.signerId,
    executor:config.flow.executor,arbiter:origins.flow.arbiter,orderId:origins.orderId,contextHash:origins.contextHash,block:origins.flow.finalizedAnchor,
    data:encodeFunctionData({abi:escrowAbi,functionName:'orders',args:[origins.orderId as Hex]}),value:'0',gas:'5000000'}));
  let result;
  try{result=await ports.simulate(call);}catch{return fail('SIMULATION_UNAVAILABLE');}
  const expectedReturn=day4PolicyProbeOrderResult(origins.flow.finalOrder);
  if(typeof result!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)||!equal(result,expectedReturn))return fail('SIMULATION_MISMATCH');
  // The fixed historical call has succeeded independently before any wallet RPC.
  const readBlock=(b:Awaited<ReturnType<Day4ChainFlowPort['block']>>)=>{
    if(typeof b?.number!=='bigint'||typeof b.timestamp!=='bigint')return fail('SNAPSHOT_CHANGED');
    const parsed=Day4ChainBlockSchema.safeParse({number:String(b.number),hash:b.hash,timestamp:String(b.timestamp)});
    if(!parsed.success)return fail('SNAPSHOT_CHANGED');return parsed.data;
  };
  const observedTips=new Map<Day4ChainFlowPort|Day4CreationPairPort,ReturnType<typeof readBlock>>();
  const checkChain=async()=>{
    for(const port of [ports.flow,ports.creations]){
      if(port.blockTag!=='finalized'||await port.chainId()!==10143)return fail('SNAPSHOT_CHANGED');
      const tip=readBlock(await port.block());if(BigInt(tip.number)<BigInt(call.block.number))return fail('FINALITY_UNAVAILABLE');
      if(!observedTips.has(port))observedTips.set(port,tip);
      const firstTip=observedTips.get(port)!;
      if(!isDeepStrictEqual(readBlock(await port.block(BigInt(firstTip.number))),firstTip))return fail('SNAPSHOT_CHANGED');
      const blocks=[origins.flow.finalizedAnchor,origins.creations.gate.receiptBlock,origins.creations.escrow.receiptBlock,
        ...Object.values(origins.flow.transactions).map(value=>value.block),
        ...Object.values(origins.flow.balanceObservations).flatMap(value=>[value.before,value.after])];
      for(const block of blocks){
        const b=readBlock(await port.block(BigInt(block.number)));
        if(b.number!==block.number||!equal(b.hash,block.hash)||b.timestamp!==block.timestamp)return fail('SNAPSHOT_CHANGED');
      }
    }
    if(originalFlow.blockTag!=='finalized'||originalCreations.blockTag!=='finalized')return fail('SNAPSHOT_CHANGED');
  };
  await checkChain();
  // Read the same current effective policy immediately before the optional POST.
  const policyBefore=await inspectPrivyOrigin(request.privy,config.privy,ports.provider.origins);
  const policyFields=(p:typeof policyBefore)=>({walletId:p.walletId,policyId:p.policyId,executor:p.executor,arbiter:p.arbiter,
    signerId:p.signerId,signerRole:p.signerRole,policyRulesHash:p.policyRulesHash,records:p.records});
  if(!isDeepStrictEqual(policyFields(origins.privy),policyFields(policyBefore)))return fail('CURRENT_POLICY_CHANGED');
  let capture:Awaited<ReturnType<Day4PolicyProbeProvider['capture']>>|null=null;
  if(mode==='execute'){
    beforeCapture?.();
    capture=await ports.provider.capture(call);
    try{capture=freeze({attempt:Day4PolicyProbeAttemptSchema.parse(structuredClone(capture.attempt)),walletRpcAttempts:capture.walletRpcAttempts});}
    catch{return fail('CAPTURE_INVALID');}
  }
  const policyAfter=await inspectPrivyOrigin(request.privy,config.privy,ports.provider.origins);
  if(!isDeepStrictEqual(policyFields(policyBefore),policyFields(policyAfter)))return fail('CURRENT_POLICY_CHANGED');
  await checkChain();
  const status=capture===null?'READY':capture.attempt.status==='UNEXPECTED_BROADCAST'?'UNEXPECTED_BROADCAST':
    capture.attempt.status==='HTTP_CAPTURED'?'CAPTURED_UNCLASSIFIED':'OUTCOME_UNKNOWN';
  try{return freeze(Day4PolicyProbeProofSchema.parse({schemaVersion:1,
    scope:'FIXED_ORIGINAL_ORDER_VIEW_AND_SINGLE_PRIVY_RESPONSE_CAPTURE_NOT_CONFIRMED_POLICY_DENIAL',status,origins,call,
    simulationReturnHash:keccak256(expectedReturn),originalOrderViewVerified:true,currentWalletPolicyStable:true,snapshotVerified:true,
    attempt:capture?.attempt??null,walletRpcAttempts:capture?.walletRpcAttempts??0,
    broadcastOutcome:capture?.walletRpcAttempts===1?(status==='UNEXPECTED_BROADCAST'?'HASH_OBSERVED':'UNKNOWN'):'NOT_ATTEMPTED',
    transactionsSent:capture?.walletRpcAttempts===1?null:0,policyDenialVerified:false,serverRequestId:null,historicalPolicyAtSendVerified:false,
    officialIntegrationVerified:false,financialAcceptanceStatus:'BLOCKED',canPassD4:false,canExecute:false,limits:[
      'The successful eth_call observes the original order at the configured canonical finalized anchor, not Privy internal simulation or its policy at send time.',
      'Current effective policy and original provider records are checked before and after; changes outside this observation window are not excluded.',
      'No documented wallet RPC error JSON field/status/server-request-ID mapping is available. Captured responses are unclassified and cannot pass D4-04.',
      'A forwarded wallet RPC may sign or broadcast even if its response is missing. Unknown outcomes never assert zero transactions or unlock a retry.',
      'The single-attempt lock is scoped to the configured private journal. Original HTTP bytes/headers and credentials are never included in this public proof.'
    ]}));}catch{return fail('PROOF_BINDING_INVALID');}
}
