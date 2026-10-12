import type {Hex} from 'viem';
import {uint,digest} from './schemas.js';
import {Day4ChainFlowDeploymentSchema,type Day4ChainFlowPort,type Day4ChainFlowDeployment} from './day4-chain-flow-types.js';
import {inspectDay4ChainFlow} from './day4-chain-flow.js';
import {Day4OriginsRequestSchema,Day4CreationPairConfigSchema,PrivyOriginConfigSchema,Day4OriginsProofSchema,
  type Day4CreationPairPort,type Day4CreationPairConfig,type PrivyOriginPort,type PrivyOriginConfig,type Day4OriginsProof} from './day4-origin-types.js';
import {inspectDay4CreationPair} from './day4-creation-pair.js';
import {inspectPrivyOrigin} from '../../adapters/src/privy-origin.js';

function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const fail=(code:string):never=>{throw Error('DAY4_ORIGINS_'+code);};
const equal=(left:unknown,right:unknown)=>typeof left==='string'&&typeof right==='string'&&left.toLowerCase()===right.toLowerCase();
function block(input:unknown){
  const b=input as {number:unknown;hash:unknown;timestamp:unknown};
  if(!b||typeof b.number!=='bigint'||typeof b.timestamp!=='bigint'||!uint.safeParse(String(b.number)).success
    ||!uint.safeParse(String(b.timestamp)).success||!digest.safeParse(b.hash).success)return fail('BLOCK_INVALID');
  return Object.freeze({number:b.number,hash:b.hash as Hex,timestamp:b.timestamp});
}
/** Assemble independent chain effects, original CREATEs and live provider associations.
 * Historical Privy policy, official qualification and full D4 remain separate gates. */
