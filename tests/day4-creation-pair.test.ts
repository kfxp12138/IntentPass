import test from 'node:test';
import assert from 'node:assert/strict';
import {concatHex,createPublicClient,custom,decodeFunctionData,encodeAbiParameters,getContractAddress,keccak256,parseAbi,type Address,type Hex} from 'viem';
import {inspectDay4CreationPair} from '../packages/protocol/src/day4-creation-pair.js';
import {day4CreationPairPort} from '../packages/protocol/src/day4-creation-pair-port.js';
import {Day4CreationPairConfigSchema,Day4CreationPairProofSchema,type Day4CreationPairPort} from '../packages/protocol/src/day4-origin-types.js';
import {deploymentDraft} from '../packages/protocol/src/deployment.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA} from '../packages/protocol/src/escrow.js';

// Synthetic artifacts and local responses only. These never constitute actual
// deployment, source/compiler attestation, official CVI/CVA or D4 acceptance.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const word=(value:string)=>value.slice(2).padStart(64,'0');
function fixture(){
  const config={chainId:'10143' as const,deployer:a(1),asset:a(2),validator:a(3),policy:a(4),gate:getContractAddress({from:a(1),nonce:2n}),
    pool:getContractAddress({from:a(1),nonce:3n}),reviewer:a(5),committee:[a(6),a(7),a(8)] as [Address,Address,Address],gateNonce:'2'};
  const request={schemaVersion:1 as const,gateTransaction:h(1),escrowTransaction:h(2)};
  const runtimeTemplate={object:'0x6000'+'0'.repeat(320),linkReferences:{},immutableReferences:{one:[{start:2,length:32},{start:130,length:32}],
    two:[{start:34,length:32}],three:[{start:66,length:32}],four:[{start:98,length:32}]}};
  const artifacts={gate:{abi:[{type:'constructor',stateMutability:'nonpayable',inputs:Array.from({length:4},()=>({type:'address'}))}],
    bytecode:{object:'0x60006000',linkReferences:{}},deployedBytecode:structuredClone(runtimeTemplate)},
    escrow:{abi:[{type:'constructor',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}]}],
      bytecode:{object:'0x60016000',linkReferences:{}},deployedBytecode:structuredClone(runtimeTemplate)}};
  const draft=deploymentDraft({chainId:config.chainId,deployer:config.deployer,asset:config.asset,gate:config.gate,reviewer:config.reviewer,committee:config.committee},artifacts.escrow);
  const gateData=concatHex([artifacts.gate.bytecode.object as Hex,encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],
    [config.asset,config.validator,config.policy,config.pool])]);
  const tx={gate:{hash:h(1),from:a(1),to:null,input:gateData,value:0n,nonce:2,chainId:10143,blockNumber:20n,blockHash:h(20),transactionIndex:4},
    escrow:{hash:h(2),from:a(1),to:null,input:draft.transaction.data,value:0n,nonce:3,chainId:10143,blockNumber:21n,blockHash:h(21),transactionIndex:2}};
  const receipts={gate:{transactionHash:h(1),from:a(1),to:null,status:'success' as 'success'|'reverted',contractAddress:config.gate as Address|null,blockNumber:20n,blockHash:h(20),transactionIndex:4},
    escrow:{transactionHash:h(2),from:a(1),to:null,status:'success' as 'success'|'reverted',contractAddress:config.pool as Address|null,blockNumber:21n,blockHash:h(21),transactionIndex:2}};
  const current={gate:{asset:config.asset,validator:config.validator,policy:config.policy,pool:config.pool},escrow:{asset:config.asset,gate:config.gate,reviewer:config.reviewer,
    committee:[...config.committee],committeeHash:draft.committeeHash,allocationPolicy:ALLOCATION_POLICY,releasePolicy:RELEASE_POLICY,deliverySchema:DELIVERY_SCHEMA}};
  const runtime={gate:('0x6000'+[config.asset,config.validator,config.policy,config.pool,config.asset].map(word).join('')) as Hex,
    escrow:('0x6000'+[config.asset,config.gate,config.reviewer,draft.committeeHash,config.asset].map(word).join('')) as Hex};
  const calls:{method:string;hash?:Hex;address?:Address;number?:bigint}[]=[];
  const port:Day4CreationPairPort={blockTag:'finalized',chainId:async()=>{calls.push({method:'chain'});return 10143;},
    block:async number=>{calls.push({method:'block',number});return {number:number??30n,hash:h(Number(number??30n)),timestamp:100n+(number??30n)};},
    transaction:async hash=>{calls.push({method:'transaction',hash});return hash===h(1)?tx.gate:tx.escrow;},
    receipt:async hash=>{calls.push({method:'receipt',hash});return hash===h(1)?receipts.gate:receipts.escrow;},
    code:async(address,number)=>{calls.push({method:'code',address,number});return address.toLowerCase()===config.gate.toLowerCase()?runtime.gate:runtime.escrow;},
    gateConfiguration:async(address,number)=>{calls.push({method:'gateConfiguration',address,number});return current.gate;},
    escrowConfiguration:async(address,number)=>{calls.push({method:'escrowConfiguration',address,number});return current.escrow;}};
  return {config,request,artifacts,tx,receipts,current,runtime,calls,port};
}
const inspect=(f:ReturnType<typeof fixture>)=>inspectDay4CreationPair(f.request,f.config,f.artifacts,f.port);

