import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeAbiParameters,getContractAddress,type Address,type Hex} from 'viem';
import {cleanverseBootstrapDraft,inspectCleanverseBootstrap,type CleanverseBootstrapReadPort} from '../packages/protocol/src/cleanverse-bootstrap.js';
// Explicit local interface/bytecode doubles; no real official identities, RPC or wallet.
const a=(value:number)=>`0x${value.toString(16).padStart(40,'0')}` as Address;
const h=(value:number)=>`0x${value.toString(16).padStart(64,'0')}` as Hex;
const config={chainId:'10143',deployer:a(1),asset:a(2),validator:a(3),policy:a(4),reviewer:a(5),committee:[a(6),a(7),a(8)]};
const artifact=(types:string[])=>({abi:[{type:'constructor',stateMutability:'nonpayable',inputs:types.map(type=>({type}))}],bytecode:{object:'0x6000'}});
const gate=artifact(['address','address','address','address']);
const escrow=artifact(['address','address','address','address[3]']);
const draft=(nonce=0n)=>cleanverseBootstrapDraft(config,gate,escrow,nonce);
function port():CleanverseBootstrapReadPort{return {
  chainId:async()=>10143,block:async()=>({number:23n,hash:h(23),timestamp:100n}),
  code:async(address,block)=>{assert.equal(block,23n);return [config.asset,config.validator,config.policy].includes(address)?'0x6001':'0x';},
  balance:async()=>100n,currentBalance:async()=>100n,nonce:async()=>0n,
  assetPolicy:async(address,block)=>{assert.equal(address,config.asset);assert.equal(block,23n);return config.policy;}
};}
test('two CREATE drafts bind gate.pool to the next escrow and escrow.gate to the first creation, with exact full constructor data',()=>{
  const result=draft(7n),first=getContractAddress({from:config.deployer,nonce:7n}),second=getContractAddress({from:config.deployer,nonce:8n});
  assert.equal(result.gate.predictedAddress,first);assert.equal(result.escrow.predictedAddress,second);
  assert.deepEqual(decodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],result.gate.constructorArgs),[config.asset,config.validator,config.policy,second]);
  assert.deepEqual(decodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}],result.escrow.constructorArgs),[config.asset,first,config.reviewer,config.committee]);
  for(const transaction of [result.gate.transaction,result.escrow.transaction]){
    assert.equal(transaction.from,config.deployer);assert.equal(transaction.chainId,'10143');assert.equal(transaction.value,'0');
    assert.equal('to' in transaction,false);assert.equal('gas' in transaction,false);assert.equal('maxFeePerGas' in transaction,false);
  }
  assert.equal(result.gate.transaction.nonce,'7');assert.equal(result.escrow.transaction.nonce,'8');
  assert.equal(result.gate.transaction.data,'0x6000'+result.gate.constructorArgs.slice(2));
  assert.equal(result.escrow.transaction.data,'0x6000'+result.escrow.constructorArgs.slice(2));
  assert.equal(result.canExecute,false);assert.equal(result.nonceReserved,false);assert.equal(result.officialIntegrationVerified,false);
  assert.equal(result.gateCreationVerified,false);assert.equal(result.gasSufficiencyVerified,false);
});
test('bootstrap is single testnet, exact config, unique nonzero committee and does not accept private keys or arbitrary transactions',()=>{
  for(const input of [{...config,chainId:'143'},{...config,chainId:'31337'},{...config,asset:a(0)},
    {...config,committee:[a(6),a(6),a(8)]},{...config,privateKey:'forbidden'},{...config,gate:a(9)},{...config,nonce:'0'},{...config,to:a(9)}])
    assert.throws(()=>cleanverseBootstrapDraft(input,gate,escrow,0n));
});
test('safe nonce bound leaves room for second CREATE and rejects wrong type, negative and overflow',()=>{
  for(const nonce of [-1n,BigInt(Number.MAX_SAFE_INTEGER),2n**64n,0 as unknown as bigint])assert.throws(()=>draft(nonce),/NONCE_INVALID/);
  assert.equal(draft(BigInt(Number.MAX_SAFE_INTEGER)-1n).escrow.transaction.nonce,String(Number.MAX_SAFE_INTEGER));
});
test('future CREATE addresses cannot occupy configured dependency or signer roles',()=>{
  const first=draft().gate.predictedAddress,second=draft().escrow.predictedAddress;
  for(const input of [{...config,asset:first},{...config,validator:second},{...config,reviewer:second},
    {...config,committee:[first,a(7),a(8)]}])assert.throws(()=>cleanverseBootstrapDraft(input,gate,escrow,0n),/FUTURE_ADDRESS_ROLE_CONFLICT/);
});
test('gate artifact must have exactly the original nonpayable four-address constructor and linked bytecode',()=>{
  for(const value of [{...gate,abi:[]},{...gate,abi:[...gate.abi,...gate.abi]},artifact(['address']),
    {...gate,abi:[{...gate.abi[0],stateMutability:'payable'}]},{...gate,bytecode:{object:'0x__$unlinked$__'}}])
    assert.throws(()=>cleanverseBootstrapDraft(config,value,escrow,0n));
  assert.throws(()=>cleanverseBootstrapDraft(config,gate,gate,0n),/CONSTRUCTOR_MISMATCH/);
});
test('both full initcodes enforce creation size, including constructor arguments',()=>{
  for(const target of ['gate','escrow']){
    const large={...(target==='gate'?gate:escrow),bytecode:{object:'0x'+'60'.repeat(49152)}};
    assert.throws(()=>cleanverseBootstrapDraft(config,target==='gate'?large:gate,target==='escrow'?large:escrow,0n),/INITCODE_TOO_LARGE/);
  }
});
test('snapshot checks actual dependency code and asset policy in one finalized block and rechecks nonce, while only inspecting unsigned preparation',async()=>{
  const result=await inspectCleanverseBootstrap(config,gate,escrow,port());
  assert.equal(result.inspection.status,'INSPECTED');assert.equal(result.inspection.policyLinked,true);assert.equal(result.inspection.nonceRechecked,true);
  assert.equal(result.inspection.canExecute,false);assert.equal(result.inspection.officialIntegrationVerified,false);
  assert.equal(result.inspection.gasSufficiencyVerified,false);assert.equal(result.inspection.block.number,'23');
  assert.equal(result.inspection.dependencyCodeHashes.length,3);assert.equal(result.inspection.nativeBalance,'100');
});
test('wrong chain or unavailable finalized block cannot produce inspected bootstrap',async()=>{
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),chainId:async()=>143}),/CHAIN_MISMATCH/);
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),block:async()=>({number:null,hash:null,timestamp:0n})}),/FINALIZED_BLOCK_UNAVAILABLE/);
});
test('queued transaction or nonce change during preparation rejects old CREATE sequence',async()=>{
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),nonce:async(_address,tag)=>tag==='pending'?1n:0n}),/PENDING_TRANSACTION/);
  let count=0;
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),nonce:async()=>++count<=2?0n:1n}),/NONCE_CHANGED/);
});
test('missing official dependency code, smart deployer or occupied future address cannot be inspected',async()=>{
  for(const address of [config.asset,config.validator,config.policy])
    await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),code:async(value,block)=>value===address?'0x':port().code(value,block)}),/DEPENDENCY_CODE_MISSING/);
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),code:async(value,block)=>value===config.deployer?'0x6001':port().code(value,block)}),/CONTRACT_ACCOUNT_UNSUPPORTED/);
  for(const address of [draft().gate.predictedAddress,draft().escrow.predictedAddress])
    await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),code:async(value,block)=>value===address?'0x6001':port().code(value,block)}),/PREDICTED_ADDRESS_OCCUPIED/);
});
test('configured policy must match exact asset policy; native balance never stands in for gas sufficiency',async()=>{
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),assetPolicy:async()=>a(9)}),/ASSET_POLICY_MISMATCH/);
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),currentBalance:async()=>-1n}),/BALANCE_INVALID/);
  const empty=await inspectCleanverseBootstrap(config,gate,escrow,{...port(),currentBalance:async()=>0n});
  assert.equal(empty.inspection.status,'BLOCKED');assert.equal(empty.inspection.gasSufficiencyVerified,false);assert.equal(empty.draft.canExecute,false);
});
test('canonical hash or chain change after dependency reads invalidates snapshot',async()=>{
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),block:async(number)=>({number:23n,hash:number===undefined?h(23):h(24),timestamp:100n})}),/SNAPSHOT_CHANGED/);
  let count=0;
  await assert.rejects(inspectCleanverseBootstrap(config,gate,escrow,{...port(),chainId:async()=>++count===1?10143:143}),/SNAPSHOT_CHANGED/);
});
