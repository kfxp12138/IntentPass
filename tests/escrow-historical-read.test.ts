import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicClient,custom,decodeFunctionData,encodeFunctionResult,type Address,type Hex,type PublicClient} from 'viem';
import {EscrowReader,OrderSnapshotSchema,type EscrowDeployment} from '../packages/protocol/src/escrow-read.js';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';

// Local read doubles only: no network, real CVA, identity or D4 acceptance.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
type Block={number:bigint|null;hash:Hex|null;timestamp:bigint};
type BlockRequest={blockNumber?:bigint;blockTag?:string};
type Call={address:Address;functionName:string;args?:readonly unknown[];blockNumber:bigint};
const order=()=>[h(11),a(5),a(6),a(7),20n,5n,200n,300n,h(12),h(13),h(14),3,4] as const;
function fixture(tag:'finalized'|'latest'='finalized'){
  const deployment:EscrowDeployment={chainId:'10143',arbiter:a(1),asset:a(2),gate:a(3),reviewer:a(4),committeeHash:h(15)};
  const original=structuredClone(deployment),calls:Call[]=[],blocks:BlockRequest[]=[];
  let chains=0;
  const state={order:order() as readonly unknown[],balance:25n,locked:0n,outstanding:25n,credit:20n,withdrawn:0n,chain:10143,
    values:{} as Record<string,unknown>,block:(request:BlockRequest,_index:number):Block=>({number:request.blockNumber??30n,hash:h(Number(request.blockNumber??30n)),timestamp:1000n+(request.blockNumber??30n)})};
  const client={getChainId:async()=>{chains++;return state.chain;},getBlock:async(request:BlockRequest)=>{const index=blocks.length;blocks.push({...request});return state.block(request,index);},
    readContract:async(input:Call)=>{calls.push({address:input.address,functionName:input.functionName,args:input.args?[...input.args]:undefined,blockNumber:input.blockNumber});if(input.functionName in state.values)return state.values[input.functionName];
      switch(input.functionName){case 'asset':return original.asset;case 'eligibility':return original.gate;case 'reviewer':return original.reviewer;case 'committeeHash':return original.committeeHash;
        case 'orders':return state.order;case 'locked':return state.locked;case 'outstanding':return state.outstanding;case 'credits':return state.credit;case 'withdrawn':return state.withdrawn;case 'balanceOf':return state.balance;default:throw Error('UNEXPECTED_LOCAL_READ');}}
  } as unknown as PublicClient;
  return {deployment,original,calls,blocks,state,client,reader:new EscrowReader(client,deployment,tag),chains:()=>chains};
}

test('historical read fixes every deployment getter order credit withdrawal and CVA balance at the requested finalized height',async()=>{
  const f=fixture(),snapshot=await f.reader.readAt(h(1),23n);
  assert.equal(snapshot.state,'ALLOCATED_PAID');assert.deepEqual(snapshot.block,{number:'23',hash:h(23),timestamp:'1023'});
  assert.deepEqual(snapshot.accounting,{locked:'0',outstanding:'25',balance:'25'});
  assert.equal(snapshot.orderId,h(1));assert.equal(snapshot.contextHash,h(11));assert.equal(snapshot.payee,a(7));assert.equal(snapshot.price,'20');
  assert.equal(OrderSnapshotSchema.safeParse(snapshot).success,true);assert.equal(f.calls.length,12);assert.ok(f.calls.every(call=>call.blockNumber===23n));
  assert.deepEqual(f.calls.map(call=>call.functionName),['asset','eligibility','reviewer','committeeHash','orders','locked','outstanding','credits','credits','withdrawn','withdrawn','balanceOf']);
  assert.deepEqual(f.calls.filter(call=>call.functionName==='credits'||call.functionName==='withdrawn').map(call=>call.args),[[h(1),a(5)],[h(1),a(7)],[h(1),a(5)],[h(1),a(7)]]);
  assert.deepEqual(f.calls.at(-1),{address:a(2),functionName:'balanceOf',args:[a(1)],blockNumber:23n});
  assert.ok(f.calls.slice(0,-1).every(call=>call.address===a(1)));assert.equal(f.chains(),2);
  assert.deepEqual(f.blocks,[{blockTag:'finalized'},{blockNumber:23n},{blockNumber:23n},{blockNumber:30n}]);
  // The historical order's deadlines expired long ago; read permission still works.
  assert.ok(BigInt(snapshot.block.timestamp)>BigInt(snapshot.settlementDeadline));
});

