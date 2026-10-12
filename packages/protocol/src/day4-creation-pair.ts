import {z} from 'zod';
import type {Address,Hex} from 'viem';
import {address,digest,uint} from './schemas.js';
import {verifyDeploymentCreation} from './deployment-proof.js';
import {verifyCleanverseGateCreation} from './cleanverse-gate-proof.js';
import {Day4CreationPairConfigSchema,Day4CreationPairRequestSchema,Day4CreationPairProofSchema,
  type Day4CreationPairPort,type Day4CreationPairProof} from './day4-origin-types.js';

const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const validUint=(value:unknown):value is bigint=>typeof value==='bigint'&&uint.safeParse(String(value)).success;
const bytes=z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/);
const index=z.number().int().nonnegative().safe();
const bigUint=z.bigint().refine(value=>validUint(value));
const transactionSchema=z.object({hash:digest,from:address,to:z.null(),input:bytes,value:z.literal(0n),nonce:index,chainId:z.literal(10143),
  blockNumber:bigUint.nullable(),blockHash:digest.nullable(),transactionIndex:index.nullable()}).strict();
const receiptSchema=z.object({transactionHash:digest,from:address,to:z.null(),status:z.enum(['success','reverted']),contractAddress:address.nullable(),
  blockNumber:bigUint,blockHash:digest,transactionIndex:index}).strict();
const gateConfiguration=z.object({asset:address,validator:address,policy:address,pool:address}).strict();
const escrowConfiguration=z.object({asset:address,gate:address,reviewer:address,committee:z.tuple([address,address,address]),committeeHash:digest,
  allocationPolicy:digest,releasePolicy:digest,deliverySchema:digest}).strict();
const artifactSchema=z.object({abi:z.array(z.unknown()).min(1),bytecode:z.object({object:bytes,linkReferences:z.record(z.string(),z.unknown()).optional()}).passthrough(),
  deployedBytecode:z.object({object:bytes,linkReferences:z.record(z.string(),z.unknown()),
    immutableReferences:z.record(z.string(),z.array(z.object({start:z.number().int().nonnegative().safe(),length:z.literal(32)}).strict()).min(1).max(100))}).passthrough()}).passthrough();
const codes=['INPUT_INVALID','ARTIFACT_INVALID','FINALIZED_PORT_REQUIRED','CHAIN_MISMATCH','BLOCK_INVALID','SNAPSHOT_CHANGED','READ_UNAVAILABLE','PENDING',
  'TRANSACTION_INVALID','RECEIPT_INVALID','QUERY_INVALID','CODE_MISSING','CODE_INVALID','CONFIGURATION_INVALID','RUNTIME_INVALID','REVERTED','ORDER_INVALID','PROOF_INVALID'] as const;
type Code=typeof codes[number];
const safeCodes=new Set(codes.map(code=>'DAY4_CREATIONS_'+code));
const fail=(code:Code):never=>{throw Error('DAY4_CREATIONS_'+code);};
function freeze<T>(value:T,seen=new WeakSet<object>()):T{if(value!==null&&typeof value==='object'&&!seen.has(value)){seen.add(value);for(const child of Object.values(value))freeze(child,seen);Object.freeze(value);}return value;}
function parsed<T>(schema:z.ZodType<T>,value:unknown,code:Code):T{try{return freeze(schema.parse(value));}catch{return fail(code);}}
function artifact(value:unknown,types:readonly string[]){
  const result=parsed(artifactSchema,value,'ARTIFACT_INVALID'),constructors=result.abi.filter(value=>value!==null&&typeof value==='object'&&'type'in value&&value.type==='constructor');
  if(constructors.length!==1)return fail('ARTIFACT_INVALID');
  const constructor=z.object({type:z.literal('constructor'),stateMutability:z.literal('nonpayable'),inputs:z.array(z.object({type:z.string()}).passthrough())}).passthrough().safeParse(constructors[0]);
  if(!constructor.success||JSON.stringify(constructor.data.inputs.map(value=>value.type))!==JSON.stringify(types)
    ||Object.keys(result.bytecode.linkReferences??{}).length||Object.keys(result.deployedBytecode.linkReferences).length)return fail('ARTIFACT_INVALID');
  return result;
}
function block(value:unknown){
  const raw=value as {number?:unknown;hash?:unknown;timestamp?:unknown}|null;
  if(!raw||!validUint(raw.number)||!validUint(raw.timestamp)||!digest.safeParse(raw.hash).success)return fail('BLOCK_INVALID');
  return freeze({number:raw.number,hash:(raw.hash as Hex).toLowerCase() as Hex,timestamp:raw.timestamp});
}
function legacyFailure(error:unknown):never{
  const message=error instanceof Error?error.message:'';
  if(safeCodes.has(message))throw error;
  if(/RUNTIME|IMMUTABLE/.test(message))return fail('RUNTIME_INVALID');
  if(/CONFIGURATION/.test(message))return fail('CONFIGURATION_INVALID');
  if(/TRANSACTION/.test(message))return fail('TRANSACTION_INVALID');
  if(/RECEIPT|ADDRESS/.test(message))return fail('RECEIPT_INVALID');
  if(/CONSTRUCTOR|LINKED/.test(message))return fail('ARTIFACT_INVALID');
  return fail('PROOF_INVALID');
}

