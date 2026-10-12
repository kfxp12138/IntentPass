import {z} from 'zod';
import {encodeAbiParameters,concatHex,keccak256,toBytes,type Address,type Hex,getContractAddress} from 'viem';
import {verifyDeploymentRuntime} from '../packages/protocol/src/deployment-proof.js';
import {MetaMaskDemoDependencyPlanSchema,type MetaMaskDemoDependencyPlan} from './metamask-types.js';
const nonzero=z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value=>BigInt(value)!==0n);
const configSchema=z.object({chainId:z.literal('10143'),deployer:nonzero,asset:nonzero.optional()}).strict();
const artifactSchema=z.object({abi:z.array(z.unknown()),bytecode:z.object({object:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/)})}).passthrough();
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function demoDependencyPlan(dependency:'ASSET'|'GATE',input:unknown,artifact:unknown,sourceCommit:string):MetaMaskDemoDependencyPlan{
  const config=configSchema.parse(input),compiled=artifactSchema.parse(artifact);
  const constructors=compiled.abi.filter((value):value is {type:'constructor';stateMutability:string;inputs:{type:string}[]}=>!!value&&typeof value==='object'&&'type' in value&&value.type==='constructor');
  if(constructors.length!==1||constructors[0].stateMutability!=='nonpayable'||JSON.stringify(constructors[0].inputs?.map(value=>value.type))!==JSON.stringify(['address']))throw Error('DEPLOYMENT_DEMO_CONSTRUCTOR_MISMATCH');
  if(dependency==='GATE'&&!config.asset||dependency==='ASSET'&&config.asset)throw Error('DEPLOYMENT_DEMO_PARAMETER_INVALID');
  const parameter=dependency==='ASSET'?config.deployer:config.asset!,data=concatHex([compiled.bytecode.object as Hex,encodeAbiParameters([{type:'address'}],[parameter as Address])]),initCodeHash=keccak256(data);
  return MetaMaskDemoDependencyPlanSchema.parse({kind:'DEMO_DEPENDENCY',dependency,sourceCommit,chainId:'10143',deployer:config.deployer,asset:dependency==='GATE'?config.asset:null,recipient:dependency==='ASSET'?config.deployer:null,data,initCodeHash,planId:keccak256(toBytes(JSON.stringify(['10143',config.deployer.toLowerCase(),initCodeHash.toLowerCase()])))});
}
export interface DemoDependencyReadPort{
  chainId():Promise<number>;
  block(number?:bigint):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
  code(address:Address,block:bigint):Promise<Hex|undefined>;
  nonce(address:Address,tag:'pending'|'latest'):Promise<bigint>;
  balance(address:Address):Promise<bigint>;
  fees():Promise<{maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}>;
  estimate(tx:{account:Address;data:Hex;value:bigint;nonce:number;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}):Promise<bigint>;
  token(address:Address,block:bigint):Promise<{name:string;symbol:string;decimals:number;totalSupply:bigint}>;
  gate(address:Address,block:bigint):Promise<{asset:Address}>;
  transaction(hash:Hex):Promise<{hash:Hex;from:Address;to:Address|null;input:Hex;value:bigint;chainId?:number;nonce:number;blockNumber:bigint|null;blockHash:Hex|null;gas:bigint;maxFeePerGas?:bigint|null;maxPriorityFeePerGas?:bigint|null}|null>;
  receipt(hash:Hex):Promise<{transactionHash:Hex;from:Address;to:Address|null;status:'success'|'reverted';contractAddress:Address|null;blockNumber:bigint;blockHash:Hex}|null>;
}
export async function inspectDemoDependency(plan:MetaMaskDemoDependencyPlan,artifact:unknown,address:Address,block:bigint,port:DemoDependencyReadPort){
  const code=await port.code(address,block);if(!code||code==='0x')throw Error('DEPLOYMENT_DEMO_CODE_MISSING');
  if(plan.dependency==='ASSET'){
    const token=await port.token(address,block);
    if(token.name!=='IntentPass TEST ONLY Demo Token'||token.symbol!=='IPTEST'||token.decimals!==6||token.totalSupply!==1_000_000_000_000n)throw Error('DEPLOYMENT_DEMO_ASSET_MISMATCH');
    return {runtimeCodeHash:verifyDeploymentRuntime(artifact,code,[]),configuration:{name:token.name,symbol:token.symbol,decimals:token.decimals,totalSupply:String(token.totalSupply)}};
  }
  const gate=await port.gate(address,block);if(!plan.asset||!eq(gate.asset,plan.asset))throw Error('DEPLOYMENT_DEMO_GATE_MISMATCH');
  return {runtimeCodeHash:verifyDeploymentRuntime(artifact,code,[plan.asset]),configuration:{asset:gate.asset,identityVerification:false}};
}
export async function verifyDemoDependencyCreation(plan:MetaMaskDemoDependencyPlan,artifact:unknown,hash:Hex,port:DemoDependencyReadPort){
  if(await port.chainId()!==10143)throw Error('DEPLOYMENT_CHAIN_MISMATCH');
  const block=await port.block();if(block.number===null||block.hash===null)throw Error('DEPLOYMENT_FINALIZED_BLOCK_UNAVAILABLE');
  const [tx,receipt]=await Promise.all([port.transaction(hash),port.receipt(hash)]);
  const finish=async(status:'PENDING'|'REVERTED'|'CONFIRMED',extra:{contractAddress?:Address;runtimeCodeHash?:Hex;receiptBlock?:{number:string;hash:Hex};configuration?:unknown}={})=>{
    const again=await port.block(block.number!);if(again.hash!==block.hash||again.number!==block.number||await port.chainId()!==10143)throw Error('DEPLOYMENT_SNAPSHOT_CHANGED');
    return {status,scope:'FINALIZED_ORIGINAL_DEMO_DEPENDENCY_CREATION_PROOF',assetMode:'demo-erc20',dependency:plan.dependency,hash,initCodeHash:plan.initCodeHash,block:{number:String(block.number),hash:block.hash},identityVerification:false,transactionsSent:0,...extra};
  };
  if(!tx){if(receipt)throw Error('DEPLOYMENT_TRANSACTION_UNAVAILABLE');return finish('PENDING');}
  if(!eq(tx.hash,hash)||!eq(tx.from,plan.deployer)||tx.to!==null||tx.value!==0n||!eq(tx.input,plan.data)||tx.chainId!==10143||!Number.isSafeInteger(tx.nonce)||tx.nonce<0)throw Error('DEPLOYMENT_TRANSACTION_MISMATCH');
  if(!receipt)return finish('PENDING');
  if(!eq(receipt.transactionHash,hash)||!eq(receipt.from,plan.deployer)||receipt.to!==null||tx.blockNumber!==receipt.blockNumber||tx.blockHash===null||!eq(tx.blockHash,receipt.blockHash))throw Error('DEPLOYMENT_RECEIPT_MISMATCH');
  if(receipt.blockNumber>block.number)return finish('PENDING');
  const canonical=await port.block(receipt.blockNumber);if(canonical.number!==receipt.blockNumber||!canonical.hash||!eq(canonical.hash,receipt.blockHash))throw Error('DEPLOYMENT_RECEIPT_NOT_CANONICAL');
  if(receipt.status==='reverted'){if(receipt.contractAddress!==null)throw Error('DEPLOYMENT_REVERTED_ADDRESS_INVALID');return finish('REVERTED');}
  const address=getContractAddress({from:plan.deployer as Address,nonce:BigInt(tx.nonce)});
  if(receipt.status!=='success'||!receipt.contractAddress||!eq(receipt.contractAddress,address))throw Error('DEPLOYMENT_ADDRESS_MISMATCH');
  const checked=await inspectDemoDependency(plan,artifact,address,block.number,port);
  return finish('CONFIRMED',{contractAddress:address,receiptBlock:{number:String(receipt.blockNumber),hash:receipt.blockHash},...checked});
}
