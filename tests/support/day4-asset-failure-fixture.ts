import {encodeFunctionData,encodeAbiParameters,encodeEventTopics,parseAbi,parseAbiParameters,type Address,type Hex} from 'viem';
import {day4OriginsFixture} from './day4-origins-fixture.js';
import {readTestHash as h} from './original-authorization.js';
import {AuthorizationPayloadSchema} from '../../packages/capsule/src/format.js';
import {contextHash,receiptTypedData,grantTypedData,compileGrant,preparationHash} from '../../packages/protocol/src/index.js';
import {Day4AssetFailureConfigSchema,Day4AssetFailureRequestSchema,type Day4AssetFailurePort,type Day4FailureTraceNode,
  type Day4FailureTransaction,type Day4FailureReceipt} from '../../packages/protocol/src/day4-asset-failure-types.js';
import {inspectDay4AssetFailures} from '../../packages/protocol/src/day4-asset-failures.js';
import {fundingCalldata} from '../../packages/protocol/src/funding.js';
import {allocationCalldata} from '../../packages/protocol/src/allocation.js';
import {withdrawalCalldata} from '../../packages/protocol/src/withdrawal.js';
import {reportDelivery} from '../../packages/protocol/src/fulfillment.js';
import {createReport} from '../../packages/protocol/src/report.js';

