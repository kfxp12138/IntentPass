import {z} from 'zod';
import {keccak256,type Address,type Hex} from 'viem';
import {verifyOriginalAuthorization} from '../../capsule/src/recovery.js';
import {fundingCalldata} from './funding.js';
import {digest,uint} from './schemas.js';
import {inspectDay4CreationPair} from './day4-creation-pair.js';
import {inspectCleanverseEligibility} from './cleanverse-inspection.js';
import type {CleanverseInspectionReport} from './cleanverse-inspection-types.js';
import {Day4SubmitRejectionConfigSchema,Day4SubmitRejectionRequestSchema,Day4SubmitRejectionProofSchema,
  day4SubmitGas,day4SubmitExpectedReverts,day4SubmitObservationIds,type Day4SubmitRejectionPort,
  type Day4SubmitObservation,type Day4SubmitRejectionProof,type Day4SubmitRejectionRequest} from './day4-submit-rejection-types.js';
import type {Day4CreationPairPort} from './day4-origin-types.js';

const same=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
const bytes=z.string().max(131074).regex(/^0x(?:[a-fA-F0-9]{2})*$/);
const outcomeSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('SUCCESS'),returnData:bytes}).strict(),
  z.object({status:z.literal('REVERT'),revertData:bytes,rpcCode:z.literal(3)}).strict(),
  z.object({status:z.literal('UNAVAILABLE'),reason:z.enum(['RPC_UNAVAILABLE','REVERT_BYTES_UNAVAILABLE'])}).strict(),
]);
function freeze<T>(value:T,seen=new WeakSet<object>()):T{
  if(value!==null&&typeof value==='object'&&!seen.has(value)){
    seen.add(value);Object.values(value).forEach(child=>freeze(child,seen));Object.freeze(value);
  }return value;
}
const fail=(code:string):never=>{throw Error('DAY4_SUBMIT_'+code);};
function block(input:unknown){
  const value=input as {number?:unknown;hash?:unknown;timestamp?:unknown}|null;
  if(value==null||typeof value==='object'&&value.number===null&&value.hash===null)return fail('BLOCK_UNAVAILABLE');
  if(!value||typeof value.number!=='bigint'||!uint.safeParse(String(value.number)).success
    ||typeof value.timestamp!=='bigint'||!uint.safeParse(String(value.timestamp)).success||!digest.safeParse(value.hash).success)return fail('BLOCK_INVALID');
  return freeze({number:value.number,hash:(value.hash as Hex).toLowerCase() as Hex,timestamp:value.timestamp});
}
type Block=ReturnType<typeof block>;
const equalBlock=(left:Block,right:Block)=>left.number===right.number&&same(left.hash,right.hash)&&left.timestamp===right.timestamp;
const serialize=(value:Block)=>({number:String(value.number),hash:value.hash,timestamp:String(value.timestamp)});
function empty(id:Day4SubmitObservation['id']):Day4SubmitObservation{
  return {id,status:'BLOCKED',reason:'BASELINE_UNAVAILABLE',call:null,outcome:'NOT_ATTEMPTED',returnData:null,returnDataHash:null,
    revertData:null,revertDataHash:null,rpcCode:null,qualification:null};
}

/** Original submit controls and three fixed negative calls only. No sender,
 * signer, state override, remote policy claim or complete D4 acceptance. */
