import test from 'node:test';
import assert from 'node:assert/strict';
import {concatHex,encodeAbiParameters,getContractAddress,keccak256,type Address,type Hex} from 'viem';
import {verifyCleanverseGateCreation} from '../packages/protocol/src/cleanverse-gate-proof.js';
import type {CleanverseGateProofPort} from '../packages/protocol/src/cleanverse-gate-proof-types.js';

// Explicit local chain doubles and synthetic bytecode, never a real deployment.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const word=(value:string)=>value.slice(2).padStart(64,'0');
function fixture(){
  const config={chainId:'10143' as const,deployer:a(1),asset:a(2),validator:a(3),policy:a(4),
    pool:getContractAddress({from:a(1),nonce:3n}),nonce:2n};
  const artifact={abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address'}]}],
    bytecode:{object:'0x60006000',linkReferences:{}},deployedBytecode:{object:'0x6000'+'0'.repeat(320),linkReferences:{},
      immutableReferences:{asset:[{start:2,length:32},{start:130,length:32}],validator:[{start:34,length:32}],policy:[{start:66,length:32}],pool:[{start:98,length:32}]}}};
  const args=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],[config.asset,config.validator,config.policy,config.pool]);
  const data=concatHex([artifact.bytecode.object as Hex,args]);
  const runtime=('0x6000'+[config.asset,config.validator,config.policy,config.pool,config.asset].map(word).join('')) as Hex;
  const contract=getContractAddress({from:config.deployer,nonce:config.nonce});
  const tx={hash:h(1),from:config.deployer,to:null,input:data,value:0n,nonce:2,blockNumber:20n,blockHash:h(20),chainId:10143};
  const receipt={transactionHash:h(1),from:config.deployer,to:null,status:'success' as const,contractAddress:contract,blockNumber:20n,blockHash:h(20)};
  const current={asset:config.asset,validator:config.validator,policy:config.policy,pool:config.pool};
  const reads:{method:string;address?:string;block?:bigint}[]=[];
  const port:CleanverseGateProofPort={blockTag:'finalized',chainId:async()=>{reads.push({method:'chainId'});return 10143;},
    block:async number=>{reads.push({method:'block',block:number});const n=number??23n;return {number:n,hash:h(Number(n)),timestamp:100n+n};},
    transaction:async hash=>{assert.equal(hash,h(1));reads.push({method:'transaction'});return structuredClone(tx);},
    receipt:async hash=>{assert.equal(hash,h(1));reads.push({method:'receipt'});return structuredClone(receipt);},
    code:async(address,block)=>{reads.push({method:'code',address,block});return runtime;},
    configuration:async(address,block)=>{reads.push({method:'configuration',address,block});return structuredClone(current);}};
  return {config,artifact,data,runtime,contract,tx,receipt,current,reads,port};
}
const verify=(f:ReturnType<typeof fixture>,port=f.port)=>verifyCleanverseGateCreation(f.config,f.artifact,h(1),port);
const unread={code:async()=>{throw new Error('Runtime read prohibited in local pending/reverted fixture');},
  configuration:async()=>{throw new Error('Configuration read prohibited in local pending/reverted fixture');}};

test('gate proof binds exact four-address original creation, finalized canonical receipt and immutable configuration',async()=>{
  const f=fixture(),proof=await verify(f);
  assert.equal(proof.status,'CONFIRMED');assert.equal(proof.scope,'FINALIZED_ORIGINAL_CLEANVERSE_GATE_CREATION_PROOF');
  assert.equal(proof.chainId,'10143');assert.equal(proof.deployer,f.config.deployer);assert.equal(proof.nonce,'2');
  assert.equal(proof.pool,f.config.pool);assert.equal(proof.predictedAddress,f.contract);assert.equal(proof.contractAddress,f.contract);
  assert.equal(proof.hash,h(1));assert.equal(proof.creationBytecodeHash,keccak256(f.artifact.bytecode.object as Hex));assert.equal(proof.initCodeHash,keccak256(f.data));
  assert.equal(proof.runtimeCodeHash,keccak256(f.runtime));assert.deepEqual(proof.configuration,f.current);
  assert.deepEqual(proof.receiptBlock,{number:'20',hash:h(20)});assert.deepEqual(proof.block,{number:'23',hash:h(23),timestamp:'123'});
  assert.equal(proof.officialIntegrationVerified,false);assert.equal(proof.transactionsSent,0);
  assert.deepEqual(f.reads.filter(read=>['code','configuration'].includes(read.method)),[
    {method:'code',address:f.contract,block:23n},{method:'configuration',address:f.contract,block:23n}]);
  assert.equal(f.reads.filter(read=>read.method==='chainId').length,2);
  assert.deepEqual(f.reads.filter(read=>read.method==='block').map(read=>read.block),[undefined,20n,23n]);
});