test('creation pair binds original same-deployer adjacent CREATE nonces exact code configuration and one finalized anchor',async()=>{
  const f=fixture(),proof=await inspect(f);assert.equal(proof.status,'CREATIONS_VERIFIED');assert.deepEqual(proof.finalizedAnchor,{number:'30',hash:h(30),timestamp:'130'});
  assert.equal(proof.gate.address,f.config.gate);assert.equal(proof.escrow.address,f.config.pool);assert.equal(proof.gate.nonce,'2');assert.equal(proof.escrow.nonce,'3');
  assert.deepEqual(proof.gate.receiptBlock,{number:'20',hash:h(20),timestamp:'120'});assert.equal(proof.gate.transactionIndex,4);
  assert.equal(proof.escrow.runtimeCodeHash,keccak256(f.runtime.escrow));assert.equal(proof.gate.initCodeHash,keccak256(f.tx.gate.input));
  assert.equal(Day4CreationPairProofSchema.safeParse(proof).success,true);assert.equal(proof.financialAcceptanceStatus,'BLOCKED');assert.equal(proof.officialIntegrationVerified,false);
  assert.equal(proof.canExecute,false);assert.equal(proof.transactionsSent,0);assert.equal(proof.signaturesRequested,0);assert.equal(Object.isFrozen(proof.config.committee),true);
  assert.deepEqual(f.calls.filter(value=>value.method==='code'||value.method.endsWith('Configuration')).map(value=>[value.method,value.address,value.number]),
    [['code',f.config.gate,30n],['gateConfiguration',f.config.gate,30n],['code',f.config.pool,30n],['escrowConfiguration',f.config.pool,30n]]);
  assert.equal(f.calls.filter(value=>value.method==='block'&&value.number===undefined).length,1);
  for(const n of [20n,21n,30n])assert.ok(f.calls.filter(value=>value.method==='block'&&value.number===n).length>=2);
});

