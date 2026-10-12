import {z} from 'zod';
import type {Address,Hex} from 'viem';
import {address,digest,positiveUint,uint} from './schemas.js';

const nonzero=address.refine(value=>!/^0x0{40}$/i.test(value));
export const CleanverseInspectionConfigSchema=z.object({
  chainId:z.literal('10143'),asset:nonzero,validator:nonzero,policy:nonzero,pool:nonzero
}).strict();
export const CleanverseInspectionRequestSchema=z.object({from:nonzero,to:nonzero,amount:positiveUint}).strict();
export const CleanverseInspectionInputSchema=z.object({
  config:CleanverseInspectionConfigSchema,request:CleanverseInspectionRequestSchema
}).strict().superRefine(({config,request},context)=>{
  if(![request.from,request.to].some(value=>value.toLowerCase()===config.pool.toLowerCase()))
    context.addIssue({code:'custom',message:'TRANSFER_DOES_NOT_INVOLVE_CONFIGURED_POOL',path:['request']});
});
export type CleanverseInspectionInput=z.infer<typeof CleanverseInspectionInputSchema>;
export const cleanverseInspectionIds=['ASSET_POLICY','POOL_REGISTERED','FROM_COMPLIANCE','TO_COMPLIANCE','ASSET_TRANSFER_POLICY'] as const;
export const CleanverseInspectionIssueSchema=z.enum([
  'FINALIZED_PORT_REQUIRED','CHAIN_UNAVAILABLE','CHAIN_MISMATCH','FINALIZED_BLOCK_UNAVAILABLE','FINALIZED_BLOCK_INVALID',
  'DEPENDENCY_CODE_MISSING','DEPENDENCY_CODE_UNAVAILABLE','DEPENDENCY_CODE_NONCANONICAL',
  'QUERY_UNAVAILABLE','QUERY_NONCANONICAL','ASSET_POLICY_MISMATCH','SNAPSHOT_UNAVAILABLE','SNAPSHOT_CHANGED'
]);
export const CleanverseInspectionObservationSchema=z.object({
  id:z.enum(cleanverseInspectionIds),target:nonzero,calldataHash:digest,
  status:z.enum(['RETURNED','UNAVAILABLE','NONCANONICAL','NOT_ATTEMPTED']),
  value:z.union([z.boolean(),nonzero]).nullable(),
  returnData:z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
  reason:z.enum(['QUERY_UNAVAILABLE','QUERY_NONCANONICAL','PREREQUISITE_UNAVAILABLE']).nullable()
}).strict();
export const CleanverseInspectionReportSchema=z.object({
  schemaVersion:z.literal(1),scope:z.literal('FINALIZED_CONFIGURED_CLEANVERSE_INTERFACE_QUERIES_ONLY'),
  input:CleanverseInspectionInputSchema,status:z.enum(['COMPLETE','BLOCKED','FAIL']),
  eligibility:z.enum(['ALLOWED','DENIED','UNAVAILABLE']),
  block:z.object({number:uint,hash:digest,timestamp:uint,finality:z.literal('finalized')}).strict().nullable(),
  dependencies:z.array(z.object({role:z.enum(['asset','validator','policy']),address:nonzero,
    status:z.enum(['AVAILABLE','MISSING','UNAVAILABLE','NONCANONICAL']),codeHash:digest.nullable()}).strict()).length(3),
  observations:z.array(CleanverseInspectionObservationSchema).length(5),
  policyLinked:z.boolean().nullable(),snapshotVerified:z.boolean(),
  falseChecks:z.array(z.enum(['POOL_REGISTERED','FROM_COMPLIANCE','TO_COMPLIANCE','ASSET_TRANSFER_POLICY'])),
  issues:z.array(CleanverseInspectionIssueSchema),
  canExecute:z.literal(false),signaturesRequested:z.literal(0),transactionsSent:z.literal(0),officialIntegrationVerified:z.literal(false)
}).strict().superRefine((value,context)=>{
  const invalid=(message:string,path:string)=>context.addIssue({code:'custom',message,path:[path]});
  // Length errors are already recorded by zod; malformed external arrays must
  // not throw while the consistency refinement indexes the fixed observations.
  if(value.observations.length!==5||value.dependencies.length!==3)return;
  const ids=value.observations.map(observation=>observation.id);
  if(ids.some((id,index)=>id!==cleanverseInspectionIds[index]))
    context.addIssue({code:'custom',message:'FIXED_QUERY_ORDER_REQUIRED',path:['observations']});
  if(value.dependencies.some((dependency,index)=>dependency.role!==(['asset','validator','policy'] as const)[index]))
    context.addIssue({code:'custom',message:'FIXED_DEPENDENCY_ORDER_REQUIRED',path:['dependencies']});
  if(value.status==='COMPLETE' && (value.eligibility==='UNAVAILABLE'||!value.snapshotVerified||value.policyLinked!==true
    ||value.issues.length!==0||value.dependencies.some(item=>item.status!=='AVAILABLE')
    ||value.observations.some(item=>item.status!=='RETURNED')))
    context.addIssue({code:'custom',message:'COMPLETE_REQUIRES_ALL_CANONICAL_OBSERVATIONS',path:['status']});
  if(value.status!=='COMPLETE'&&value.eligibility!=='UNAVAILABLE')
    context.addIssue({code:'custom',message:'INCOMPLETE_CANNOT_ASSERT_ELIGIBILITY',path:['eligibility']});
  const config=value.input.config;
  const targets=[config.asset,config.validator,config.validator,config.validator,config.policy];
  if(value.observations.some((observation,index)=>observation.target.toLowerCase()!==targets[index].toLowerCase()))
    invalid('OBSERVATION_TARGET_MISMATCH','observations');
  if(value.dependencies.some(dependency=>dependency.address.toLowerCase()!==config[dependency.role].toLowerCase()
    ||(dependency.status==='AVAILABLE')!==(dependency.codeHash!==null)))invalid('DEPENDENCY_BINDING_MISMATCH','dependencies');
  for(const observation of value.observations){
    if(observation.status==='RETURNED'){
      if(observation.value===null||observation.returnData===null||observation.reason!==null
        ||(observation.id==='ASSET_POLICY'?typeof observation.value!=='string':typeof observation.value!=='boolean'))
        invalid('RETURNED_OBSERVATION_INVALID','observations');
      else{
        const word=BigInt(observation.returnData);
        if(observation.id==='ASSET_POLICY'?word!==BigInt(observation.value as string):word!==(observation.value?1n:0n))
          invalid('RETURNED_VALUE_MISMATCH','observations');
      }
    }else if(observation.value!==null||observation.reason===null)invalid('INCOMPLETE_OBSERVATION_INVALID','observations');
  }
  const expectedFalse=value.observations.filter(item=>item.id!=='ASSET_POLICY'&&item.status==='RETURNED'&&item.value===false).map(item=>item.id);
  if(JSON.stringify(value.falseChecks)!==JSON.stringify(expectedFalse))invalid('FALSE_CHECKS_MISMATCH','falseChecks');
  if(value.status==='COMPLETE'&&((value.eligibility==='DENIED')!==(expectedFalse.length>0)))invalid('ELIGIBILITY_MISMATCH','eligibility');
  if(value.snapshotVerified&&value.block===null)invalid('SNAPSHOT_BLOCK_REQUIRED','block');
  const policy=value.observations[0];
  const linked=policy.status==='RETURNED'&&typeof policy.value==='string'?policy.value.toLowerCase()===config.policy.toLowerCase():null;
  if(value.policyLinked!==linked)invalid('POLICY_LINK_MISMATCH','policyLinked');
});
export type CleanverseInspectionReport=z.infer<typeof CleanverseInspectionReportSchema>;
/** Only reads at one finalized block. No wallet, signature, transfer or arbitrary caller-supplied query API. */
export interface CleanverseInspectionPort{
  blockTag:'finalized';
  chainId():Promise<number>;
  block(number?:bigint):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
  code(address:Address,blockNumber:bigint):Promise<Hex|undefined>;
  call(input:{to:Address;data:Hex;blockNumber:bigint}):Promise<Hex|undefined>;
}
