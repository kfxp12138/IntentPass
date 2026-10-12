import {z} from 'zod';
import {concatHex,encodeAbiParameters,getContractAddress,keccak256,type Address,type Hex} from 'viem';
import {address,digest} from './schemas.js';
import {verifyDeploymentRuntime} from './deployment-proof.js';
import {CleanverseGateConfigSchema,type CleanverseGateProofPort} from './cleanverse-gate-proof-types.js';

const bytecode=z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/);
const equal=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
const constructorSchema=z.object({type:z.literal('constructor'),stateMutability:z.literal('nonpayable'),
  inputs:z.array(z.object({type:z.literal('address')}).passthrough()).length(4)}).passthrough();
const configurationSchema=z.object({asset:address,validator:address,policy:address,pool:address}).strict();

/** Read-only proof of this original gate creation, not official CVI/CVA eligibility. */
export async function verifyCleanverseGateCreation(input:unknown,artifact:unknown,hashInput:string,port:CleanverseGateProofPort){
  const config=CleanverseGateConfigSchema.parse(input),hash=digest.parse(hashInput) as Hex;
  const pool=getContractAddress({from:config.deployer as Address,nonce:config.nonce+1n});
  if(!equal(pool,config.pool))throw new Error('CLEANVERSE_GATE_POOL_NONCE_MISMATCH');
  const parsed=z.object({abi:z.array(z.unknown()),bytecode:z.object({object:bytecode,
    linkReferences:z.record(z.string(),z.unknown()).optional()}).passthrough()}).passthrough().parse(structuredClone(artifact));
  const constructors=parsed.abi.filter(value=>value!==null&&typeof value==='object'&&'type' in value&&value.type==='constructor');
  if(constructors.length!==1||!constructorSchema.safeParse(constructors[0]).success)throw new Error('CLEANVERSE_GATE_CONSTRUCTOR_MISMATCH');
  if(Object.keys(parsed.bytecode.linkReferences??{}).length!==0)throw new Error('CLEANVERSE_GATE_LINKED_CREATION_UNSUPPORTED');
  const expected=[config.asset,config.validator,config.policy,config.pool] as const;
  const args=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],expected as readonly [Address,Address,Address,Address]);
  const data=concatHex([parsed.bytecode.object as Hex,args]);
  const contract=getContractAddress({from:config.deployer as Address,nonce:config.nonce});
  if(port.blockTag!=='finalized')throw new Error('CLEANVERSE_GATE_BLOCK_TAG_INVALID');
  if(await port.chainId()!==10143)throw new Error('CLEANVERSE_GATE_CHAIN_MISMATCH');
  const block=await port.block();
  if(block.number===null||block.number<0n||block.hash===null||!digest.safeParse(block.hash).success||block.timestamp<0n)throw new Error('CLEANVERSE_GATE_FINALIZED_BLOCK_UNAVAILABLE');
  const blockNumber=block.number,blockHash=block.hash;
  const [tx,receipt]=await Promise.all([port.transaction(hash),port.receipt(hash)]);
  const finish=async(status:'PENDING'|'REVERTED'|'CONFIRMED',extra:{contractAddress?:Address;runtimeCodeHash?:Hex;
    receiptBlock?:{number:string;hash:Hex};configuration?:Awaited<ReturnType<CleanverseGateProofPort['configuration']>>}={})=>{
    const again=await port.block(blockNumber);
    if(again.number!==blockNumber||again.hash===null||!equal(again.hash,blockHash)||again.timestamp!==block.timestamp||await port.chainId()!==10143)throw new Error('CLEANVERSE_GATE_SNAPSHOT_CHANGED');
    return {status,scope:'FINALIZED_ORIGINAL_CLEANVERSE_GATE_CREATION_PROOF' as const,chainId:config.chainId,deployer:config.deployer,
      nonce:String(config.nonce),pool:config.pool,predictedAddress:contract,hash,creationBytecodeHash:keccak256(parsed.bytecode.object as Hex),
      initCodeHash:keccak256(data),block:{number:String(blockNumber),hash:blockHash,timestamp:String(block.timestamp)},
      officialIntegrationVerified:false as const,transactionsSent:0 as const,...extra};
  };
  if(!tx){if(receipt)throw new Error('CLEANVERSE_GATE_TRANSACTION_UNAVAILABLE');return finish('PENDING');}
  if(!equal(tx.hash,hash)||!equal(tx.from,config.deployer)||tx.to!==null||tx.value!==0n||!equal(tx.input,data)
    ||tx.chainId!==10143||!Number.isSafeInteger(tx.nonce)||tx.nonce<0||BigInt(tx.nonce)!==config.nonce)throw new Error('CLEANVERSE_GATE_TRANSACTION_MISMATCH');
  // A pending transaction has no location; a mined transaction has both fields.
  if((tx.blockNumber===null)!==(tx.blockHash===null)||tx.blockNumber!==null&&tx.blockNumber<0n
    ||tx.blockHash!==null&&!digest.safeParse(tx.blockHash).success)throw new Error('CLEANVERSE_GATE_TRANSACTION_LOCATION_INVALID');
  if(!receipt)return finish('PENDING');
  if(!equal(receipt.transactionHash,hash)||!equal(receipt.from,config.deployer)||receipt.to!==null
    ||receipt.blockNumber<0n||!digest.safeParse(receipt.blockHash).success
    ||tx.blockNumber!==receipt.blockNumber||tx.blockHash===null||!equal(tx.blockHash,receipt.blockHash))throw new Error('CLEANVERSE_GATE_RECEIPT_MISMATCH');
  if(receipt.status==='reverted'){
    if(receipt.contractAddress!==null)throw new Error('CLEANVERSE_GATE_REVERTED_ADDRESS_INVALID');
  }else if(receipt.status!=='success'||typeof receipt.contractAddress!=='string'||!address.safeParse(receipt.contractAddress).success){
    throw new Error('CLEANVERSE_GATE_RECEIPT_STATUS_INVALID');
  }else if(!equal(receipt.contractAddress,contract))throw new Error('CLEANVERSE_GATE_ADDRESS_MISMATCH');
  // Even unfinalized receipts must describe this exact creation. They cannot
  // provide a confirmed runtime/configuration snapshot yet.
  if(receipt.blockNumber>blockNumber)return finish('PENDING');
  const canonical=await port.block(receipt.blockNumber);
  if(canonical.number!==receipt.blockNumber||canonical.hash===null||!equal(canonical.hash,receipt.blockHash))throw new Error('CLEANVERSE_GATE_RECEIPT_NOT_CANONICAL');
  const receiptBlock={number:String(receipt.blockNumber),hash:receipt.blockHash};
  if(receipt.status==='reverted')return finish('REVERTED',{receiptBlock});
  const [code,currentInput]=await Promise.all([port.code(contract,blockNumber),port.configuration(contract,blockNumber)]);
  if(!code||code==='0x')throw new Error('CLEANVERSE_GATE_CODE_MISSING');
  let current:Awaited<ReturnType<CleanverseGateProofPort['configuration']>>;
  try{current=configurationSchema.parse(currentInput);}catch{throw new Error('CLEANVERSE_GATE_CONFIGURATION_MISMATCH');}
  if(!equal(current.asset,config.asset)||!equal(current.validator,config.validator)||!equal(current.policy,config.policy)||!equal(current.pool,config.pool))throw new Error('CLEANVERSE_GATE_CONFIGURATION_MISMATCH');
  const runtimeCodeHash=verifyDeploymentRuntime(parsed,code,expected);
  return finish('CONFIRMED',{contractAddress:contract,runtimeCodeHash,receiptBlock,configuration:current});
}