test('strict requests config and artifacts reject substitutions before any provider read',async()=>{
  for(const patch of [{chainId:'143'},{deployer:'not-an-address'},{asset:a(0)},{gate:a(99)},{pool:a(99)},{gateNonce:'02'},{gateNonce:String(Number.MAX_SAFE_INTEGER)},
    {committee:[a(6),a(6),a(8)]},{arbitraryData:'0x1234'}]){
    const f=fixture();await assert.rejects(inspectDay4CreationPair(f.request,{...f.config,...patch},f.artifacts,f.port),/DAY4_CREATIONS_INPUT_INVALID/);assert.equal(f.calls.length,0);
  }
  for(const request of [{schemaVersion:1,gateTransaction:h(1),escrowTransaction:h(1)},{schemaVersion:1,gateTransaction:'0x01',escrowTransaction:h(2)}]){
    const f=fixture();await assert.rejects(inspectDay4CreationPair(request,f.config,f.artifacts,f.port),/DAY4_CREATIONS_INPUT_INVALID/);assert.equal(f.calls.length,0);}
  for(const which of ['gate','escrow'] as const){const f=fixture();f.artifacts[which].bytecode.object='0x600';await assert.rejects(inspect(f),/DAY4_CREATIONS_ARTIFACT_INVALID/);assert.equal(f.calls.length,0);}
  const f=fixture();f.artifacts.gate.abi[0].stateMutability='payable';await assert.rejects(inspect(f),/DAY4_CREATIONS_ARTIFACT_INVALID/);assert.equal(f.calls.length,0);
});

test('wrong finalized tag and initial chain prevent transaction reads',async()=>{
  const tag=fixture();tag.port.blockTag='latest' as 'finalized';await assert.rejects(inspect(tag),/DAY4_CREATIONS_FINALIZED_PORT_REQUIRED/);assert.equal(tag.calls.length,0);
  for(const chain of [143,'10143',NaN]){const f=fixture();f.port.chainId=async()=>chain as number;await assert.rejects(inspect(f),/DAY4_CREATIONS_CHAIN_MISMATCH/);assert.equal(f.calls.length,0);}
});

test('missing transactions receipts and genuine unfinalized creations remain pending with no runtime reads',async()=>{
  for(const kind of ['transaction','receipt'] as const){const f=fixture();f.port[kind]=async()=>null;await assert.rejects(inspect(f),/DAY4_CREATIONS_PENDING/);assert.equal(f.calls.some(value=>value.method==='code'),false);}
  const f=fixture();Object.assign(f.tx.gate,{blockNumber:31n,blockHash:h(31)});Object.assign(f.receipts.gate,{blockNumber:31n,blockHash:h(31)});
  await assert.rejects(inspect(f),/DAY4_CREATIONS_PENDING/);assert.equal(f.calls.some(value=>value.method==='code'),false);
});

test('reverted original creation is distinct from pending and cannot claim a deployed contract',async()=>{
  for(const role of ['gate','escrow'] as const){const f=fixture();f.receipts[role].status='reverted';f.receipts[role].contractAddress=null;
    await assert.rejects(inspect(f),/DAY4_CREATIONS_REVERTED/);assert.equal(f.calls.some(value=>value.method==='code'&&value.address===(role==='gate'?f.config.gate:f.config.pool)),false);}
});

test('both transactions bind exact original nonce hash sender zero value no recipient chain and full creation calldata',async()=>{
  for(const role of ['gate','escrow'] as const)for(const patch of [{nonce:9},{nonce:2.5},{hash:h(99)},{from:a(99)},{to:a(99)},{value:1n},{chainId:143},
    {input:'0x6000'},{input:fixture().tx[role].input+'00'},{transactionIndex:-1}]){
    const f=fixture();Object.assign(f.tx[role],patch);await assert.rejects(inspect(f),/DAY4_CREATIONS_TRANSACTION_INVALID|DAY4_CREATIONS_RECEIPT_INVALID/);
  }
});

test('receipt sender hash CREATE address block and transaction index metadata cannot be substituted',async()=>{
  for(const role of ['gate','escrow'] as const)for(const patch of [{transactionHash:h(99)},{from:a(99)},{to:a(99)},{contractAddress:a(99)},{contractAddress:null},
    {status:'unknown'},{blockNumber:-1n},{blockNumber:2n**256n},{blockHash:'0x12'},{transactionIndex:99},{transactionIndex:1.5}]){
    const f=fixture();Object.assign(f.receipts[role],patch);await assert.rejects(inspect(f),/DAY4_CREATIONS_RECEIPT_INVALID/);
  }
  const f=fixture();Object.assign(f.tx.gate,{blockNumber:null});await assert.rejects(inspect(f),/DAY4_CREATIONS_TRANSACTION_INVALID/);
});