test('gate config refuses private-key fields, other networks, zero roles and unsafe or non-bigint nonce before any RPC',async()=>{
  const patches=[{privateKey:"local_test"+"_forbidden_secret"},{chainId:'143'},{asset:a(0)},{validator:a(0)},{policy:a(0)},{pool:a(0)},
    {deployer:a(0)},{nonce:-1n},{nonce:2},{nonce:BigInt(Number.MAX_SAFE_INTEGER)}];
  for(const patch of patches){const f=fixture();await assert.rejects(verifyCleanverseGateCreation({...f.config,...patch},f.artifact,h(1),f.port));assert.deepEqual(f.reads,[]);}
  const f=fixture();await assert.rejects(verifyCleanverseGateCreation(f.config,f.artifact,'0x1234',f.port));assert.deepEqual(f.reads,[]);
});

test('gate proof fixes pool to the next EOA CREATE nonce rather than arbitrary escrow address',async()=>{
  const f=fixture();await assert.rejects(verifyCleanverseGateCreation({...f.config,pool:a(9)},f.artifact,h(1),f.port),/POOL_NONCE_MISMATCH/);assert.deepEqual(f.reads,[]);
  const g=fixture();await assert.rejects(verifyCleanverseGateCreation({...g.config,pool:g.contract},g.artifact,h(1),g.port),/POOL_NONCE_MISMATCH/);assert.deepEqual(g.reads,[]);
});

test('original artifact must expose exactly one nonpayable four-address constructor and unlinked creation bytecode',async()=>{
  const f=fixture(),ctor=f.artifact.abi[0];
  const artifacts=[{...f.artifact,abi:[]},{...f.artifact,abi:[ctor,ctor]},
    {...f.artifact,abi:[{...ctor,stateMutability:'payable'}]},{...f.artifact,abi:[{...ctor,inputs:ctor.inputs.slice(0,3)}]},
    {...f.artifact,abi:[{...ctor,inputs:[...ctor.inputs.slice(0,3),{type:'address[3]'}]}]},
    {...f.artifact,bytecode:{...f.artifact.bytecode,linkReferences:{library:{linked:true}}}}];
  for(const artifact of artifacts){const g=fixture();await assert.rejects(verifyCleanverseGateCreation(g.config,artifact,h(1),g.port),/CONSTRUCTOR_MISMATCH|LINKED_CREATION_UNSUPPORTED/);assert.deepEqual(g.reads,[]);}
  for(const object of ['0x','0x600','0x__$unlinked$__']){const g=fixture();await assert.rejects(verifyCleanverseGateCreation(g.config,{...g.artifact,bytecode:{object}},h(1),g.port));assert.deepEqual(g.reads,[]);}
});

test('original transaction hash, from, chain, nonce, zero value, no recipient and complete creation bytes are mandatory',async()=>{
  const f=fixture();
  for(const patch of [{hash:h(2)},{from:a(9)},{to:a(9)},{chainId:143},{chainId:undefined},{nonce:3},{nonce:-1},{nonce:2.5},{value:1n},
    {input:'0x60016000' as Hex},{input:(f.data+'00') as Hex},{input:f.data.slice(0,-2) as Hex}]){
    const g=fixture();await assert.rejects(verify(g,{...g.port,transaction:async()=>({...g.tx,...patch})}),/TRANSACTION_MISMATCH/);
    assert.equal(g.reads.some(read=>read.method==='code'),false);
  }
  const g=fixture(),wrongArgs=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],[g.config.asset,g.config.validator,a(9),g.config.pool]);
  await assert.rejects(verify(g,{...g.port,transaction:async()=>({...g.tx,input:concatHex([g.artifact.bytecode.object as Hex,wrongArgs])})}),/TRANSACTION_MISMATCH/);
});

