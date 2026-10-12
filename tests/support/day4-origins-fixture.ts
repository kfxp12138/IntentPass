import {getContractAddress,concatHex,encodeAbiParameters,encodeEventTopics,parseAbi,parseAbiParameters,keccak256,toHex,type Address,type Hex} from 'viem';
import {originalAuthorizationFixture,readTestAddress as a,readTestHash as h} from './original-authorization.js';
import {inspectDay4Origins} from '../../packages/protocol/src/day4-origins.js';
import {Day4CreationPairConfigSchema,Day4OriginsProofSchema,Day4OriginsRequestSchema,type Day4CreationPairPort,type PrivyOriginPort} from '../../packages/protocol/src/day4-origin-types.js';
import {type Day4ChainFlowPort,type Day4ChainReceipt,type Day4ChainTransaction} from '../../packages/protocol/src/day4-chain-flow-types.js';
import {deploymentDraft} from '../../packages/protocol/src/deployment.js';
import {committeeHash} from '../../packages/protocol/src/escrow.js';
import {fundingCalldata} from '../../packages/protocol/src/funding.js';
import {allocationCalldata} from '../../packages/protocol/src/allocation.js';
import {withdrawalCalldata} from '../../packages/protocol/src/withdrawal.js';
import {reportDelivery} from '../../packages/protocol/src/fulfillment.js';
import {createReport} from '../../packages/protocol/src/report.js';
import {escrowPolicy} from '../../packages/adapters/src/privy-sender.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA} from '../../packages/protocol/src/escrow.js';