test('historical height and original order id reject malformed values before any RPC and latest has no historical bypass',async()=>{
  for(const height of [-1n,2n**256n,23,NaN,'23',null]){
    const f=fixture();await assert.rejects(f.reader.readAt(h(1),height as bigint),/HISTORICAL_BLOCK_NUMBER_INVALID/);
    assert.equal(f.chains(),0);assert.deepEqual(f.blocks,[]);assert.deepEqual(f.calls,[]);
  }
  const invalid=fixture();await assert.rejects(invalid.reader.readAt('0x23',23n));assert.equal(invalid.chains(),0);
  const local=fixture('latest');await assert.rejects(local.reader.readAt(h(1),23n),/HISTORICAL_FINALIZED_REQUIRED/);assert.equal(local.chains(),0);
});

test('requested future height is rejected after finalized tip with no historical state calls',async()=>{
  const f=fixture();await assert.rejects(f.reader.readAt(h(1),31n),/HISTORICAL_BLOCK_NOT_FINALIZED/);
  assert.deepEqual(f.blocks,[{blockTag:'finalized'}]);assert.deepEqual(f.calls,[]);
});

test('selected and initial finalized tip number hash and timestamp drift invalidate a historical observation',async()=>{
  for(const target of ['selected','tip'] as const)for(const field of ['number','hash','timestamp'] as const){
    const f=fixture(),normal=f.state.block;
    f.state.block=(request,index)=>{const result=normal(request,index),drift=target==='selected'?index===2:index===3;
      return !drift?result:{...result,...(field==='number'?{number:99n}:field==='hash'?{hash:h(99)}:{timestamp:9999n})};};
    await assert.rejects(f.reader.readAt(h(1),23n),/CHAIN_SNAPSHOT_CHANGED/,target+' '+field);
  }
});

test('a selected block must actually be the requested height and the selected tip must match all initial tip fields',async()=>{
  const wrong=fixture(),normal=wrong.state.block;wrong.state.block=(request,index)=>({...normal(request,index),...(index===1?{number:24n}:{})});
  await assert.rejects(wrong.reader.readAt(h(1),23n),/CHAIN_SNAPSHOT_CHANGED/);assert.equal(wrong.calls.length,0);
  for(const patch of [{hash:h(99)},{timestamp:9999n}]){const f=fixture(),normal=f.state.block;f.state.block=(request,index)=>({...normal(request,index),...(index===1?patch:{})});
    await assert.rejects(f.reader.readAt(h(1),30n),/CHAIN_SNAPSHOT_CHANGED/);assert.equal(f.calls.length,0);}
});

test('natural advancement of finalized tip is accepted by rechecking the original tip height rather than the new tip',async()=>{
  const f=fixture(),normal=f.state.block;let tip=30n;
  f.state.block=(request,index)=>{const result=normal(request,index);if(request.blockNumber===undefined)return {...result,number:tip,hash:h(Number(tip)),timestamp:1000n+tip};return result;};
  const read=f.client.readContract;f.client.readContract=(async input=>{tip=31n;return read(input);}) as typeof read;
  const snapshot=await f.reader.readAt(h(1),23n);assert.equal(snapshot.block.number,'23');assert.deepEqual(f.blocks.at(-1),{blockNumber:30n});
  assert.equal(f.blocks.filter(request=>request.blockTag==='finalized').length,1);
});

