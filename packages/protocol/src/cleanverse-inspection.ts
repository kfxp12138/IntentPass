import {encodeFunctionData,keccak256,parseAbi,type Address,type Hex} from 'viem';
import {digest,uint} from './schemas.js';
import {
  CleanverseInspectionInputSchema,CleanverseInspectionReportSchema,cleanverseInspectionIds,
  type CleanverseInspectionInput,type CleanverseInspectionPort,type CleanverseInspectionReport,
} from './cleanverse-inspection-types.js';

const abi=parseAbi([
  'function policy() view returns(address)',
  'function isRegistered(address) view returns(bool)',
  'function complianceVerify(address,address) view returns(bool)',
  'function canTransfer(address,address,address,uint256) view returns(bool)',
]);
const same=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
const account=(value:string)=>value.toLowerCase() as Address;
const word=/^0x[0-9a-fA-F]{64}$/;
const code=/^0x(?:[0-9a-fA-F]{2})+$/;
type Issue=CleanverseInspectionReport['issues'][number];
type Block=Awaited<ReturnType<CleanverseInspectionPort['block']>>;

function freeze<T>(value:T):T{
  if(value!==null&&typeof value==='object'){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validUint(value:unknown):value is bigint{return typeof value==='bigint'&&uint.safeParse(String(value)).success;}
function blockKind(value:Block):'VALID'|'UNAVAILABLE'|'INVALID'{
  if(!value||typeof value!=='object'||!validUint(value.timestamp)
    ||value.number!==null&&!validUint(value.number)
    ||value.hash!==null&&!digest.safeParse(value.hash).success)return 'INVALID';
  return value.number===null||value.hash===null?'UNAVAILABLE':'VALID';
}
function canonicalValue(id:typeof cleanverseInspectionIds[number],raw:unknown):string|boolean|null{
  if(typeof raw!=='string'||!word.test(raw))return null;
  if(id==='ASSET_POLICY'){
    if(!/^0x0{24}/i.test(raw)||BigInt(raw)===0n)return null;
    return ('0x'+raw.slice(-40)).toLowerCase();
  }
  const value=BigInt(raw);
  return value===0n?false:value===1n?true:null;
}

/** Fixed, read-only official-interface observations. A configured address is not
 * proof of official provenance, identity, custody approval or an actual transfer.
 */
export async function inspectCleanverseEligibility(input:unknown,port:CleanverseInspectionPort):Promise<CleanverseInspectionReport>{
  let saved:CleanverseInspectionInput;
  try{saved=freeze(structuredClone(CleanverseInspectionInputSchema.parse(input)));}
  catch{throw Error('CLEANVERSE_INSPECTION_INPUT_INVALID');}
  // All original input and query bytes are fixed before the first asynchronous read.
  const {config:c,request:r}=saved;
  const queries=freeze([
    {id:cleanverseInspectionIds[0],target:c.asset,data:encodeFunctionData({abi,functionName:'policy'})},
    {id:cleanverseInspectionIds[1],target:c.validator,data:encodeFunctionData({abi,functionName:'isRegistered',args:[account(c.pool)]})},
    {id:cleanverseInspectionIds[2],target:c.validator,data:encodeFunctionData({abi,functionName:'complianceVerify',args:[account(c.pool),account(r.from)]})},
    {id:cleanverseInspectionIds[3],target:c.validator,data:encodeFunctionData({abi,functionName:'complianceVerify',args:[account(c.pool),account(r.to)]})},
    {id:cleanverseInspectionIds[4],target:c.policy,data:encodeFunctionData({abi,functionName:'canTransfer',args:[account(c.asset),account(r.from),account(r.to),BigInt(r.amount)]})},
  ]);
  const report:CleanverseInspectionReport={schemaVersion:1,scope:'FINALIZED_CONFIGURED_CLEANVERSE_INTERFACE_QUERIES_ONLY',
    input:saved,status:'BLOCKED',eligibility:'UNAVAILABLE',block:null,
    dependencies:(['asset','validator','policy'] as const).map(role=>({role,address:c[role],status:'UNAVAILABLE',codeHash:null})),
    observations:queries.map(query=>({id:query.id,target:query.target,calldataHash:keccak256(query.data),
      status:'NOT_ATTEMPTED',value:null,returnData:null,reason:'PREREQUISITE_UNAVAILABLE'})),
    policyLinked:null,snapshotVerified:false,falseChecks:[],issues:[],canExecute:false,signaturesRequested:0,transactionsSent:0,officialIntegrationVerified:false};
  let failed=false,blocked=false;
  const issue=(value:Issue,status:'FAIL'|'BLOCKED')=>{
    if(!report.issues.includes(value))report.issues.push(value);
    if(status==='FAIL')failed=true;else blocked=true;
  };
  const finish=()=>{
    const policy=report.observations[0];
    report.policyLinked=policy.status==='RETURNED'&&typeof policy.value==='string'?same(policy.value,c.policy):null;
    report.falseChecks=report.observations.flatMap(observation=>observation.id!=='ASSET_POLICY'&&observation.status==='RETURNED'&&observation.value===false?[observation.id]:[]);
    const complete=!failed&&!blocked&&report.snapshotVerified&&report.policyLinked===true
      &&report.dependencies.every(dependency=>dependency.status==='AVAILABLE')&&report.observations.every(observation=>observation.status==='RETURNED');
    report.status=failed?'FAIL':complete?'COMPLETE':'BLOCKED';
    report.eligibility=complete?(report.falseChecks.length?'DENIED':'ALLOWED'):'UNAVAILABLE';
    return freeze(CleanverseInspectionReportSchema.parse(report));
  };
  if(port.blockTag!=='finalized'){issue('FINALIZED_PORT_REQUIRED','FAIL');return finish();}
  // Capture the read operations rather than accepting replacement methods mid-run.
  const reads=Object.freeze({chainId:port.chainId.bind(port),block:port.block.bind(port),code:port.code.bind(port),call:port.call.bind(port)});
  let chain:number;
  try{chain=await reads.chainId();}catch{issue('CHAIN_UNAVAILABLE','BLOCKED');return finish();}
  if(chain!==10143){issue('CHAIN_MISMATCH','FAIL');return finish();}
  let first:Block;
  try{first=await reads.block();}catch{issue('FINALIZED_BLOCK_UNAVAILABLE','BLOCKED');return finish();}
  const kind=blockKind(first);
  if(kind!=='VALID'){issue(kind==='INVALID'?'FINALIZED_BLOCK_INVALID':'FINALIZED_BLOCK_UNAVAILABLE',kind==='INVALID'?'FAIL':'BLOCKED');return finish();}
  // The provider may mutate its own block object after resolving a read.
  const initial=Object.freeze({number:first.number!,hash:first.hash!.toLowerCase() as Hex,timestamp:first.timestamp});
  report.block={number:String(initial.number),hash:initial.hash,timestamp:String(initial.timestamp),finality:'finalized'};
  const codes=await Promise.allSettled(report.dependencies.map(dependency=>Promise.resolve().then(()=>reads.code(account(dependency.address),initial.number))));
  for(let index=0;index<codes.length;index++){
    const dependency=report.dependencies[index],result=codes[index];
    if(result.status==='rejected'){issue('DEPENDENCY_CODE_UNAVAILABLE','BLOCKED');continue;}
    if(result.value===undefined||result.value==='0x'){dependency.status='MISSING';issue('DEPENDENCY_CODE_MISSING','BLOCKED');continue;}
    if(typeof result.value!=='string'||!code.test(result.value)){dependency.status='NONCANONICAL';issue('DEPENDENCY_CODE_NONCANONICAL','FAIL');continue;}
    dependency.status='AVAILABLE';dependency.codeHash=keccak256(result.value);
  }
  if(report.dependencies.every(dependency=>dependency.status==='AVAILABLE')){
    const results=await Promise.allSettled(queries.map(query=>Promise.resolve().then(()=>reads.call(Object.freeze({to:account(query.target),data:query.data,blockNumber:initial.number})))));
    for(let index=0;index<results.length;index++){
      const observation=report.observations[index],result=results[index];
      if(result.status==='rejected'||result.value===undefined){
        observation.status='UNAVAILABLE';observation.reason='QUERY_UNAVAILABLE';issue('QUERY_UNAVAILABLE','BLOCKED');continue;
      }
      const value=canonicalValue(observation.id,result.value);
      if(value===null){observation.status='NONCANONICAL';observation.reason='QUERY_NONCANONICAL';issue('QUERY_NONCANONICAL','FAIL');continue;}
      observation.status='RETURNED';observation.reason=null;observation.value=value;observation.returnData=result.value.toLowerCase();
      if(observation.id==='ASSET_POLICY'&&typeof value==='string'&&!same(value,c.policy))issue('ASSET_POLICY_MISMATCH','FAIL');
    }
  }
  const ending=await Promise.allSettled([Promise.resolve().then(()=>reads.block(initial.number)),Promise.resolve().then(()=>reads.chainId())]);
  let stable=true;
  if(port.blockTag!=='finalized'){issue('FINALIZED_PORT_REQUIRED','FAIL');stable=false;}
  const endBlock=ending[0],endChain=ending[1];
  if(endBlock.status==='rejected'||endChain.status==='rejected'){issue('SNAPSHOT_UNAVAILABLE','BLOCKED');stable=false;}
  if(endChain.status==='fulfilled'&&endChain.value!==10143){issue('SNAPSHOT_CHANGED','FAIL');stable=false;}
  if(endBlock.status==='fulfilled'){
    const endKind=blockKind(endBlock.value);
    if(endKind==='INVALID'){issue('FINALIZED_BLOCK_INVALID','FAIL');stable=false;}
    else if(endKind==='UNAVAILABLE'){issue('SNAPSHOT_UNAVAILABLE','BLOCKED');stable=false;}
    else if(endBlock.value.number!==initial.number||!same(endBlock.value.hash!,initial.hash)||endBlock.value.timestamp!==initial.timestamp){issue('SNAPSHOT_CHANGED','FAIL');stable=false;}
  }
  report.snapshotVerified=stable;
  return finish();
}