test('gate must precede escrow including exact original receipt transaction indices within one block',async()=>{
  const valid=fixture();Object.assign(valid.tx.escrow,{blockNumber:20n,blockHash:h(20),transactionIndex:5});Object.assign(valid.receipts.escrow,{blockNumber:20n,blockHash:h(20),transactionIndex:5});assert.equal((await inspect(valid)).status,'CREATIONS_VERIFIED');
  for(const transactionIndex of [3,4]){const f=fixture();Object.assign(f.tx.escrow,{blockNumber:20n,blockHash:h(20),transactionIndex});Object.assign(f.receipts.escrow,{blockNumber:20n,blockHash:h(20),transactionIndex});await assert.rejects(inspect(f),/DAY4_CREATIONS_ORDER_INVALID/);}
  const f=fixture();Object.assign(f.tx.escrow,{blockNumber:19n,blockHash:h(19)});Object.assign(f.receipts.escrow,{blockNumber:19n,blockHash:h(19)});await assert.rejects(inspect(f),/DAY4_CREATIONS_ORDER_INVALID/);
});

test('all block observations require canonical uint256 bigint number timestamp hash and exact requested height',async()=>{
  for(const patch of [{number:null},{hash:null},{number:-1n},{number:2n**256n},{number:30},{timestamp:'130'},{timestamp:-1n},{timestamp:2n**256n},{hash:'0x30'}]){
    const f=fixture();f.port.block=async()=>({number:30n,hash:h(30),timestamp:130n,...patch}) as Awaited<ReturnType<Day4CreationPairPort['block']>>;await assert.rejects(inspect(f),/DAY4_CREATIONS_BLOCK_INVALID/);
  }
  const f=fixture(),read=f.port.block;f.port.block=async n=>({...await read(n),...(n===20n?{number:19n}:{})});await assert.rejects(inspect(f),/DAY4_CREATIONS_BLOCK_INVALID/);
  const g=fixture(),normal=g.port.block;g.port.block=async n=>({...await normal(n),...(n===20n?{hash:h(99)}:{})});await assert.rejects(inspect(g),/DAY4_CREATIONS_RECEIPT_INVALID/);
});

test('end rechecks detect chain tag and every original receipt or anchor number hash and timestamp drift',async()=>{
  for(const height of [20n,21n,30n])for(const field of ['number','hash','timestamp'] as const){
    const f=fixture(),counts=new Map<bigint,number>(),normal=f.port.block;
    f.port.block=async n=>{const result=await normal(n),number=n??30n;counts.set(number,(counts.get(number)??0)+1);
      const ending=f.calls.filter(value=>value.method==='escrowConfiguration').length>0&&(counts.get(number)??0)>1&&number===height;
      return !ending?result:{...result,...(field==='number'?{number:99n}:field==='hash'?{hash:h(99)}:{timestamp:999n})};};
    await assert.rejects(inspect(f),/DAY4_CREATIONS_SNAPSHOT_CHANGED|DAY4_CREATIONS_BLOCK_INVALID/,String(height)+' '+field);
  }
  const chain=fixture(),normal=chain.port.chainId;chain.port.chainId=async()=>chain.calls.some(value=>value.method==='escrowConfiguration')?143:normal();await assert.rejects(inspect(chain),/DAY4_CREATIONS_CHAIN_MISMATCH/);
  const tag=fixture(),configuration=tag.port.escrowConfiguration;tag.port.escrowConfiguration=async(target,n)=>{tag.port.blockTag='latest' as 'finalized';return configuration(target,n);};await assert.rejects(inspect(tag),/DAY4_CREATIONS_FINALIZED_PORT_REQUIRED/);
});

