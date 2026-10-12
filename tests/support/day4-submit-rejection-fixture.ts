import {concatHex,decodeFunctionData,encodeAbiParameters,getContractAddress,parseAbi,type Address,type Hex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {originalAuthorizationFixture,readTestAddress as a,readTestHash as h} from './original-authorization.js';
import {AuthorizationPayloadSchema} from '../../packages/capsule/src/format.js';
import {compileGrant,contextHash,preparationHash,receiptTypedData,grantTypedData} from '../../packages/protocol/src/index.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA} from '../../packages/protocol/src/escrow.js';
import {deploymentDraft} from '../../packages/protocol/src/deployment.js';
import {escrowAbi} from '../../packages/protocol/src/escrow-abi.js';
import {inspectDay4SubmitRejections} from '../../packages/protocol/src/day4-submit-rejections.js';
import {Day4SubmitRejectionConfigSchema,day4SubmitExpectedReverts,type Day4SubmitRejectionRequest,type Day4SubmitRejectionPort,
  type Day4SubmitObservation,type Day4SubmitCallOutcome} from '../../packages/protocol/src/day4-submit-rejection-types.js';

const word=(value:string)=>value.slice(2).padStart(64,'0');
const qualifierAbi=parseAbi(['function policy() view returns(address)','function isRegistered(address) view returns(bool)',
  'function complianceVerify(address,address) view returns(bool)','function canTransfer(address,address,address,uint256) view returns(bool)']);
/** All roles, signatures, code, RPC and asset responses are local synthetic
 * doubles; this helper never attests a real identity, deployment or D4 pass. */
export async function day4SubmitRejectionFixture(){
  const deployer=a(10),gate=getContractAddress({from:deployer,nonce:2n}),pool=getContractAddress({from:deployer,nonce:3n});
  const original=await originalAuthorizationFixture('10143',{arbiter:pool}),otherBuyer=privateKeyToAccount(generatePrivateKey()),allowed=original.payload;
  const intent={...allowed.intent,orderId:h(444),buyer:otherBuyer.address};
  const {signature:_signature,...originalReceipt}=allowed.receipt,unsignedReceipt={...originalReceipt,contextHash:contextHash(intent)};
  const receipt={...unsignedReceipt,signature:await original.reviewer.signTypedData(receiptTypedData(unsignedReceipt,{chainId:original.deployment.chainId,arbiter:original.deployment.arbiter}))};
  const grant=await compileGrant({policy:allowed.policy,intent,quote:allowed.quote,receipt,deployment:original.deployment,
    authenticatedOwner:otherBuyer.address,executor:original.deployment.executor,nonce:'0',deadline:'1700',now:1000n});
  const denied=AuthorizationPayloadSchema.parse({...allowed,intent,receipt,grant,ownerSignature:await otherBuyer.signTypedData(grantTypedData(grant)),
    preparationHash:preparationHash(contextHash(intent),intent.committeeHash)});
  const config=Day4SubmitRejectionConfigSchema.parse({chainId:'10143',deployer,asset:original.deployment.asset,validator:a(4),policy:a(5),gate,pool,
    reviewer:original.deployment.reviewer,committee:original.deployment.committee,gateNonce:'2',executor:original.deployment.executor});
  const fixed=structuredClone(config),allowedContext=allowed.grant.contextHash,request:Day4SubmitRejectionRequest={schemaVersion:1,blockNumber:'30',
    creations:{schemaVersion:1,gateTransaction:h(101),escrowTransaction:h(102)},allowedAuthorization:allowed,ineligibleAuthorization:denied};
  const runtimeTemplate={object:'0x6000'+'0'.repeat(320),linkReferences:{},immutableReferences:{one:[{start:2,length:32},{start:130,length:32}],
    two:[{start:34,length:32}],three:[{start:66,length:32}],four:[{start:98,length:32}]}};
  const artifacts={gate:{abi:[{type:'constructor',stateMutability:'nonpayable',inputs:Array.from({length:4},()=>({type:'address'}))}],
    bytecode:{object:'0x60006000',linkReferences:{}},deployedBytecode:structuredClone(runtimeTemplate)},
    escrow:{abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],
      bytecode:{object:'0x60016000',linkReferences:{}},deployedBytecode:structuredClone(runtimeTemplate)}};
  const draft=deploymentDraft({chainId:fixed.chainId,deployer:fixed.deployer,asset:fixed.asset,gate:fixed.gate,reviewer:fixed.reviewer,committee:fixed.committee},artifacts.escrow);
  const gateData=concatHex([artifacts.gate.bytecode.object as Hex,encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],
    [fixed.asset as Address,fixed.validator as Address,fixed.policy as Address,fixed.pool as Address])]);
  const transactions={gate:{hash:h(101),from:deployer,to:null,input:gateData,value:0n,nonce:2,chainId:10143,blockNumber:20n,blockHash:h(20),transactionIndex:0},
    escrow:{hash:h(102),from:deployer,to:null,input:draft.transaction.data,value:0n,nonce:3,chainId:10143,blockNumber:21n,blockHash:h(21),transactionIndex:0}};
  const receipts={gate:{transactionHash:h(101),from:deployer,to:null,status:'success' as const,contractAddress:gate,blockNumber:20n,blockHash:h(20),transactionIndex:0},
    escrow:{transactionHash:h(102),from:deployer,to:null,status:'success' as const,contractAddress:pool,blockNumber:21n,blockHash:h(21),transactionIndex:0}};
  const runtime={gate:('0x6000'+[fixed.asset,fixed.validator,fixed.policy,fixed.pool,fixed.asset].map(word).join('')) as Hex,
    escrow:('0x6000'+[fixed.asset,fixed.gate,fixed.reviewer,draft.committeeHash,fixed.asset].map(word).join('')) as Hex};
  const calls={blocks:[] as (bigint|undefined)[],code:[] as {target:Address;number:bigint}[],getters:[] as {role:string;number:bigint}[],
    queries:[] as Parameters<Day4SubmitRejectionPort['query']>[0][],submits:[] as (Parameters<Day4SubmitRejectionPort['submitCall']>[0]&{id:Day4SubmitObservation['id']})[]};
  const controls={chain:10143,tip:40n,poolRegistered:true,allowedCompliant:true,deniedCompliant:false,custodyCompliant:true,policyAllows:true,
    queryOverride:undefined as undefined|((input:Parameters<Day4SubmitRejectionPort['query']>[0])=>Hex|undefined),
    blockHook:undefined as undefined|((number:bigint|undefined,result:{number:bigint;hash:Hex;timestamp:bigint})=>void),
    submitHook:undefined as undefined|((id:Day4SubmitObservation['id'],input:Parameters<Day4SubmitRejectionPort['submitCall']>[0])=>unknown),
    submitError:null as unknown};
  const port:Day4SubmitRejectionPort={blockTag:'finalized',chainId:async()=>controls.chain,
    block:async number=>{calls.blocks.push(number);const n=number??controls.tip,result={number:n,hash:h(Number(n)),timestamp:1000n+n*10n};controls.blockHook?.(number,result);return result;},
    transaction:async hash=>hash===h(101)?transactions.gate:transactions.escrow,receipt:async hash=>hash===h(101)?receipts.gate:receipts.escrow,
    code:async(target,number)=>{calls.code.push({target,number});return target.toLowerCase()===fixed.gate.toLowerCase()?runtime.gate:target.toLowerCase()===fixed.pool.toLowerCase()?runtime.escrow:'0x6000';},
    gateConfiguration:async(_target,number)=>{calls.getters.push({role:'gate',number});return {asset:fixed.asset,validator:fixed.validator,policy:fixed.policy,pool:fixed.pool};},
    escrowConfiguration:async(_target,number)=>{calls.getters.push({role:'escrow',number});return {asset:fixed.asset,gate:fixed.gate,reviewer:fixed.reviewer,committee:[...fixed.committee],
      committeeHash:draft.committeeHash,allocationPolicy:ALLOCATION_POLICY,releasePolicy:RELEASE_POLICY,deliverySchema:DELIVERY_SCHEMA};},
    query:async input=>{calls.queries.push({...input});if(controls.queryOverride)return controls.queryOverride(input);
      const decoded=decodeFunctionData({abi:qualifierAbi,data:input.data});
      if(decoded.functionName==='policy')return ('0x'+word(fixed.policy)) as Hex;
      const permitted=decoded.functionName==='isRegistered'?controls.poolRegistered:decoded.functionName==='canTransfer'?controls.policyAllows:
        decoded.args[1].toLowerCase()===fixed.pool.toLowerCase()?controls.custodyCompliant:
          decoded.args[1].toLowerCase()===otherBuyer.address.toLowerCase()?controls.deniedCompliant:controls.allowedCompliant;
      return ('0x'+(permitted?'1':'0').padStart(64,'0')) as Hex;
    },
    submitCall:async input=>{
      const decoded=decodeFunctionData({abi:escrowAbi,data:input.data});if(decoded.functionName!=='submit')throw Error('SYNTHETIC_FIXED_SUBMIT_ONLY');
      const [envelope,receipt,,,_ownerSignature]=decoded.args;
      const id:Day4SubmitObservation['id']=envelope.buyer.toLowerCase()===otherBuyer.address.toLowerCase()?'INELIGIBLE_SUBMIT':
        _ownerSignature==='0x'+'00'.repeat(65)?'OWNER_SIGNATURE_TAMPER':receipt.contextHash.toLowerCase()!==allowedContext.toLowerCase()?'RECEIPT_CONTEXT_TAMPER':'ALLOWED_SUBMIT';
      calls.submits.push({...input,id});if(controls.submitError)throw controls.submitError;
      if(controls.submitHook)return controls.submitHook(id,input) as Day4SubmitCallOutcome;
      return id==='ALLOWED_SUBMIT'?{status:'SUCCESS',returnData:'0x'}:{status:'REVERT',revertData:day4SubmitExpectedReverts[id],rpcCode:3};
    },
  };
  return {original,otherBuyer,request,config,artifacts,port,calls,controls,transactions,receipts,runtime,
    run:()=>inspectDay4SubmitRejections(request,config,artifacts,port)};
}
export type Day4SubmitRejectionFixture=Awaited<ReturnType<typeof day4SubmitRejectionFixture>>;