export async function inspectDay4Origins(input:unknown,configInput:{flow:Day4ChainFlowDeployment;creations:Day4CreationPairConfig;privy:PrivyOriginConfig},
  artifacts:{gate:unknown;escrow:unknown},ports:{flow:Day4ChainFlowPort;creations:Day4CreationPairPort;privy:PrivyOriginPort}):Promise<Day4OriginsProof>{
  let request,config,frozenArtifacts;
  try{request=freeze(Day4OriginsRequestSchema.parse(structuredClone(input)));config=freeze({flow:Day4ChainFlowDeploymentSchema.parse(structuredClone(configInput.flow)),
    creations:Day4CreationPairConfigSchema.parse(structuredClone(configInput.creations)),privy:PrivyOriginConfigSchema.parse(structuredClone(configInput.privy))});
    frozenArtifacts=freeze(structuredClone(artifacts));}
  catch{return fail('INPUT_INVALID');}
  const d=config.flow,c=config.creations,p=config.privy;
  if(!equal(d.arbiter,c.pool)||!equal(d.asset,c.asset)||!equal(d.gate,c.gate)||!equal(d.reviewer,c.reviewer)
    ||d.committee.some((member,index)=>!equal(member,c.committee[index]))||!equal(d.executor,p.address)||!equal(d.arbiter,p.arbiter))return fail('CONFIGURATION_MISMATCH');
  // Fix all operation references before any reader awaits.
  let original:{flow:Day4ChainFlowPort;creations:Day4CreationPairPort;privy:PrivyOriginPort};
  let flowPort:Day4ChainFlowPort,creationPort:Day4CreationPairPort,privyPort:PrivyOriginPort;
  try{original={flow:ports.flow,creations:ports.creations,privy:ports.privy};const f=original.flow,c=original.creations,p=original.privy;
    flowPort=Object.freeze({blockTag:f.blockTag,chainId:f.chainId.bind(f),block:f.block.bind(f),transaction:f.transaction.bind(f),receipt:f.receipt.bind(f),orderAt:f.orderAt.bind(f),balance:f.balance.bind(f)});
    creationPort=Object.freeze({blockTag:c.blockTag,chainId:c.chainId.bind(c),block:c.block.bind(c),transaction:c.transaction.bind(c),receipt:c.receipt.bind(c),code:c.code.bind(c),gateConfiguration:c.gateConfiguration.bind(c),escrowConfiguration:c.escrowConfiguration.bind(c)});
    privyPort=Object.freeze({transaction:p.transaction.bind(p),wallet:p.wallet.bind(p),policy:p.policy.bind(p)});
  }catch{return fail('PORT_INVALID');}
  if(flowPort.blockTag!=='finalized'||creationPort.blockTag!=='finalized')return fail('FINALIZED_REQUIRED');
  const creations=await inspectDay4CreationPair(request.creations,c,frozenArtifacts,creationPort);
  const anchor=creations.finalizedAnchor;
  const read=async<T>(operation:()=>Promise<T>)=>{try{return freeze(structuredClone(await operation()));}catch{return fail('READ_UNAVAILABLE');}};
  const readBlock=async(number?:bigint)=>{try{const actual=block(await read(()=>flowPort.block(number)));if(number!==undefined&&actual.number!==number)return fail('BLOCK_INVALID');return actual;}
    catch(error){if(error instanceof Error&&error.message==='DAY4_ORIGINS_BLOCK_INVALID')throw error;return fail('READ_UNAVAILABLE');}};
  const anchorNumber=BigInt(anchor.number);
  const anchoredFlow:Day4ChainFlowPort=Object.freeze({...flowPort,block:async(number?:bigint)=>{
    if(number!==undefined)return flowPort.block(number);
    const finalized=await readBlock();if(finalized.number<anchorNumber)return fail('FINALITY_MISMATCH');
    const b=await readBlock(anchorNumber);if(!equal(b.hash,anchor.hash)||String(b.timestamp)!==anchor.timestamp)return fail('SNAPSHOT_CHANGED');return b;
  }});
  const flow=await inspectDay4ChainFlow(request.flow,d,anchoredFlow);
  const privy=await inspectPrivyOrigin(request.privy,p,privyPort);
  // Reaffirm real finality after the external provider window, not only canonicality.
  for(const tip of [await readBlock(),block(await read(()=>creationPort.block()))]){
    if(tip.number<anchorNumber)return fail('FINALITY_MISMATCH');
    if(tip.number===anchorNumber&&(!equal(tip.hash,anchor.hash)||String(tip.timestamp)!==anchor.timestamp))return fail('SNAPSHOT_CHANGED');
  }
  // Provider reads can take time: recheck every original chain observation after them.
  const expected=[flow.finalizedAnchor,creations.gate.receiptBlock,creations.escrow.receiptBlock,
    ...Object.values(flow.transactions).map(value=>value.block),...Object.values(flow.balanceObservations).flatMap(value=>[value.before,value.after])];
  for(const b of expected){const actual=await readBlock(BigInt(b.number));if(!equal(actual.hash,b.hash)||String(actual.timestamp)!==b.timestamp)return fail('SNAPSHOT_CHANGED');}
  const pairAnchor=block(await read(()=>creationPort.block(anchorNumber)));
  const finalTags=await read(async()=>[original.flow.blockTag,original.creations.blockTag]);
  if(pairAnchor.number!==anchorNumber||!equal(pairAnchor.hash,anchor.hash)||String(pairAnchor.timestamp)!==anchor.timestamp
    ||await read(()=>flowPort.chainId())!==10143||await read(()=>creationPort.chainId())!==10143||finalTags.some(tag=>tag!=='finalized'))return fail('SNAPSHOT_CHANGED');
  try{return freeze(Day4OriginsProofSchema.parse({schemaVersion:1,scope:'FINALIZED_ORIGINAL_FLOW_CREATIONS_AND_LIVE_PRIVY_ASSOCIATIONS_NOT_FULL_D4_ACCEPTANCE',status:'ORIGINS_VERIFIED',
    chainId:'10143',orderId:flow.orderId,contextHash:flow.contextHash,flow,creations,privy,deploymentCreationVerified:true,providerTransactionRecordsVerified:true,
    currentWalletPolicyVerified:true,officialIntegrationVerified:false,historicalPolicyAtSendVerified:false,withdrawalProviderOriginVerified:false,
    financialAcceptanceStatus:'BLOCKED',canExecute:false,signaturesRequested:0,transactionsSent:0,limits:[
      'Original configured CREATEs, original finalized paid chain effects and live Privy transaction associations only; official asset/identity provenance and remaining D4 evidence still required.',
      'Both creation and paid-flow observations use the same canonical finalized anchor; all chain heights are rechecked after provider queries.',
      'Current effective policy is not historical authorization policy. Provider transaction IDs must be original saved IDs; none are generated from a hash.',
      'No claim of Privy-origin withdrawal, atomic provider/chain snapshot, trace-level balance delta, failed-transfer cause or complete D4 acceptance.'
    ]}));}catch{return fail('PROOF_BINDING_INVALID');}
}
