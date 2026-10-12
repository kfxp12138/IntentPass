import {z} from 'zod';
import {getContractAddress,keccak256,type Address,type Hex,type Transaction,type TransactionReceipt} from 'viem';
import {deploymentDraft} from './deployment.js';
import {digest} from './schemas.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA} from './escrow.js';
const bytecode=z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/);
/** Match the compiler's runtime template, permitting only consistent constructor
 * immutable words. Every group must match one original immutable value.
 * Foundry omits immutableReferences for immutable-free runtime; only absence
 * defaults to an empty map. Explicit invalid values still fail validation.
 */
export function verifyDeploymentRuntime(artifact:unknown,actual:Hex,expected:readonly string[]){
  const parsed=z.object({deployedBytecode:z.object({object:bytecode,immutableReferences:z.record(z.string(),z.array(z.object({start:z.number().int().nonnegative(),length:z.literal(32)}).strict()).min(1).max(100)).default({}),linkReferences:z.record(z.string(),z.unknown())})}).passthrough().parse(artifact);
  if(Object.keys(parsed.deployedBytecode.linkReferences).length!==0)throw new Error('DEPLOYMENT_LINKED_RUNTIME_UNSUPPORTED');
  const template=parsed.deployedBytecode.object.slice(2).toLowerCase(),runtime=bytecode.parse(actual).slice(2).toLowerCase();
  if(runtime.length!==template.length)throw new Error('DEPLOYMENT_RUNTIME_MISMATCH');
  const masked=runtime.split(''),positions=new Set<number>(),values:string[]=[];
  for(const refs of Object.values(parsed.deployedBytecode.immutableReferences)){
    let word:string|undefined;
    for(const ref of refs){const start=ref.start*2,end=start+64;if(end>runtime.length)throw new Error('DEPLOYMENT_IMMUTABLE_LAYOUT_INVALID');const value=runtime.slice(start,end);if(word!==undefined&&word!==value)throw new Error('DEPLOYMENT_IMMUTABLE_INCONSISTENT');word=value;
      for(let i=start;i<end;i++){if(positions.has(i)||template[i]!=='0')throw new Error('DEPLOYMENT_IMMUTABLE_LAYOUT_INVALID');positions.add(i);masked[i]='0';}
    }values.push(word!);
  }
  if(masked.join('')!==template||JSON.stringify(values.sort())!==JSON.stringify(expected.map(v=>v.replace(/^0x/,'').toLowerCase().padStart(64,'0')).sort()))throw new Error('DEPLOYMENT_RUNTIME_MISMATCH');
  return keccak256(actual);
}
type CreationTransaction=Pick<Transaction,'hash'|'from'|'to'|'input'|'value'|'nonce'|'blockNumber'|'blockHash'>&{chainId?:number};
type CreationReceipt=Pick<TransactionReceipt,'transactionHash'|'from'|'to'|'status'|'contractAddress'|'blockNumber'|'blockHash'>;
export interface DeploymentProofPort {
  blockTag:'finalized'|'latest';
  chainId():Promise<number>;
  block(number?:bigint):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
  transaction(hash:Hex):Promise<CreationTransaction|null>;
  receipt(hash:Hex):Promise<CreationReceipt|null>;
  code(address:Address,blockNumber:bigint):Promise<Hex|undefined>;
  configuration(address:Address,blockNumber:bigint):Promise<{asset:string;gate:string;reviewer:string;committee:string[];committeeHash:string;allocationPolicy:string;releasePolicy:string;deliverySchema:string}>;
}
export async function verifyDeploymentCreation(input:unknown,artifact:unknown,hashInput:string,port:DeploymentProofPort,options:{local?:true}={}){
  const hash=digest.parse(hashInput) as Hex,draft=deploymentDraft(input,artifact,options),config=draft.config,eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(port.blockTag!==(options.local?'latest':'finalized'))throw new Error('DEPLOYMENT_BLOCK_TAG_INVALID');
  if(String(await port.chainId())!==config.chainId)throw new Error('DEPLOYMENT_CHAIN_MISMATCH');
  const block=await port.block();if(block.number===null||block.hash===null)throw new Error('DEPLOYMENT_FINALIZED_BLOCK_UNAVAILABLE');
  const [tx,receipt]=await Promise.all([port.transaction(hash),port.receipt(hash)]);
  const finish=async(status:'PENDING'|'REVERTED'|'CONFIRMED',extra:{contractAddress?:Address;runtimeCodeHash?:Hex;receiptBlock?:{number:string;hash:Hex};configuration?:Awaited<ReturnType<DeploymentProofPort['configuration']>>}={})=>{
    const again=await port.block(block.number!);if(again.hash!==block.hash||again.number!==block.number||String(await port.chainId())!==config.chainId)throw new Error('DEPLOYMENT_SNAPSHOT_CHANGED');
    return {status,scope:options.local?'LOCAL_TEST_DEPLOYMENT_CREATION_PROOF':'FINALIZED_ORIGINAL_DEPLOYMENT_CREATION_PROOF',chainId:config.chainId,deployer:config.deployer,hash,creationBytecodeHash:draft.creationBytecodeHash,initCodeHash:draft.initCodeHash,block:{number:String(block.number),hash:block.hash,timestamp:String(block.timestamp)},officialIntegrationVerified:false as const,transactionsSent:0,...extra};
  };
  if(!tx){if(receipt)throw new Error('DEPLOYMENT_TRANSACTION_UNAVAILABLE');return finish('PENDING');}
  if(!eq(tx.hash,hash)||!eq(tx.from,config.deployer)||tx.to!==null||tx.value!==0n||!eq(tx.input,draft.transaction.data)||String(tx.chainId)!==config.chainId||!Number.isSafeInteger(tx.nonce)||tx.nonce<0)throw new Error('DEPLOYMENT_TRANSACTION_MISMATCH');
  if(!receipt)return finish('PENDING');
  if(!eq(receipt.transactionHash,hash)||!eq(receipt.from,config.deployer)||receipt.to!==null||tx.blockNumber!==receipt.blockNumber||tx.blockHash===null||!eq(tx.blockHash,receipt.blockHash))throw new Error('DEPLOYMENT_RECEIPT_MISMATCH');
  if(receipt.blockNumber>block.number)return finish('PENDING');
  const canonical=await port.block(receipt.blockNumber);if(canonical.number!==receipt.blockNumber||canonical.hash===null||!eq(canonical.hash,receipt.blockHash))throw new Error('DEPLOYMENT_RECEIPT_NOT_CANONICAL');
  if(receipt.status==='reverted'){if(receipt.contractAddress!==null)throw new Error('DEPLOYMENT_REVERTED_ADDRESS_INVALID');return finish('REVERTED');}
  if(receipt.status!=='success'||!receipt.contractAddress)throw new Error('DEPLOYMENT_RECEIPT_STATUS_INVALID');
  const contract=getContractAddress({from:config.deployer as Address,nonce:BigInt(tx.nonce)});if(!eq(receipt.contractAddress,contract))throw new Error('DEPLOYMENT_ADDRESS_MISMATCH');
  const [code,current]=await Promise.all([port.code(contract,block.number),port.configuration(contract,block.number)]);if(!code||code==='0x')throw new Error('DEPLOYMENT_CODE_MISSING');
  if(!eq(current.asset,config.asset)||!eq(current.gate,config.gate)||!eq(current.reviewer,config.reviewer)||current.committee.length!==3||current.committee.some((v,i)=>!eq(v,config.committee[i]))||!eq(current.committeeHash,draft.committeeHash)||!eq(current.allocationPolicy,ALLOCATION_POLICY)||!eq(current.releasePolicy,RELEASE_POLICY)||!eq(current.deliverySchema,DELIVERY_SCHEMA))throw new Error('DEPLOYMENT_CONFIGURATION_MISMATCH');
  const runtimeCodeHash=verifyDeploymentRuntime(artifact,code,[config.asset,config.gate,config.reviewer,draft.committeeHash]);
  return finish('CONFIRMED',{contractAddress:contract,runtimeCodeHash,receiptBlock:{number:String(receipt.blockNumber),hash:receipt.blockHash},configuration:current});
}