test('runtime code and every fixed current configuration field must match the original pair',async()=>{
  for(const code of [undefined,'0x','0xzz','0x1']){const f=fixture();f.port.code=async()=>code as Hex|undefined;await assert.rejects(inspect(f),/DAY4_CREATIONS_CODE_MISSING|DAY4_CREATIONS_CODE_INVALID/);}
  const bad=fixture();bad.runtime.escrow=('0x6001'+bad.runtime.escrow.slice(6)) as Hex;await assert.rejects(inspect(bad),/DAY4_CREATIONS_RUNTIME_INVALID/);
  for(const field of ['asset','validator','policy','pool']){const f=fixture();Object.assign(f.current.gate,{[field]:a(99)});await assert.rejects(inspect(f),/DAY4_CREATIONS_CONFIGURATION_INVALID/);}
  for(const field of ['asset','gate','reviewer','committeeHash','allocationPolicy','releasePolicy','deliverySchema']){const f=fixture();Object.assign(f.current.escrow,{[field]:field.endsWith('Hash')||field.endsWith('Policy')||field==='deliverySchema'?h(99):a(99)});await assert.rejects(inspect(f),/DAY4_CREATIONS_CONFIGURATION_INVALID/);}
  const f=fixture();f.current.escrow.committee.reverse();await assert.rejects(inspect(f),/DAY4_CREATIONS_CONFIGURATION_INVALID/);
});

test('first-await snapshots keep original request config artifacts and bound methods despite external mutation',async()=>{
  const f=fixture(),saved=structuredClone(f.config),normal=f.port.chainId;let release!:()=>void,count=0;const pause=new Promise<void>(resolve=>{release=resolve;});
  f.port.chainId=async()=>{if(++count===1)await pause;return normal();};const pending=inspect(f);
  f.request.gateTransaction=h(99);f.config.gateNonce='9';f.config.asset=a(99);f.config.committee.reverse();f.artifacts.gate.deployedBytecode.object='0x60ff';f.artifacts.escrow.deployedBytecode.object='0x60ff';
  for(const method of ['block','transaction','receipt','code','gateConfiguration','escrowConfiguration'] as const)f.port[method]=async()=>{throw Error('REPLACED_LOCAL_PORT_METHOD');};
  release();const proof=await pending;assert.deepEqual(proof.config,saved);assert.equal(proof.gate.hash,h(1));assert.equal(proof.gate.runtimeCodeHash,keccak256(f.runtime.gate));
});

test('raw transactions receipts configurations and initial block cannot mutate their already observed evidence during later awaits',async()=>{
  const f=fixture(),normal=f.port.block;const first={number:30n,hash:h(30),timestamp:130n};
  f.port.block=async n=>{if(n===undefined)return first;first.timestamp=999n;f.tx.gate.from=a(99);f.receipts.gate.transactionIndex=99;return normal(n);};
  const escrowConfig=f.port.escrowConfiguration;f.port.escrowConfiguration=async(target,n)=>{f.current.gate.asset=a(99);return escrowConfig(target,n);};
  const proof=await inspect(f);assert.equal(proof.finalizedAnchor.timestamp,'130');assert.equal(proof.gate.transactionIndex,4);assert.equal(proof.config.deployer,a(1));
});

test('provider errors expose only fixed safe codes without synthetic credentials or endpoint text',async()=>{
  const marker=['api','key_'].join('')+'Q'.repeat(40)+' '+['https://','synthetic-user',':','synthetic-password','@','provider.example/private'].join('');
  for(const method of ['chainId','block','transaction','receipt','code','gateConfiguration','escrowConfiguration'] as const){const f=fixture();f.port[method]=async()=>{throw Error(marker);};
    await assert.rejects(inspect(f),(error:unknown)=>error instanceof Error&&error.message==='DAY4_CREATIONS_READ_UNAVAILABLE'&&!String(error).includes(marker));}
});

