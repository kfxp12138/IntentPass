import {z} from 'zod';
import {encodeFunctionData,keccak256,parseAbi,type Address,type Hex} from 'viem';
import {address,digest,uint} from './schemas.js';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
import {Day4ChainBlockSchema} from './day4-chain-flow-types.js';
import {Day4CreationPairConfigSchema,Day4CreationPairRequestSchema,Day4CreationPairProofSchema,type Day4CreationPairPort} from './day4-origin-types.js';
import {CleanverseInspectionReportSchema} from './cleanverse-inspection-types.js';

const nonzero=address.refine(value=>!/^0x0{40}$/i.test(value));
const qualificationAbi=parseAbi(['function policy() view returns(address)','function isRegistered(address) view returns(bool)',
  'function complianceVerify(address,address) view returns(bool)','function canTransfer(address,address,address,uint256) view returns(bool)']);
export const day4SubmitGas=5_000_000n;
export const day4SubmitObservationIds=['ALLOWED_SUBMIT','OWNER_SIGNATURE_TAMPER','RECEIPT_CONTEXT_TAMPER','INELIGIBLE_SUBMIT'] as const;
export const day4SubmitExpectedReverts={OWNER_SIGNATURE_TAMPER:'0x8baa579f',RECEIPT_CONTEXT_TAMPER:'0xef6daeb0',INELIGIBLE_SUBMIT:'0x349cf84c'} as const;
export const Day4SubmitRejectionConfigSchema=Day4CreationPairConfigSchema.safeExtend({executor:nonzero});
export const Day4SubmitRejectionRequestSchema=z.object({schemaVersion:z.literal(1),blockNumber:uint,
  creations:Day4CreationPairRequestSchema,allowedAuthorization:AuthorizationPayloadSchema,
  ineligibleAuthorization:AuthorizationPayloadSchema.nullable()}).strict();
export type Day4SubmitRejectionConfig=z.infer<typeof Day4SubmitRejectionConfigSchema>;
export type Day4SubmitRejectionRequest=z.infer<typeof Day4SubmitRejectionRequestSchema>;
export type Day4SubmitCallOutcome=
  |{status:'SUCCESS';returnData:Hex}
  |{status:'REVERT';revertData:Hex;rpcCode:3}
  |{status:'UNAVAILABLE';reason:'RPC_UNAVAILABLE'|'REVERT_BYTES_UNAVAILABLE'};
export interface Day4SubmitRejectionPort extends Day4CreationPairPort{
  query(input:{to:Address;data:Hex;blockNumber:bigint}):Promise<Hex|undefined>;
  submitCall(input:{from:Address;to:Address;value:0n;gas:typeof day4SubmitGas;data:Hex;blockNumber:bigint}):Promise<Day4SubmitCallOutcome>;
}
const call=z.object({from:nonzero,to:nonzero,value:z.literal('0'),gas:z.literal('5000000'),blockNumber:uint,
  orderId:digest,contextHash:digest,calldataHash:digest}).strict();