test('receipt metadata and original EOA CREATE address cannot be replaced',async()=>{
  const patches=[{transactionHash:h(2)},{from:a(9)},{to:a(9)},{blockNumber:19n},{blockHash:h(19)},{contractAddress:a(9)},
    {status:'unknown'},{contractAddress:null},{contractAddress:undefined}];
  for(const patch of patches){const f=fixture();await assert.rejects(verify(f,{...f.port,receipt:async()=>({...f.receipt,...patch}) as Awaited<ReturnType<CleanverseGateProofPort['receipt']>>}),/RECEIPT_MISMATCH|ADDRESS_MISMATCH|RECEIPT_STATUS_INVALID/);assert.equal(f.reads.some(read=>read.method==='code'),false);}
  const f=fixture();await assert.rejects(verify(f,{...f.port,transaction:async()=>({...f.tx,blockHash:null})}),/TRANSACTION_LOCATION_INVALID/);
});

test('confirmation requires a canonical receipt block and complete finalized snapshot',async()=>{
  const f=fixture();await assert.rejects(verify(f,{...f.port,block:async n=>({number:n??23n,hash:h(n===20n?19:Number(n??23n)),timestamp:100n+(n??23n)})}),/RECEIPT_NOT_CANONICAL/);
  const g=fixture();await assert.rejects(verify(g,{...g.port,block:async n=>({number:n===20n?19n:n??23n,hash:h(Number(n??23n)),timestamp:100n+(n??23n)})}),/RECEIPT_NOT_CANONICAL/);
  for(const patch of [{number:null},{hash:null},{number:-1n},{timestamp:-1n}]){
    const q=fixture();await assert.rejects(verify(q,{...q.port,block:async()=>({number:23n,hash:h(23),timestamp:123n,...patch})}),/FINALIZED_BLOCK_UNAVAILABLE/);
  }
  const q=fixture();await assert.rejects(verify(q,{...q.port,chainId:async()=>143}),/CHAIN_MISMATCH/);
  await assert.rejects(verify(q,{...q.port,blockTag:'latest' as 'finalized'}),/BLOCK_TAG_INVALID/);
});

test('four getters must retain exact asset, validator, policy and next-nonce pool at the finalized block',async()=>{
  for(const field of ['asset','validator','policy','pool']){
    const f=fixture();await assert.rejects(verify(f,{...f.port,configuration:async()=>({...f.current,[field]:a(9)})}),/CONFIGURATION_MISMATCH/);
  }
  const f=fixture();await assert.rejects(verify(f,{...f.port,configuration:async()=>({...f.current,extra:'untrusted'})}),/CONFIGURATION_MISMATCH/);
});

test('runtime must match the original template and all four immutable values including repeated references',async()=>{
  for(const code of [undefined,'0x' as Hex]){const f=fixture();await assert.rejects(verify(f,{...f.port,code:async()=>code}),/CODE_MISSING/);}
  const f=fixture();await assert.rejects(verify(f,{...f.port,code:async()=>('0x6001'+f.runtime.slice(6)) as Hex}),/RUNTIME_MISMATCH/);
  const g=fixture();await assert.rejects(verify(g,{...g.port,code:async()=>(g.runtime.slice(0,-2)+'ff') as Hex}),/IMMUTABLE_INCONSISTENT/);
  const q=fixture();const wrong=('0x6000'+[q.config.asset,q.config.validator,a(9),q.config.pool,q.config.asset].map(word).join('')) as Hex;
  await assert.rejects(verify(q,{...q.port,code:async()=>wrong}),/RUNTIME_MISMATCH/);
  await assert.rejects(verifyCleanverseGateCreation(q.config,{...q.artifact,deployedBytecode:{...q.artifact.deployedBytecode,linkReferences:{library:true}}},h(1),q.port),/LINKED_RUNTIME_UNSUPPORTED/);
});

test('artifact mutation while fetching the transaction cannot replace the original runtime template',async()=>{
  const f=fixture(),changed=('0x6001'+f.runtime.slice(6)) as Hex;
  await assert.rejects(verify(f,{...f.port,transaction:async()=>{
    f.artifact.deployedBytecode.object='0x6001'+'0'.repeat(320);return structuredClone(f.tx);
  },code:async()=>changed}),/RUNTIME_MISMATCH/);
});