const abi=parseAbi(['function policy() view returns(address)','function isRegistered(address) view returns(bool)',
  'function complianceVerify(address,address) view returns(bool)','function canTransfer(address,address,address,uint256) view returns(bool)',
  'function canTransfer(address,address,address,uint256,bytes32) view returns(bool)','function balanceOf(address) view returns(uint256)',
  'function transfer(address,uint256) returns(bool)','event Funded(bytes32 indexed orderId,bytes32 contextHash,address buyer,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
export const failureWord=(n:bigint)=>encodeAbiParameters(parseAbiParameters('uint256'),[n]);
/** Entire fixture is local, signed synthetic data, never an official asset/RPC
 * deployment, real failure transaction or financial acceptance evidence. */
export async function day4AssetFailureFixture(){
  const f=await day4OriginsFixture(),x=f.authorization,p=x.payload,e=p.intent;
  const config=Day4AssetFailureConfigSchema.parse({...f.config.creations,executor:x.deployment.executor});
  const {signature:oldReceiptSignature,...receiptFields}=p.receipt;
  const intent={...e,orderId:h(902)},unsignedReceipt={...receiptFields,contextHash:contextHash(intent)};
  const receipt={...unsignedReceipt,signature:await x.reviewer.signTypedData(receiptTypedData(unsignedReceipt,{chainId:x.deployment.chainId,arbiter:x.deployment.arbiter}))};
  const grant=await compileGrant({policy:p.policy,intent,quote:p.quote,receipt,deployment:x.deployment,authenticatedOwner:e.buyer,
    executor:x.deployment.executor,nonce:'1',deadline:'1700',now:1000n});
  const refund=AuthorizationPayloadSchema.parse({...p,intent,receipt,grant,ownerSignature:await x.buyer.signTypedData(grantTypedData(grant)),
    preparationHash:preparationHash(contextHash(intent),intent.committeeHash)});
  const request=Day4AssetFailureRequestSchema.parse({schemaVersion:1,creations:f.request.creations,
    settlement:{payload:p,dataset:x.dataset,report:createReport(x.dataset),fundingTransaction:h(101),failedTransaction:h(301)},
    refund:{payload:refund,dataset:x.dataset,report:createReport(x.dataset),fundingTransaction:h(104),failedTransaction:h(302)},
    withdrawal:{payload:p,dataset:x.dataset,report:createReport(x.dataset),fundingTransaction:h(101),failedTransaction:h(303),
      beneficiary:e.payee,allocationTransaction:h(102),allocationAction:'settle'}});
  f.control.tip=250n;
  const transactions=new Map<Hex,Day4FailureTransaction>(),receipts=new Map<Hex,Day4FailureReceipt>();
  for(const hash of [h(101),h(102)] as const){
    const tx=await f.ports.flow.transaction(hash),r=await f.ports.flow.receipt(hash);
    transactions.set(hash,{...tx!,nonce:11,gas:5_000_000n});receipts.set(hash,{...r!,contractAddress:null,gasUsed:400_000n});
  }
  const block=(n:bigint)=>({number:n,hash:h(Number(n)),timestamp:1200n+10n*n});
  for(const [hash,number,from,input,status] of [[h(104),12n,config.executor,fundingCalldata(refund),'success'],
    [h(301),15n,config.executor,allocationCalldata({payload:p},'settle'),'reverted'],
    [h(302),200n,config.executor,allocationCalldata({payload:refund},'timeout'),'reverted'],
    [h(303),25n,e.payee,withdrawalCalldata({payload:p,beneficiary:e.payee}),'reverted']] as const){
    transactions.set(hash,{hash,from:from as Address,to:config.pool as Address,input,value:0n,nonce:Number(number),gas:5_000_000n,
      chainId:10143,blockNumber:number,blockHash:block(number).hash,transactionIndex:0});
    receipts.set(hash,{transactionHash:hash,from:from as Address,to:config.pool as Address,status,contractAddress:null,
      blockNumber:number,blockHash:block(number).hash,transactionIndex:0,logs:[],gasUsed:400_000n});
  }
  const rf=receipts.get(h(104))!;
  const log=(address:string,topics:readonly Hex[],data:Hex,index:number)=>({address:address as Address,topics:[...topics] as [Hex,...Hex[]],data,
    logIndex:index,removed:false,transactionIndex:0,transactionHash:h(104),blockHash:rf.blockHash,blockNumber:rf.blockNumber});
  rf.logs=[log(config.pool,encodeEventTopics({abi,eventName:'Funded',args:{orderId:refund.intent.orderId as Hex}}) as Hex[],
    encodeAbiParameters(parseAbiParameters('bytes32,address,uint256'),[refund.grant.contextHash as Hex,e.buyer as Address,15n]),0),
    log(config.asset,encodeEventTopics({abi,eventName:'Transfer',args:{from:e.buyer as Address,to:config.pool as Address}}) as Hex[],failureWord(15n),1)];
  const node=(type:Day4FailureTraceNode['type'],from:string,to:string,input:Hex,output:Hex,calls:Day4FailureTraceNode[]=[],failed=false):Day4FailureTraceNode=>
    ({type,from:from as Address,to:to as Address,value:0n,gas:200_000n,gasUsed:5000n,input,output,failed,calls});
  const gate=(actor:string,amount:bigint,context:string,deny?:1|2|3|4)=>{
    const queries=[node('STATICCALL',config.gate,config.asset,encodeFunctionData({abi,functionName:'policy'}),encodeAbiParameters(parseAbiParameters('address'),[config.policy as Address])),
      node('STATICCALL',config.gate,config.validator,encodeFunctionData({abi,functionName:'isRegistered',args:[config.pool as Address]}),failureWord(1n)),
      node('STATICCALL',config.gate,config.validator,encodeFunctionData({abi,functionName:'complianceVerify',args:[config.pool as Address,config.pool as Address]}),failureWord(1n)),
      node('STATICCALL',config.gate,config.validator,encodeFunctionData({abi,functionName:'complianceVerify',args:[config.pool as Address,actor as Address]}),failureWord(1n)),
      node('STATICCALL',config.gate,config.policy,encodeFunctionData({abi,functionName:'canTransfer',args:[config.asset as Address,config.pool as Address,actor as Address,amount]}),failureWord(1n))];
    if(deny)queries[deny].output=failureWord(0n);
    return node('STATICCALL',config.pool,config.gate,encodeFunctionData({abi,functionName:'canTransfer',args:[config.asset as Address,config.pool as Address,actor as Address,amount,context as Hex]}),
      failureWord(deny?0n:1n),deny?queries.slice(0,deny+1):queries);
  };
  const balance=(owner:string,amount:bigint)=>node('STATICCALL',config.pool,config.asset,encodeFunctionData({abi,functionName:'balanceOf',args:[owner as Address]}),failureWord(amount));
  const transfer=(amount:bigint,result=0n,actor=e.payee)=>node('CALL',config.pool,config.asset,encodeFunctionData({abi,functionName:'transfer',args:[actor as Address,amount]}),failureWord(result));
  const traces=new Map<Hex,Day4FailureTraceNode>();
  for(const [hash,calls,output] of [[h(301),[gate(e.buyer,5n,p.grant.contextHash,3)],'0x349cf84c'],
    [h(302),[gate(e.buyer,15n,refund.grant.contextHash,4)],'0x349cf84c'],
    [h(303),[gate(e.payee,10n,p.grant.contextHash),balance(config.pool,15n),balance(e.payee,0n),transfer(10n)],
      ('0x5274afe7'+encodeAbiParameters(parseAbiParameters('address'),[config.asset as Address]).slice(2)) as Hex]] as const){
    const tx=transactions.get(hash)!;traces.set(hash,{...node('CALL',tx.from,config.pool,tx.input,output as Hex,[...calls],true),gas:tx.gas,gasUsed:receipts.get(hash)!.gasUsed});
  }
  const counts={trace:0};
  const port:Day4AssetFailurePort={...f.ports.creations,
    transaction:async hash=>{
      const tx=transactions.get(hash);if(tx)return structuredClone(tx);
      const c=await f.ports.creations.transaction(hash);return c?{...c,gas:5_000_000n}:null;
    },receipt:async hash=>{
      const r=receipts.get(hash);if(r)return structuredClone(r);
      const c=await f.ports.creations.receipt(hash);return c?{...c,logs:[],gasUsed:400_000n}:null;
    },orderAt:async(id,n)=>{
      const second=id.toLowerCase()===refund.intent.orderId.toLowerCase(),state=second?'FUNDED':n<20n?'CERTIFIED':'ALLOCATED_PAID';
      return {...x.snapshot(state),orderId:second?refund.intent.orderId as Hex:e.orderId as Hex,
        contextHash:(second?refund.grant.contextHash:p.grant.contextHash) as Hex,
        evidenceHash:state==='FUNDED'?h(0):reportDelivery(p,x.dataset).evidenceHash,
        block:{number:String(n),hash:block(n).hash,timestamp:String(block(n).timestamp)}};
    },traceTransaction:async hash=>{counts.trace++;return {status:'AVAILABLE',trace:structuredClone(traces.get(hash)!)};}};
  return {f,request,config,artifacts:f.artifacts,port,transactions,receipts,traces,counts,gate,balance,transfer,node,
    run:()=>inspectDay4AssetFailures(request,config,f.artifacts,port)};
}
