import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {PublicClient} from 'viem';
import {publicRpcUrl,readPublicOrder,runChainExample} from '../examples/chain-client/client.js';
const manifest=JSON.parse(readFileSync(new URL('../examples/chain-client/monad-testnet.json',import.meta.url),'utf8'));
const source=JSON.parse(readFileSync(new URL('../artifacts/acceptance/general-automation/first-background-purchase.json',import.meta.url),'utf8')).chainProof.finalOrder;
function fixture(){
  const calls:{method:string;target?:string}[]=[],block={number:100n,hash:'0x'+'12'.repeat(32),timestamp:200n};let chain=10143,changed=false,insolvent=false,started:undefined|(()=>void);
  const client={getChainId:async()=>{calls.push({method:'chain'});return chain;},getBlock:async()=>{calls.push({method:'block'});started?.();started=undefined;return {...block,hash:changed?'0x'+'23'.repeat(32):block.hash};},readContract:async(input:{address:string;functionName:string;args?:unknown[]})=>{
    calls.push({method:input.functionName,target:input.address});const d=manifest.deployment;
    switch(input.functionName){case 'asset':return d.asset;case 'eligibility':return d.gate;case 'reviewer':return d.reviewer;case 'committeeHash':return d.committeeHash;
      case 'orders':return [source.contextHash,source.buyer,source.seller,source.payee,10n,0n,BigInt(source.deliveryDeadline),BigInt(source.settlementDeadline),source.datasetHash,source.serviceTermsHash,source.evidenceHash,3,4];
      case 'locked':return insolvent?1n:0n;case 'outstanding':case 'credits':case 'balanceOf':return 0n;case 'withdrawn':return input.args?.[1]===source.payee?10n:0n;default:throw Error('UNEXPECTED_CAPABILITY');}
  }} as unknown as PublicClient;
  return {client,calls,setChain:(value:number)=>{chain=value;},setChanged:()=>{changed=true;},setInsolvent:()=>{insolvent=true;},onFirstBlock:(fn:()=>void)=>{started=fn;}};
}
test('independent public example uses only read capabilities and freezes the declared deployment before asynchronous reads',async()=>{
  const f=fixture(),input=structuredClone(manifest);f.onFirstBlock(()=>{input.deployment.arbiter='0x'+'99'.repeat(20);});
  const result=await readPublicOrder(input,source.orderId,f.client);assert.equal(result.snapshot.state,'ALLOCATED_PAID');assert.equal(result.snapshot.withdrawn.payee,'10');assert.equal(result.transactionsSent,0);
  assert.ok(f.calls.filter(c=>c.target).every(c=>[manifest.deployment.arbiter,manifest.deployment.asset].includes(c.target)));
  assert.ok(f.calls.every(c=>['chain','block','asset','eligibility','reviewer','committeeHash','orders','locked','outstanding','credits','withdrawn','balanceOf'].includes(c.method)));
});
test('public example rejects wrong network pins and an insolvent snapshot instead of reporting a verified read',async()=>{
  const wrong=fixture();wrong.setChain(1);await assert.rejects(readPublicOrder(manifest,source.orderId,wrong.client),/CHAIN_MISMATCH/);
  const insolvent=fixture();insolvent.setInsolvent();await assert.rejects(readPublicOrder(manifest,source.orderId,insolvent.client),/ESCROW_INSOLVENT/);
  const pin=structuredClone(manifest);pin.deployment.asset='0x'+'99'.repeat(20);await assert.rejects(readPublicOrder(pin,source.orderId,fixture().client),/DEPLOYMENT_MISMATCH/);
});
test('public RPC configuration rejects insecure or credential-bearing origins and errors never print transport details',async()=>{
  const syntheticAuthenticatedUrl=['https://','user',':','secret','@example.test'].join('');
  for(const endpoint of ['http://example.test',syntheticAuthenticatedUrl,'https://example.test/#fragment'])assert.throws(()=>publicRpcUrl(endpoint));
  const f=fixture();f.client.getChainId=async()=>{throw Error('PRIVATE_TRANSPORT_DETAILS');};const output:unknown[]=[],errors:string[]=[];
  assert.equal(await runChainExample([source.orderId],{INTENTPASS_RPC_URL:'https://example.test/rpc'},{manifest,client:f.client,out:value=>output.push(value),error:code=>errors.push(code)}),1);
  assert.deepEqual(output,[]);assert.deepEqual(errors,['PUBLIC_CHAIN_READ_UNAVAILABLE']);
});
test('public example does not accept a changed first anchor even if later repeated blocks agree',async()=>{
  const f=fixture(),getBlock=f.client.getBlock.bind(f.client);let n=0;
  f.client.getBlock=(async(...args:Parameters<typeof getBlock>)=>{const result=await getBlock(...args);if(++n===2)f.setChanged();return result;}) as typeof f.client.getBlock;
  await assert.rejects(readPublicOrder(manifest,source.orderId,f.client),/CHAIN_SNAPSHOT_CHANGED|PUBLIC_CHAIN_ANCHOR_CHANGED/);
});