test('chain mismatch or drift and runtime finalized tag drift reject rather than returning historical state',async()=>{
  for(const initial of [143,'10143',NaN]){const f=fixture();f.state.chain=initial as number;await assert.rejects(f.reader.readAt(h(1),23n),/CHAIN_MISMATCH/);assert.equal(f.blocks.length,0);}
  const drift=fixture(),chain=drift.client.getChainId;let count=0;drift.client.getChainId=async()=>++count===1?chain():143;
  await assert.rejects(drift.reader.readAt(h(1),23n),/CHAIN_MISMATCH/);
  const tag=fixture(),read=tag.client.readContract;tag.client.readContract=(async input=>{(tag.reader as unknown as {blockTag:string}).blockTag='latest';return read(input);}) as typeof read;
  await assert.rejects(tag.reader.readAt(h(1),23n),/CHAIN_SNAPSHOT_CHANGED/);
});

test('tip selected and ending blocks require bigint uint256 number timestamp and canonical hash fields',async()=>{
  const invalid=[{number:-1n},{number:2n**256n},{number:23 as unknown as bigint},{timestamp:-1n},{timestamp:2n**256n},{timestamp:'1023' as unknown as bigint},{hash:'0x23' as Hex}];
  for(const index of [0,1,2,3])for(const patch of invalid){const f=fixture(),normal=f.state.block;f.state.block=(request,i)=>({...normal(request,i),...(index===i?patch:{})});
    await assert.rejects(f.reader.readAt(h(1),23n),/HISTORICAL_BLOCK_INVALID/);if(index<2)assert.equal(f.calls.length,0);}
  for(const patch of [{number:null},{hash:null}]){const f=fixture(),normal=f.state.block;f.state.block=(request,index)=>({...normal(request,index),...(index===1?patch:{})});await assert.rejects(f.reader.readAt(h(1),23n),/BLOCK_UNAVAILABLE/);}
  const zero=fixture();zero.state.block=()=>({number:0n,hash:h(0),timestamp:0n});assert.equal((await zero.reader.readAt(h(1),0n)).block.number,'0');
});

test('caller mutation cannot replace deployment addresses chain client or original query methods during an awaited read',async()=>{
  const f=fixture();let release!:()=>void;const paused=new Promise<void>(resolve=>{release=resolve;});const chain=f.client.getChainId;let count=0;
  f.client.getChainId=async()=>{if(++count===1)await paused;return chain();};
  const pending=f.reader.readAt(h(1),23n);Object.assign(f.deployment,{chainId:'143',arbiter:a(41),asset:a(42),gate:a(43),reviewer:a(44),committeeHash:h(45)});
  f.client.getBlock=async()=>{throw Error('REPLACED_BLOCK_OPERATION');};f.client.readContract=async()=>{throw Error('REPLACED_CONTRACT_OPERATION');};
  (f.reader as unknown as {client:PublicClient}).client={} as PublicClient;release();
  const snapshot=await pending;assert.equal(snapshot.chainId,'10143');assert.equal(snapshot.arbiter,a(1));assert.equal(snapshot.asset,a(2));
  assert.ok(f.calls.slice(0,-1).every(call=>call.address===a(1)));assert.equal(f.calls.at(-1)?.address,a(2));
});

test('deployment drift invalid order state insolvent balances and invalid historical values remain rejected',async()=>{
  for(const key of ['asset','eligibility','reviewer','committeeHash']){const f=fixture();f.state.values[key]=key==='committeeHash'?h(99):a(99);await assert.rejects(f.reader.readAt(h(1),23n),/DEPLOYMENT_MISMATCH/);}
  const state=fixture();state.state.order=[...order().slice(0,-1),7];await assert.rejects(state.reader.readAt(h(1),23n),/STATE_INVALID/);
  const insolvent=fixture();insolvent.state.balance=24n;await assert.rejects(insolvent.reader.readAt(h(1),23n),/ESCROW_INSOLVENT/);
  const invalid=fixture();invalid.state.credit=-1n;await assert.rejects(invalid.reader.readAt(h(1),23n));
});