test('pending and reverted proofs never read runtime or claim confirmed creation',async()=>{
  const f=fixture();assert.equal((await verify(f,{...f.port,...unread,transaction:async()=>null,receipt:async()=>null})).status,'PENDING');
  const g=fixture();assert.equal((await verify(g,{...g.port,...unread,transaction:async()=>({...g.tx,blockNumber:null,blockHash:null}),receipt:async()=>null})).status,'PENDING');
  const q=fixture();const pending=await verify(q,{...q.port,...unread,transaction:async()=>({...q.tx,blockNumber:24n,blockHash:h(24)}),receipt:async()=>({...q.receipt,blockNumber:24n,blockHash:h(24)})});
  assert.equal(pending.status,'PENDING');assert.equal(pending.contractAddress,undefined);assert.equal(pending.configuration,undefined);
  const r=fixture();const reverted=await verify(r,{...r.port,...unread,receipt:async()=>({...r.receipt,status:'reverted',contractAddress:null})});
  assert.equal(reverted.status,'REVERTED');assert.equal(reverted.contractAddress,undefined);assert.equal(reverted.runtimeCodeHash,undefined);
  assert.deepEqual(reverted.receiptBlock,{number:'20',hash:h(20)});assert.equal(reverted.officialIntegrationVerified,false);
});

test('pending or reverted results still reject missing original transactions and malformed location or receipts',async()=>{
  const f=fixture();await assert.rejects(verify(f,{...f.port,...unread,transaction:async()=>null}),/TRANSACTION_UNAVAILABLE/);
  for(const patch of [{blockNumber:null,blockHash:h(20)},{blockNumber:20n,blockHash:null},{blockNumber:-1n}]){
    const g=fixture();await assert.rejects(verify(g,{...g.port,...unread,transaction:async()=>({...g.tx,...patch}),receipt:async()=>null}),/TRANSACTION_LOCATION_INVALID/);
  }
  for(const patch of [{from:a(9)},{nonce:3},{input:'0x6001' as Hex}]){
    const g=fixture();await assert.rejects(verify(g,{...g.port,...unread,transaction:async()=>({...g.tx,...patch}),receipt:async()=>({...g.receipt,status:'reverted',contractAddress:null})}),/TRANSACTION_MISMATCH/);
  }
  const r=fixture();await assert.rejects(verify(r,{...r.port,...unread,receipt:async()=>({...r.receipt,status:'reverted'})}),/REVERTED_ADDRESS_INVALID/);
  const q=fixture();await assert.rejects(verify(q,{...q.port,...unread,transaction:async()=>({...q.tx,blockNumber:24n,blockHash:h(24)}),receipt:async()=>({...q.receipt,blockNumber:24n,blockHash:h(24),contractAddress:a(9)})}),/ADDRESS_MISMATCH/);
  await assert.rejects(verify(q,{...q.port,...unread,transaction:async()=>({...q.tx,blockNumber:24n,blockHash:h(24)}),receipt:async()=>({...q.receipt,blockNumber:24n,blockHash:h(24),status:'reverted',contractAddress:a(9)})}),/REVERTED_ADDRESS_INVALID/);
});

test('every pending, reverted or confirmed return rechecks the original finalized chain and block',async()=>{
  for(const status of ['unknown','pending','unfinalized','reverted','confirmed']){
    const make=()=>{
      const f=fixture();let patch:Partial<CleanverseGateProofPort>={};
      if(status==='unknown')patch={...unread,transaction:async()=>null,receipt:async()=>null};
      else if(status==='pending')patch={...unread,receipt:async()=>null};
      else if(status==='unfinalized')patch={...unread,transaction:async()=>({...f.tx,blockNumber:24n,blockHash:h(24)}),receipt:async()=>({...f.receipt,blockNumber:24n,blockHash:h(24)})};
      else if(status==='reverted')patch={...unread,receipt:async()=>({...f.receipt,status:'reverted',contractAddress:null})};
      return {f,port:{...f.port,...patch}};
    };
    const first=make();let chains=0;await assert.rejects(verify(first.f,{...first.port,chainId:async()=>++chains===1?10143:143}),/SNAPSHOT_CHANGED/);
    const second=make();await assert.rejects(verify(second.f,{...second.port,block:async n=>({number:n??23n,hash:n===23n?h(99):h(Number(n??23n)),timestamp:100n+(n??23n)})}),/SNAPSHOT_CHANGED/);
    const third=make();await assert.rejects(verify(third.f,{...third.port,block:async n=>({number:n??23n,hash:h(Number(n??23n)),timestamp:100n+(n??23n)+(n===23n?1n:0n)})}),/SNAPSHOT_CHANGED/);
  }
});