const getters=parseAbi(['function asset() view returns(address)','function validator() view returns(address)','function policy() view returns(address)',
  'function pool() view returns(address)','function eligibility() view returns(address)','function reviewer() view returns(address)','function committee(uint256) view returns(address)',
  'function committeeHash() view returns(bytes32)','function ALLOCATION_POLICY() view returns(bytes32)','function RELEASE_POLICY() view returns(bytes32)','function DELIVERY_SCHEMA() view returns(bytes32)']);
function adapterFixture(){
  const f=fixture(),calls:{to:string;data:Hex;block:string}[]=[];let bad:Hex|undefined;
  const client=createPublicClient({transport:custom({request:async({method,params})=>{
    if(method!=='eth_call')throw Error('UNEXPECTED_LOCAL_RPC');const [tx,height]=params as unknown as [{to:string;data:Hex},string];calls.push({...tx,block:height});
    const decoded=decodeFunctionData({abi:getters,data:tx.data}),name=decoded.functionName;
    if(bad!==undefined)return bad;
    const source=tx.to.toLowerCase()===f.config.gate.toLowerCase()?f.current.gate:f.current.escrow;
    const value=name==='committee'?f.config.committee[Number(decoded.args![0])]:name==='eligibility'?f.config.gate:
      name==='ALLOCATION_POLICY'?ALLOCATION_POLICY:name==='RELEASE_POLICY'?RELEASE_POLICY:name==='DELIVERY_SCHEMA'?DELIVERY_SCHEMA:(source as Record<string,unknown>)[name];
    return '0x'+word(value as string);
  }},{retryCount:0})});
  return {f,calls,client,port:day4CreationPairPort(client),bad:(value:Hex)=>{bad=value;}};
}

test('factory uses fixed canonical raw configuration getters exact target height and committee indices with no wallet capability',async()=>{
  const f=adapterFixture();assert.deepEqual(await f.port.gateConfiguration(f.f.config.gate,30n),f.f.current.gate);
  assert.deepEqual(await f.port.escrowConfiguration(f.f.config.pool,30n),f.f.current.escrow);
  assert.equal(f.calls.length,14);assert.ok(f.calls.every(call=>call.block==='0x1e'));
  assert.ok(f.calls.slice(0,4).every(call=>call.to.toLowerCase()===f.f.config.gate.toLowerCase()));assert.ok(f.calls.slice(4).every(call=>call.to.toLowerCase()===f.f.config.pool.toLowerCase()));
  assert.deepEqual(f.calls.filter(call=>decodeFunctionData({abi:getters,data:call.data}).functionName==='committee').map(call=>decodeFunctionData({abi:getters,data:call.data}).args),[[0n],[1n],[2n]]);
  assert.equal(Object.isFrozen(f.port),true);assert.deepEqual(Object.keys(f.port),['blockTag','chainId','block','transaction','receipt','code','gateConfiguration','escrowConfiguration']);
});

test('raw getter decoding rejects high address bits truncated trailing nonhex and empty words',async()=>{
  for(const raw of ['0x','0x00','0x'+'g'.repeat(64),h(1)+'00','0x'+'f'.repeat(24)+a(2).slice(2)]){const f=adapterFixture();f.bad(raw as Hex);
    await assert.rejects(f.port.gateConfiguration(f.f.config.gate,30n),/DAY4_CREATIONS_CONFIGURATION_INVALID/);}
});

test('pair schema rejects mismatched adjacent nonce address hashes order and malformed config without throwing',async()=>{
  const f=fixture(),proof=await inspect(f);
  for(const patch of [{deployer:'not-an-address'},{gateNonce:'not-a-uint'},{gate:a(99)}])assert.doesNotThrow(()=>{assert.equal(Day4CreationPairConfigSchema.safeParse({...f.config,...patch}).success,false);});
  for(const value of [{...proof,escrow:{...proof.escrow,nonce:'4'}},{...proof,gate:{...proof.gate,address:a(99)}},{...proof,escrow:{...proof.escrow,hash:proof.gate.hash}},
    {...proof,finalizedAnchor:{...proof.finalizedAnchor,number:'19'}}])assert.equal(Day4CreationPairProofSchema.safeParse(value).success,false);
});