export async function inspectDay4SubmitRejections(input:unknown,configInput:unknown,artifacts:{gate:unknown;escrow:unknown},port:Day4SubmitRejectionPort):Promise<Day4SubmitRejectionProof>{
  let request,config,savedArtifacts,reads;
  try{
    request=freeze(Day4SubmitRejectionRequestSchema.parse(structuredClone(input)));
    config=freeze(Day4SubmitRejectionConfigSchema.parse(structuredClone(configInput)));
    savedArtifacts=freeze(structuredClone(z.object({gate:z.unknown(),escrow:z.unknown()}).strict().parse(artifacts)));
    reads=Object.freeze({chainId:port.chainId.bind(port),block:port.block.bind(port),transaction:port.transaction.bind(port),receipt:port.receipt.bind(port),
      code:port.code.bind(port),gateConfiguration:port.gateConfiguration.bind(port),escrowConfiguration:port.escrowConfiguration.bind(port),query:port.query.bind(port),submitCall:port.submitCall.bind(port)});
  }catch{return fail('INPUT_INVALID');}
  if(port.blockTag!=='finalized')return fail('FINALIZED_PORT_REQUIRED');
  const height=BigInt(request.blockNumber),allowed=request.allowedAuthorization;
  // Fixed bytes, including both deliberate mutations, are captured before any await.
  const baselineData=fundingCalldata(allowed),ownerData=fundingCalldata({...allowed,ownerSignature:'0x'+'00'.repeat(65)});
  const receiptContext=('0x'+(BigInt(allowed.receipt.contextHash)^1n).toString(16).padStart(64,'0')) as Hex;
  const receiptData=fundingCalldata({...allowed,receipt:{...allowed.receipt,contextHash:receiptContext}});
  const {executor,...creationConfig}=config;
  const recovery={chainId:config.chainId,arbiter:config.pool,asset:config.asset,reviewer:config.reviewer,committee:config.committee,executor};
  try{await verifyOriginalAuthorization(allowed,[allowed.intent.buyer],recovery);}catch{return fail('ALLOWED_AUTHORIZATION_INVALID');}
  const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{try{return freeze(structuredClone(await operation()));}catch{return fail('READ_UNAVAILABLE');}};
  let commonFailure:string|null=null;
  const stop=(code:string):never=>{commonFailure??=code;return fail(code);};
  const chain=async()=>{if(await read(()=>reads.chainId())!==10143)return stop('CHAIN_MISMATCH');return 10143;};
  await chain();const tip=block(await read(()=>reads.block()));
  if(height>tip.number)return fail('BLOCK_NOT_FINALIZED');
  const selected=block(await read(()=>reads.block(height)));
  if(selected.number!==height||height===tip.number&&!equalBlock(selected,tip))return fail('SNAPSHOT_CHANGED');
  const observed=new Map<bigint,Block>([[tip.number,tip],[selected.number,selected]]);
  const observe=async(number?:bigint)=>{
    if(number===undefined)return selected;
    if(typeof number!=='bigint'||!uint.safeParse(String(number)).success||number>height)return stop('QUERY_INVALID');
    let current:Block;
    try{current=block(await read(()=>reads.block(number)));}
    catch(error){const code=error instanceof Error?/^DAY4_SUBMIT_([A-Z_]+)$/.exec(error.message):null;return stop(code?.[1]??'BLOCK_INVALID');}
    const previous=observed.get(number);
    if(current.number!==number)return stop('BLOCK_INVALID');
    if(previous&&!equalBlock(previous,current))return stop('SNAPSHOT_CHANGED');
    observed.set(number,current);return current;
  };
  const creationsPort:Day4CreationPairPort={blockTag:'finalized',chainId:chain,block:observe,
    transaction:hash=>read(()=>reads.transaction(hash)),receipt:hash=>read(()=>reads.receipt(hash)),code:(target,number)=>read(()=>reads.code(target,number)),
    gateConfiguration:(target,number)=>read(()=>reads.gateConfiguration(target,number)),escrowConfiguration:(target,number)=>read(()=>reads.escrowConfiguration(target,number))};
  let creations;
  try{creations=await inspectDay4CreationPair(request.creations,creationConfig,savedArtifacts,creationsPort);}
  catch(error){if(commonFailure)return fail(commonFailure);const code=error instanceof Error?/^DAY4_CREATIONS_([A-Z_]+)$/.exec(error.message):null;return fail(code?'CREATIONS_'+code[1]:'CREATIONS_INVALID');}
  const qualification=async(payload:Day4SubmitRejectionRequest['allowedAuthorization'])=>{
    await chain();
    const report=await inspectCleanverseEligibility({config:{chainId:config.chainId,asset:config.asset,validator:config.validator,policy:config.policy,pool:config.pool},
      request:{from:payload.intent.buyer,to:config.pool,amount:payload.grant.amount}},
    {blockTag:'finalized',chainId:chain,block:observe,
      code:(target,number)=>{if(number!==height)return Promise.reject(Error('LOCAL_HEIGHT_REQUIRED'));return read(()=>reads.code(target,number));},
      call:({to,data,blockNumber})=>{if(blockNumber!==height)return Promise.reject(Error('LOCAL_HEIGHT_REQUIRED'));return read(()=>reads.query({to,data,blockNumber}));}});
    if(commonFailure)return fail(commonFailure);return report;
  };
  const observations=day4SubmitObservationIds.map(empty);
  const attempt=async(observation:Day4SubmitObservation,payload:Day4SubmitRejectionRequest['allowedAuthorization'],data:Hex,qualifier:CleanverseInspectionReport)=>{
    observation.qualification=qualifier;
    observation.call={from:executor,to:config.pool,value:'0',gas:'5000000',blockNumber:request.blockNumber,
      orderId:payload.intent.orderId,contextHash:payload.grant.contextHash,calldataHash:keccak256(data)};
    let raw:unknown;
    try{raw=freeze(structuredClone(await reads.submitCall(Object.freeze({from:executor as Address,to:config.pool as Address,value:0n,gas:day4SubmitGas,data,blockNumber:height}))));}
    catch{observation.outcome='UNAVAILABLE';observation.reason='RPC_UNAVAILABLE';return;}
    const parsed=outcomeSchema.safeParse(raw);
    if(!parsed.success){observation.status='FAIL';observation.outcome='UNAVAILABLE';observation.reason='RPC_RESULT_INVALID';return;}
    const result=parsed.data;
    if(result.status==='UNAVAILABLE'){observation.outcome='UNAVAILABLE';observation.reason=result.reason;return;}
    if(result.status==='SUCCESS'){
      observation.outcome='SUCCESS';observation.returnDataHash=keccak256(result.returnData as Hex);
      if(result.returnData.toLowerCase()==='0x')observation.returnData='0x';
      if(observation.id==='ALLOWED_SUBMIT'){
        observation.status=observation.returnData==='0x'?'VERIFIED':'FAIL';observation.reason=observation.returnData==='0x'?'EXPECTED_SUCCESS':'NONEMPTY_RETURN';
      }else{observation.status='FAIL';observation.reason='UNEXPECTED_SUCCESS';}return;
    }
    observation.outcome='REVERT';observation.rpcCode=3;observation.revertDataHash=keccak256(result.revertData as Hex);
    if(observation.id==='ALLOWED_SUBMIT'){observation.reason='BASELINE_REVERTED';return;}
    const expected=day4SubmitExpectedReverts[observation.id];
    if(result.revertData.toLowerCase()===expected){observation.revertData=expected;observation.status='VERIFIED';observation.reason='EXPECTED_REVERT';}
    else{observation.status='FAIL';observation.reason='UNEXPECTED_REVERT';}
  };
  const allowedQualification=await qualification(allowed);
  if(allowedQualification.status!=='COMPLETE'){
    observations[0].qualification=allowedQualification;observations[0].reason='QUALIFICATION_UNAVAILABLE';
    observations[0].status=allowedQualification.status==='FAIL'?'FAIL':'BLOCKED';
  }else if(allowedQualification.eligibility!=='ALLOWED'){
    observations[0].qualification=allowedQualification;observations[0].reason='QUALIFICATION_NOT_ALLOWED';
  }else await attempt(observations[0],allowed,baselineData,allowedQualification);
  if(observations[0].status==='VERIFIED'){
    await attempt(observations[1],allowed,ownerData,allowedQualification);
    await attempt(observations[2],allowed,receiptData,allowedQualification);
    const negative=request.ineligibleAuthorization;
    if(!negative)observations[3].reason='INELIGIBLE_AUTHORIZATION_MISSING';
    else{
      let authorized=true;try{await verifyOriginalAuthorization(negative,[negative.intent.buyer],recovery);}catch{authorized=false;}
      const expired=BigInt(negative.intent.deliveryDeadline)<=selected.timestamp||BigInt(negative.receipt.expiresAt)<selected.timestamp
        ||BigInt(negative.grant.deadline)<selected.timestamp||BigInt(negative.quote.expiresAt)<selected.timestamp;
      if(!authorized){observations[3].status='FAIL';observations[3].reason='INELIGIBLE_AUTHORIZATION_INVALID';}
      else if(expired)observations[3].reason='INELIGIBLE_AUTHORIZATION_EXPIRED';
      else{
        const fields=['chainId','arbiter','asset','seller','payee','datasetHash','serviceTermsHash','price','bond','purchaseEvidenceCommitment','policyHash',
          'reviewer','committeeHash','threshold','deliverySchemaHash','allocationPolicyHash','intentReleasePolicyHash','pactPaymentPublicKeyHash','taskId'] as const;
        const business=fields.every(key=>typeof negative.intent[key]==='string'&&typeof allowed.intent[key]==='string'
          ?same(negative.intent[key] as string,allowed.intent[key] as string):negative.intent[key]===allowed.intent[key])
          &&!same(negative.intent.buyer,allowed.intent.buyer)&&!same(negative.intent.orderId,allowed.intent.orderId);
        if(!business){observations[3].status='FAIL';observations[3].reason='INELIGIBLE_BUSINESS_MISMATCH';}
        else{
          const denied=await qualification(negative);observations[3].qualification=denied;
          if(denied.status!=='COMPLETE'){observations[3].status=denied.status==='FAIL'?'FAIL':'BLOCKED';observations[3].reason='QUALIFICATION_UNAVAILABLE';}
          else if(denied.eligibility!=='DENIED'||denied.observations[1].value!==true||denied.observations[2].value!==false||denied.observations[3].value!==true)
            observations[3].reason='IDENTITY_DENIAL_NOT_ISOLATED';
          else await attempt(observations[3],negative,fundingCalldata(negative),denied);
        }
      }
    }
  }
  for(const [number,expected] of observed){const current=block(await read(()=>reads.block(number)));if(!equalBlock(current,expected))return fail('SNAPSHOT_CHANGED');}
  if(port.blockTag!=='finalized')return fail('FINALIZED_PORT_REQUIRED');await chain();
  const status=observations.some(observation=>observation.status==='FAIL')?'FAIL':observations.every(observation=>observation.status==='VERIFIED')?'COMPLETE':'BLOCKED';
  try{return freeze(Day4SubmitRejectionProofSchema.parse({schemaVersion:1,
    scope:'FINALIZED_FIXED_SUBMIT_CALL_REJECTION_OBSERVATIONS_NOT_TRANSACTION_OR_OFFICIAL_IDENTITY_PROVENANCE',status,config,
    finalizedTip:serialize(tip),selectedBlock:serialize(selected),creations,snapshotVerified:true,observations,
    officialIntegrationVerified:false,financialAcceptanceStatus:'BLOCKED',canExecute:false,signaturesRequested:0,transactionsSent:0,
    limits:['Only fixed submit eth_call controls and rejections at the selected finalized block are observed; no transaction is sent.',
      'Original CREATE/source-shaped runtimes and configured eligibility interfaces are checked; official deployment, person and identity provenance remain separate.',
      'Damaged authorization calls are derived only from a successful original control; the ineligible wallet supplies separate valid original role signatures.',
      'Historical block-end calls are not transaction-prestate replay and do not explain any previously submitted failed transaction.',
      'Only known four-byte expected errors are published; unexpected return/revert bytes are hashed and private signatures/calldata remain outside this report.',
      'No signing, payment, policy update, retry, state override or full D4 acceptance is available.']
  }));}catch{return fail('PROOF_INVALID');}
}