export const Day4SubmitObservationSchema=z.object({id:z.enum(day4SubmitObservationIds),status:z.enum(['VERIFIED','BLOCKED','FAIL']),
  reason:z.enum(['EXPECTED_SUCCESS','EXPECTED_REVERT','BASELINE_UNAVAILABLE','BASELINE_REVERTED','QUALIFICATION_UNAVAILABLE',
    'QUALIFICATION_NOT_ALLOWED','INELIGIBLE_AUTHORIZATION_MISSING','INELIGIBLE_AUTHORIZATION_INVALID','INELIGIBLE_AUTHORIZATION_EXPIRED','INELIGIBLE_BUSINESS_MISMATCH',
    'IDENTITY_DENIAL_NOT_ISOLATED','RPC_UNAVAILABLE','REVERT_BYTES_UNAVAILABLE','RPC_RESULT_INVALID','UNEXPECTED_SUCCESS','UNEXPECTED_REVERT','NONEMPTY_RETURN']),
  call:call.nullable(),outcome:z.enum(['SUCCESS','REVERT','UNAVAILABLE','NOT_ATTEMPTED']),
  returnData:z.literal('0x').nullable(),returnDataHash:digest.nullable(),
  revertData:z.string().regex(/^0x[0-9a-f]{8}$/).nullable(),revertDataHash:digest.nullable(),rpcCode:z.literal(3).nullable(),
  qualification:CleanverseInspectionReportSchema.nullable()}).strict().superRefine((value,context)=>{
  const invalid=()=>context.addIssue({code:'custom',message:'SUBMIT_OBSERVATION_INCONSISTENT'});
  if(value.outcome==='NOT_ATTEMPTED'){
    if(value.call!==null||value.returnData!==null||value.returnDataHash!==null||value.revertData!==null||value.revertDataHash!==null||value.rpcCode!==null||value.status==='VERIFIED')invalid();
  }else if(value.call===null)invalid();
  if(value.outcome!=='SUCCESS'&&(value.returnData!==null||value.returnDataHash!==null))invalid();
  if(value.outcome==='SUCCESS'&&(value.returnDataHash===null||value.revertData!==null||value.revertDataHash!==null||value.rpcCode!==null))invalid();
  if(value.outcome!=='REVERT'&&(value.revertData!==null||value.revertDataHash!==null||value.rpcCode!==null))invalid();
  if(value.outcome==='REVERT'&&(value.revertDataHash===null||value.rpcCode!==3))invalid();
  if(value.returnData!==null&&value.returnDataHash!==keccak256(value.returnData))invalid();
  if(value.revertData!==null&&value.revertDataHash!==keccak256(value.revertData as Hex))invalid();
  if(value.revertData!==null&&value.reason!=='EXPECTED_REVERT')invalid();
  if(value.status==='VERIFIED'){
    if(value.id==='ALLOWED_SUBMIT'){
      if(value.outcome!=='SUCCESS'||value.returnData!=='0x'||value.reason!=='EXPECTED_SUCCESS'||value.qualification?.eligibility!=='ALLOWED')invalid();
    }else if(value.outcome!=='REVERT'||value.revertData!==day4SubmitExpectedReverts[value.id]||value.reason!=='EXPECTED_REVERT')invalid();
    if(value.qualification?.status!=='COMPLETE'||value.id!=='INELIGIBLE_SUBMIT'&&value.qualification?.eligibility!=='ALLOWED')invalid();
    if(value.id==='INELIGIBLE_SUBMIT'){
      const queries=value.qualification?.observations;
      if(value.qualification?.eligibility!=='DENIED'||queries?.[1]?.value!==true||queries?.[2]?.value!==false||queries?.[3]?.value!==true)invalid();
    }
  }
});
export const Day4SubmitRejectionProofSchema=z.object({schemaVersion:z.literal(1),
  scope:z.literal('FINALIZED_FIXED_SUBMIT_CALL_REJECTION_OBSERVATIONS_NOT_TRANSACTION_OR_OFFICIAL_IDENTITY_PROVENANCE'),
  status:z.enum(['COMPLETE','BLOCKED','FAIL']),config:Day4SubmitRejectionConfigSchema,
  finalizedTip:Day4ChainBlockSchema,selectedBlock:Day4ChainBlockSchema,creations:Day4CreationPairProofSchema,
  snapshotVerified:z.literal(true),observations:z.array(Day4SubmitObservationSchema).length(4),
  officialIntegrationVerified:z.literal(false),financialAcceptanceStatus:z.literal('BLOCKED'),canExecute:z.literal(false),
  signaturesRequested:z.literal(0),transactionsSent:z.literal(0),limits:z.array(z.string())}).strict().superRefine((value,context)=>{
  const invalid=()=>context.addIssue({code:'custom',message:'SUBMIT_REJECTION_PROOF_BINDING_INVALID'});
  const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(value.observations.length!==4)return;
  if(![value.finalizedTip.number,value.selectedBlock.number].every(number=>uint.safeParse(number).success))return;
  if(BigInt(value.selectedBlock.number)>BigInt(value.finalizedTip.number)
    ||JSON.stringify(value.creations.finalizedAnchor)!==JSON.stringify(value.selectedBlock)
    ||value.observations.some((observation,index)=>observation.id!==day4SubmitObservationIds[index]))invalid();
  const {executor,...creationConfig}=value.config;
  if(JSON.stringify(creationConfig)!==JSON.stringify(value.creations.config))invalid();
  const baseline=value.observations[0];
  const verifiedCalls=value.observations.filter(item=>item.status==='VERIFIED'&&item.call!==null).map(item=>item.call!.calldataHash.toLowerCase());
  if(new Set(verifiedCalls).size!==verifiedCalls.length)invalid();
  for(const observation of value.observations){
    if(observation.id!=='ALLOWED_SUBMIT'&&observation.status==='VERIFIED'&&baseline.status!=='VERIFIED')invalid();
    if(observation.call&&(!same(observation.call.from,executor)||!same(observation.call.to,value.config.pool)
      ||observation.call.blockNumber!==value.selectedBlock.number))invalid();
    if(observation.qualification){
      const report=observation.qualification;
      if(report.block&&(report.block.number!==value.selectedBlock.number||!same(report.block.hash,value.selectedBlock.hash)
        ||report.block.timestamp!==value.selectedBlock.timestamp)||!same(report.input.config.asset,value.config.asset)
        ||!same(report.input.config.validator,value.config.validator)||!same(report.input.config.policy,value.config.policy)
        ||!same(report.input.config.pool,value.config.pool)||!same(report.input.request.to,value.config.pool))invalid();
      const c=report.input.config,r=report.input.request;
      if(report.observations.length===5&&uint.safeParse(r.amount).success&&[c.asset,c.validator,c.policy,c.pool,r.from,r.to].every(item=>address.safeParse(item).success)){
        const expected=[encodeFunctionData({abi:qualificationAbi,functionName:'policy'}),
          encodeFunctionData({abi:qualificationAbi,functionName:'isRegistered',args:[c.pool as Address]}),
          encodeFunctionData({abi:qualificationAbi,functionName:'complianceVerify',args:[c.pool as Address,r.from as Address]}),
          encodeFunctionData({abi:qualificationAbi,functionName:'complianceVerify',args:[c.pool as Address,r.to as Address]}),
          encodeFunctionData({abi:qualificationAbi,functionName:'canTransfer',args:[c.asset as Address,r.from as Address,r.to as Address,BigInt(r.amount)]})];
        if(report.observations.some((item,index)=>item.calldataHash.toLowerCase()!==keccak256(expected[index])))invalid();
      }
    }
    if(observation.id==='INELIGIBLE_SUBMIT'&&observation.status==='VERIFIED'){
      if(!baseline.call||!observation.call||same(observation.call.orderId,baseline.call.orderId)
        ||same(observation.call.contextHash,baseline.call.contextHash)||!baseline.qualification||!observation.qualification
        ||same(observation.qualification.input.request.from,baseline.qualification.input.request.from)
        ||observation.qualification.input.request.amount!==baseline.qualification.input.request.amount)invalid();
    }
    if((observation.id==='OWNER_SIGNATURE_TAMPER'||observation.id==='RECEIPT_CONTEXT_TAMPER')&&observation.status==='VERIFIED'){
      if(baseline.status!=='VERIFIED'||!baseline.call||!observation.call||!same(observation.call.orderId,baseline.call.orderId)
        ||!same(observation.call.contextHash,baseline.call.contextHash)||same(observation.call.calldataHash,baseline.call.calldataHash)
        ||JSON.stringify(observation.qualification)!==JSON.stringify(baseline.qualification))invalid();
    }
  }
  const expected=value.observations.some(item=>item.status==='FAIL')?'FAIL':value.observations.every(item=>item.status==='VERIFIED')?'COMPLETE':'BLOCKED';
  if(value.status!==expected)invalid();
});
export type Day4SubmitObservation=z.infer<typeof Day4SubmitObservationSchema>;
export type Day4SubmitRejectionProof=z.infer<typeof Day4SubmitRejectionProofSchema>;