/** Two original CREATE receipts and source-shaped runtimes at one independently
 * observed finalized height. Caller artifacts do not attest official provenance. */
export async function inspectDay4CreationPair(requestInput:unknown,configInput:unknown,artifacts:{gate:unknown;escrow:unknown},port:Day4CreationPairPort):Promise<Day4CreationPairProof>{
  let request,config,saved;
  try{request=freeze(structuredClone(Day4CreationPairRequestSchema.parse(requestInput)));config=freeze(structuredClone(Day4CreationPairConfigSchema.parse(configInput)));
    saved=freeze(structuredClone(z.object({gate:z.unknown(),escrow:z.unknown()}).strict().parse(artifacts)));}catch{return fail('INPUT_INVALID');}
  const gateArtifact=artifact(saved.gate,['address','address','address','address']),escrowArtifact=artifact(saved.escrow,['address','address','address','address[3]']);
  if(port.blockTag!=='finalized')return fail('FINALIZED_PORT_REQUIRED');
  let reads:Day4CreationPairPort;
  try{reads=Object.freeze({blockTag:'finalized' as const,chainId:port.chainId.bind(port),block:port.block.bind(port),transaction:port.transaction.bind(port),receipt:port.receipt.bind(port),
    code:port.code.bind(port),gateConfiguration:port.gateConfiguration.bind(port),escrowConfiguration:port.escrowConfiguration.bind(port)});}catch{return fail('INPUT_INVALID');}
  const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{try{return freeze(structuredClone(await operation()));}catch(error){if(error instanceof Error&&safeCodes.has(error.message))throw error;return fail('READ_UNAVAILABLE');}};
  const chain=async()=>{if(await read(()=>reads.chainId())!==10143)return fail('CHAIN_MISMATCH');return 10143;};
  await chain();
  const anchor=block(await read(()=>reads.block())),observed=new Map<bigint,ReturnType<typeof block>>([[anchor.number,anchor]]);
  const observe=async(number?:bigint)=>{
    if(number===undefined)return anchor;
    if(!validUint(number)||number>anchor.number)return fail('QUERY_INVALID');
    const current=block(await read(()=>reads.block(number))),previous=observed.get(number);
    if(current.number!==number)return fail('BLOCK_INVALID');
    if(previous&&(!same(previous.hash,current.hash)||previous.timestamp!==current.timestamp))return fail('SNAPSHOT_CHANGED');
    observed.set(number,current);return current;
  };
  const records={} as Record<'gate'|'escrow',{tx:z.infer<typeof transactionSchema>;receipt:z.infer<typeof receiptSchema>}>;
  for(const role of ['gate','escrow'] as const){
    const hash=(role==='gate'?request.gateTransaction:request.escrowTransaction) as Hex,expectedNonce=BigInt(config.gateNonce)+(role==='escrow'?1n:0n);
    const [rawTx,rawReceipt]=await Promise.all([read(()=>reads.transaction(hash)),read(()=>reads.receipt(hash))]);
    const tx=rawTx===null?null:parsed(transactionSchema,rawTx&&{hash:rawTx.hash,from:rawTx.from,to:rawTx.to,input:rawTx.input,value:rawTx.value,nonce:rawTx.nonce,chainId:rawTx.chainId,
      blockNumber:rawTx.blockNumber,blockHash:rawTx.blockHash,transactionIndex:rawTx.transactionIndex},'TRANSACTION_INVALID');
    const receipt=rawReceipt===null?null:parsed(receiptSchema,rawReceipt&&{transactionHash:rawReceipt.transactionHash,from:rawReceipt.from,to:rawReceipt.to,status:rawReceipt.status,
      contractAddress:rawReceipt.contractAddress,blockNumber:rawReceipt.blockNumber,blockHash:rawReceipt.blockHash,transactionIndex:rawReceipt.transactionIndex},'RECEIPT_INVALID');
    if(tx&&(!same(tx.hash,hash)||!same(tx.from,config.deployer)||BigInt(tx.nonce)!==expectedNonce
      ||(tx.blockNumber===null)!==(tx.blockHash===null)||(tx.blockNumber===null)!==(tx.transactionIndex===null)))return fail('TRANSACTION_INVALID');
    if(receipt&&(!same(receipt.transactionHash,hash)||!same(receipt.from,config.deployer)
      ||receipt.status==='success'&&!same(receipt.contractAddress,role==='gate'?config.gate:config.pool)
      ||receipt.status==='reverted'&&receipt.contractAddress!==null))return fail('RECEIPT_INVALID');
    if(!tx||!receipt)return fail('PENDING');
    if(tx.blockNumber!==receipt.blockNumber||!same(tx.blockHash,receipt.blockHash)||tx.transactionIndex!==receipt.transactionIndex)return fail('RECEIPT_INVALID');
    records[role]={tx,receipt};
  }
  const base={blockTag:'finalized' as const,chainId:chain,block:observe};
  const expectedQuery=(role:'gate'|'escrow',target:Address,number:bigint)=>{if(!same(target,role==='gate'?config.gate:config.pool)||number!==anchor.number)return fail('QUERY_INVALID');};
  const scoped=(role:'gate'|'escrow')=>({...base,
    transaction:async(hash:Hex)=>{if(!same(hash,role==='gate'?request.gateTransaction:request.escrowTransaction))return fail('QUERY_INVALID');return records[role].tx as NonNullable<Awaited<ReturnType<Day4CreationPairPort['transaction']>>>;},
    receipt:async(hash:Hex)=>{if(!same(hash,role==='gate'?request.gateTransaction:request.escrowTransaction))return fail('QUERY_INVALID');return records[role].receipt as NonNullable<Awaited<ReturnType<Day4CreationPairPort['receipt']>>>;},
    code:async(target:Address,number:bigint)=>{expectedQuery(role,target,number);const value=await read(()=>reads.code(target,number));
      if(value===undefined||value==='0x')return fail('CODE_MISSING');if(!bytes.safeParse(value).success)return fail('CODE_INVALID');return value as Hex;},
  });
  let gate,escrow;
  try{
    gate=await verifyCleanverseGateCreation({chainId:config.chainId,deployer:config.deployer,asset:config.asset,validator:config.validator,policy:config.policy,pool:config.pool,nonce:BigInt(config.gateNonce)},gateArtifact,request.gateTransaction,
      {...scoped('gate'),configuration:async(target,number)=>{expectedQuery('gate',target,number);return parsed(gateConfiguration,await read(()=>reads.gateConfiguration(target,number)),'CONFIGURATION_INVALID');}});
    if(gate.status==='PENDING')return fail('PENDING');if(gate.status==='REVERTED')return fail('REVERTED');
    escrow=await verifyDeploymentCreation({chainId:config.chainId,deployer:config.deployer,asset:config.asset,gate:config.gate,reviewer:config.reviewer,committee:config.committee},escrowArtifact,request.escrowTransaction,
      {...scoped('escrow'),configuration:async(target,number)=>{expectedQuery('escrow',target,number);return parsed(escrowConfiguration,await read(()=>reads.escrowConfiguration(target,number)),'CONFIGURATION_INVALID');}});
  }catch(error){return legacyFailure(error);}
  if(escrow.status==='PENDING')return fail('PENDING');
  if(escrow.status==='REVERTED')return fail('REVERTED');
  const g=records.gate.receipt,s=records.escrow.receipt;
  if(g.blockNumber>s.blockNumber||g.blockNumber===s.blockNumber&&g.transactionIndex>=s.transactionIndex)return fail('ORDER_INVALID');
  // Old functions recheck only the anchor. Recheck every observed creation block too.
  for(const [number,expected] of observed){const actual=block(await read(()=>reads.block(number)));
    if(actual.number!==number||!same(actual.hash,expected.hash)||actual.timestamp!==expected.timestamp)return fail('SNAPSHOT_CHANGED');}
  if(port.blockTag!=='finalized')return fail('FINALIZED_PORT_REQUIRED');await chain();
  const serialize=(value:ReturnType<typeof block>)=>({number:String(value.number),hash:value.hash,timestamp:String(value.timestamp)});
  const proof={schemaVersion:1,scope:'FINALIZED_ORIGINAL_GATE_AND_ESCROW_CREATIONS_CONFIGURED_SOURCE_NOT_OFFICIAL_PROVENANCE',status:'CREATIONS_VERIFIED',config,finalizedAnchor:serialize(anchor),
    gate:{hash:request.gateTransaction,nonce:config.gateNonce,address:config.gate,creationBytecodeHash:gate.creationBytecodeHash,initCodeHash:gate.initCodeHash,runtimeCodeHash:gate.runtimeCodeHash,
      receiptBlock:serialize(observed.get(g.blockNumber)!),transactionIndex:g.transactionIndex},
    escrow:{hash:request.escrowTransaction,nonce:String(BigInt(config.gateNonce)+1n),address:config.pool,creationBytecodeHash:escrow.creationBytecodeHash,initCodeHash:escrow.initCodeHash,runtimeCodeHash:escrow.runtimeCodeHash,
      receiptBlock:serialize(observed.get(s.blockNumber)!),transactionIndex:s.transactionIndex},
    configuredCreationPairVerified:true,officialIntegrationVerified:false,canExecute:false,signaturesRequested:0,transactionsSent:0,financialAcceptanceStatus:'BLOCKED',
    limits:['Two exact original CREATE transactions and caller-supplied source-shaped runtimes/configuration at one finalized anchor only.',
      'Compiler, clean source revision and original artifact bytes must be independently bound by the runner; this parser is not source or official provenance.',
      'Official CVI/CVA origin, Privy origin, funding, policy denial and complete D4 acceptance are separate required evidence. No send, retry or signature is available.']};
  return parsed(Day4CreationPairProofSchema,proof,'PROOF_INVALID');
}