test('same buyer and payee preserve both original role slots and provider order array cannot mutate after its observation',async()=>{
  const same=fixture();same.state.order=order().map((value,index)=>index===3?a(5):value);
  const snapshot=await same.reader.readAt(h(1),23n);assert.equal(snapshot.buyer,snapshot.payee);assert.deepEqual(snapshot.credits,{buyer:'20',payee:'20'});
  assert.deepEqual(same.calls.filter(call=>call.functionName==='credits').map(call=>call.args),[[h(1),a(5)],[h(1),a(5)]]);
  const mutation=fixture(),raw=[...order()] as unknown[];mutation.state.order=raw;const read=mutation.client.readContract;
  mutation.client.readContract=(async input=>{if(input.functionName==='credits'){raw[1]=a(55);raw[3]=a(57);raw[4]=99n;}return read(input);}) as typeof read;
  const stable=await mutation.reader.readAt(h(1),23n);assert.equal(stable.buyer,a(5));assert.equal(stable.payee,a(7));assert.equal(stable.price,'20');
});

test('default current finalized and local latest read stay compatible without historical tip or chain checks',async()=>{
  for(const tag of ['finalized','latest'] as const){const f=fixture(tag),snapshot=await f.reader.read(h(1));
    assert.equal(snapshot.state,'ALLOCATED_PAID');assert.equal(snapshot.block.number,'30');assert.equal(f.chains(),1);
    assert.deepEqual(f.blocks,[{blockTag:tag},{blockNumber:30n}]);assert.ok(f.calls.every(call=>call.blockNumber===30n));}
});

test('historical reader with actual viem memory transport issues only exact readonly RPC calls at the selected height',async()=>{
  const f=fixture(),rpc:{method:string;params?:readonly unknown[]}[]=[],raw=order();
  const client=createPublicClient({transport:custom({request:async({method,params})=>{
    rpc.push({method,params:params as readonly unknown[]|undefined});
    if(method==='eth_chainId')return '0x279f';
    if(method==='eth_getBlockByNumber'){const number=(params as unknown[])[0]==='finalized'?30n:BigInt((params as unknown[])[0] as string);return {number:'0x'+number.toString(16),hash:h(Number(number)),timestamp:'0x'+(1000n+number).toString(16)};}
    if(method==='eth_call'){
      const transaction=(params as unknown[])[0] as {to:string;data:Hex};
      if(transaction.to.toLowerCase()===a(2))return '0x'+(25n).toString(16).padStart(64,'0');
      const decoded=decodeFunctionData({abi:escrowAbi,data:transaction.data}),name=decoded.functionName;
      const value=name==='asset'?a(2):name==='eligibility'?a(3):name==='reviewer'?a(4):name==='committeeHash'?h(15):name==='orders'?raw:name==='locked'?0n:name==='outstanding'?25n:name==='credits'?20n:0n;
      return encodeFunctionResult({abi:escrowAbi,functionName:name,result:value} as Parameters<typeof encodeFunctionResult>[0]);
    }
    throw Error('UNEXPECTED_LOCAL_RPC_METHOD');
  }},{retryCount:0})});
  const snapshot=await new EscrowReader(client,f.deployment).readAt(h(1),23n);assert.equal(snapshot.state,'ALLOCATED_PAID');
  assert.equal(rpc.filter(value=>value.method==='eth_call').length,12);assert.equal(rpc.filter(value=>value.method==='eth_chainId').length,2);
  assert.deepEqual(rpc.filter(value=>value.method==='eth_getBlockByNumber').map(value=>value.params),[['finalized',false],['0x17',false],['0x17',false],['0x1e',false]]);
  assert.ok(rpc.filter(value=>value.method==='eth_call').every(value=>value.params?.[1]==='0x17'));
  assert.equal(rpc.some(value=>/send|sign|wallet|estimate/.test(value.method)),false);
});