const events=parseAbi(['event Funded(bytes32 indexed orderId,bytes32 contextHash,address buyer,uint256 amount)',
  'event Allocated(bytes32 indexed orderId,uint8 state,uint256 buyerCredit,uint256 payeeCredit)',
  'event Withdrawn(bytes32 indexed orderId,address indexed beneficiary,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
/** This entire multi-provider pipeline is an explicit local synthetic double.
 * No real account, deployment, RPC, Privy, wallet or acceptance is used. */
export async function day4OriginsFixture(){
  const deployer=a(41),gate=getContractAddress({from:deployer,nonce:0n}),pool=getContractAddress({from:deployer,nonce:1n});
  const x=await originalAuthorizationFixture('10143',{arbiter:pool}),e=x.payload.intent;
  const config={flow:{...x.deployment,chainId:'10143' as const,gate},creations:Day4CreationPairConfigSchema.parse({chainId:'10143',deployer,asset:e.asset,
    validator:a(42),policy:a(43),gate,pool,reviewer:e.reviewer,committee:x.deployment.committee,gateNonce:'0'}),
    privy:{chainId:'10143' as const,arbiter:pool,address:x.deployment.executor,walletId:'local-wallet',policyId:'local-policy',signerId:'local-signer'}};
  const hashes={funding:h(101),allocation:h(102),withdrawal:h(103)};
  const request=Day4OriginsRequestSchema.parse({schemaVersion:1,flow:{schemaVersion:1,payload:x.payload,dataset:x.dataset,report:createReport(x.dataset),transactions:hashes},
    creations:{schemaVersion:1,gateTransaction:h(201),escrowTransaction:h(202)},privy:{schemaVersion:1,transactions:{funding:{recordId:'local-funding',hash:hashes.funding},allocation:{recordId:'local-allocation',hash:hashes.allocation}}}});
  const artifact=(types:string[])=>({abi:[{type:'constructor',stateMutability:'nonpayable',inputs:types.map(type=>({type}))}],bytecode:{object:'0x6001',linkReferences:{}},
    deployedBytecode:{object:'0x6020'+'0'.repeat(64*4),linkReferences:{},immutableReferences:Object.fromEntries([0,1,2,3].map(index=>[String(index),[{start:2+32*index,length:32}]]))}});
  const artifacts={gate:artifact(['address','address','address','address']),escrow:artifact(['address','address','address','address[3]'])};
  const runtime=(values:string[])=>('0x6020'+values.map(value=>value.slice(2).padStart(64,'0')).join('')) as Hex;
  const timestamp=(number:bigint)=>1200n+10n*number;
  const control={tip:30n,drift:false,providerCalled:false,providerHook:undefined as undefined|(()=>void)};
  const block=async(number?:bigint)=>({number:number??control.tip,hash:control.drift&&control.providerCalled?h(999):h(Number(number??control.tip)),timestamp:timestamp(number??control.tip)});
  const creationTransactions=new Map<Hex,NonNullable<Awaited<ReturnType<Day4CreationPairPort['transaction']>>>>();
  const creationReceipts=new Map<Hex,NonNullable<Awaited<ReturnType<Day4CreationPairPort['receipt']>>>>();
  const gateData=concatHex(['0x6001',encodeAbiParameters(parseAbiParameters('address,address,address,address'),[e.asset as Address,a(42),a(43),pool])]);
  const escrowData=deploymentDraft({chainId:'10143',deployer,asset:e.asset,gate,reviewer:e.reviewer,committee:x.deployment.committee},artifacts.escrow).transaction.data;
  for(const [hash,nonce,address,input] of [[h(201),0,gate,gateData],[h(202),1,pool,escrowData]] as const){
    const number=BigInt(nonce+2);
    creationTransactions.set(hash,{hash,from:deployer,to:null,input,value:0n,nonce,chainId:10143,blockNumber:number,blockHash:h(Number(number)),transactionIndex:0});
    creationReceipts.set(hash,{transactionHash:hash,from:deployer,to:null,status:'success',contractAddress:address,blockNumber:number,blockHash:h(Number(number)),transactionIndex:0});
  }
  const creation:Day4CreationPairPort={blockTag:'finalized',chainId:async()=>10143,block,transaction:async hash=>structuredClone(creationTransactions.get(hash)??null),
    receipt:async hash=>structuredClone(creationReceipts.get(hash)??null),code:async address=>address===gate?runtime([e.asset,a(42),a(43),pool]):runtime([e.asset,gate,e.reviewer,committeeHash(x.deployment.committee)]),
    gateConfiguration:async()=>({asset:e.asset,validator:a(42),policy:a(43),pool}),escrowConfiguration:async()=>({asset:e.asset,gate,reviewer:e.reviewer,committee:x.deployment.committee,
      committeeHash:committeeHash(x.deployment.committee),allocationPolicy:ALLOCATION_POLICY,releasePolicy:RELEASE_POLICY,deliverySchema:DELIVERY_SCHEMA})};
  const transactions=new Map<Hex,Day4ChainTransaction>(),receipts=new Map<Hex,Day4ChainReceipt>();
  const steps=['funding','allocation','withdrawal'] as const,calls={funding:fundingCalldata(x.payload),allocation:allocationCalldata({payload:x.payload},'settle'),withdrawal:withdrawalCalldata({payload:x.payload,beneficiary:e.payee})};
  for(const [index,step] of steps.entries()){
    const number=BigInt(10*(index+1)),hash=hashes[step],from=(step==='withdrawal'?e.payee:x.deployment.executor) as Address;
    transactions.set(hash,{hash,from,to:pool,input:calls[step],value:0n,chainId:10143,blockNumber:number,blockHash:h(Number(number)),transactionIndex:0});
    receipts.set(hash,{transactionHash:hash,from,to:pool,status:'success',blockNumber:number,blockHash:h(Number(number)),transactionIndex:0,logs:[]});
  }
  const log=(step:typeof steps[number],address:Address,topics:readonly unknown[],data:Hex,index:number)=>{
    const receipt=receipts.get(hashes[step])!;return {address,topics:topics as [Hex,...Hex[]],data,logIndex:index,removed:false,transactionIndex:0,transactionHash:hashes[step],blockHash:receipt.blockHash,blockNumber:receipt.blockNumber};
  };
  receipts.get(hashes.funding)!.logs=[log('funding',pool,encodeEventTopics({abi:events,eventName:'Funded',args:{orderId:e.orderId as Hex}}),encodeAbiParameters(parseAbiParameters('bytes32,address,uint256'),[x.payload.grant.contextHash as Hex,e.buyer as Address,15n]),0),
    log('funding',e.asset as Address,encodeEventTopics({abi:events,eventName:'Transfer',args:{from:e.buyer as Address,to:pool}}),encodeAbiParameters(parseAbiParameters('uint256'),[15n]),1)];
  receipts.get(hashes.allocation)!.logs=[log('allocation',pool,encodeEventTopics({abi:events,eventName:'Allocated',args:{orderId:e.orderId as Hex}}),encodeAbiParameters(parseAbiParameters('uint8,uint256,uint256'),[4,5n,10n]),0)];
  receipts.get(hashes.withdrawal)!.logs=[log('withdrawal',pool,encodeEventTopics({abi:events,eventName:'Withdrawn',args:{orderId:e.orderId as Hex,beneficiary:e.payee as Address}}),encodeAbiParameters(parseAbiParameters('uint256'),[10n]),0),
    log('withdrawal',e.asset as Address,encodeEventTopics({abi:events,eventName:'Transfer',args:{from:pool,to:e.payee as Address}}),encodeAbiParameters(parseAbiParameters('uint256'),[10n]),1)];
  const flow:Day4ChainFlowPort={blockTag:'finalized',chainId:async()=>10143,block,transaction:async hash=>structuredClone(transactions.get(hash)??null),receipt:async hash=>structuredClone(receipts.get(hash)??null),
    orderAt:async(_,number)=>({...x.snapshot('ALLOCATED_PAID'),evidenceHash:reportDelivery(x.payload,x.dataset).evidenceHash,credits:{buyer:'5',payee:'0'},withdrawn:{buyer:'0',payee:'10'},accounting:{locked:'0',outstanding:'5',balance:'5'},
      block:{number:String(number),hash:h(Number(number)),timestamp:String(timestamp(number))}}),balance:async(_,owner,number)=>owner.toLowerCase()===e.buyer.toLowerCase()?(number<10n?100n:85n):owner.toLowerCase()===e.payee.toLowerCase()?(number<30n?0n:10n):(number<10n?0n:number<30n?15n:5n)};
  const provider:PrivyOriginPort={wallet:async()=>{control.providerCalled=true;control.providerHook?.();return {id:'local-wallet',address:x.deployment.executor,chain_type:'ethereum',owner_id:'local-signer',policy_ids:['local-policy'],additional_signers:[]};},
    policy:async()=>({...escrowPolicy('10143',pool),id:'local-policy'}),transaction:async id=>({id,caip2:'eip155:10143',created_at:1,status:'finalized',transaction_hash:id==='local-funding'?hashes.funding:hashes.allocation,wallet_id:'local-wallet'})};
  const ports={flow,creations:creation,privy:provider};
  return {request,config,artifacts,ports,control,creationTransactions,creationReceipts,authorization:x,run:()=>inspectDay4Origins(request,config,artifacts,ports)};
}
