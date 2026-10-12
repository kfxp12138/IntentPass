import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPrivyWalletConnection,type WalletSdk,type WalletBridgeFactory} from '../apps/web/src/privy-grant-wallet.js';
const owner='0x0000000000000000000000000000000000000001',other='0x0000000000000000000000000000000000000002';
function fixture(){
  const methods:string[]=[],state={chain:'0x279f',account:owner,users:1,disposed:0,bridges:0};
  const sdk={user:{get:async()=>({user:{id:'local-read-only-owner',linked_accounts:Array.from({length:state.users},()=>({type:'wallet',chain_type:'ethereum',wallet_client_type:'privy',connector_type:'embedded',address:owner}))}})},embeddedWallet:{ping:async()=>true,getProvider:async()=>({request:async({method}:any)=>{methods.push(method);if(method==='eth_chainId')return state.chain;if(method==='eth_accounts')return [state.account];throw Error('MUTATING_RPC_FORBIDDEN');}})}} as unknown as WalletSdk;
  const bridge:WalletBridgeFactory=()=>{state.bridges++;return {dispose:()=>{state.disposed++;}};};
  return {sdk,bridge,state,methods};
}
test('connection check verifies one existing Monad wallet using only two read-only RPCs and disposes its frame',async()=>{
  const f=fixture();assert.deepEqual(await inspectPrivyWalletConnection(owner,'10143',f.sdk,'local-app',()=>{},f.bridge),{wallet:owner,chainId:'10143',status:'READY'});
  assert.deepEqual(f.methods,['eth_chainId','eth_accounts']);assert.equal(f.state.disposed,1);
});
test('wrong network, switched account, ambiguous owner and provider errors cannot become a READY connection',async()=>{
  for(const scenario of ['chain','owner','ambiguous','provider'] as const){const f=fixture();
    if(scenario==='chain')f.state.chain='0x1';if(scenario==='owner')f.state.account=other;if(scenario==='ambiguous')f.state.users=2;
    if(scenario==='provider')f.sdk.embeddedWallet.getProvider=async()=>{throw Error('local private provider token');};
    await assert.rejects(inspectPrivyWalletConnection(owner,'10143',f.sdk,'local-app',()=>{},f.bridge),new RegExp(scenario==='chain'?'WALLET_CHAIN_MISMATCH':scenario==='owner'?'WALLET_OWNER_MISMATCH':scenario==='ambiguous'?'WALLET_OWNER_UNAVAILABLE':'^Error: WALLET_CONNECTION_UNAVAILABLE$'));
    assert.equal(f.state.disposed,f.state.bridges);assert.ok(f.methods.every(m=>['eth_chainId','eth_accounts'].includes(m)));
  }
});
test('timeout and changed session stop later connection steps, and a concurrent signing operation cannot open a second frame',async()=>{
  const f=fixture();let release!:(value:any)=>void,entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});
  f.sdk.user.get=()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const pending=inspectPrivyWalletConnection(owner,'10143',f.sdk,'local-app',()=>{},f.bridge,30);await waiting;
  await assert.rejects(inspectPrivyWalletConnection(owner,'10143',f.sdk,'local-app',()=>{},f.bridge),/WALLET_SIGNATURE_PENDING/);
  await assert.rejects(pending,/WALLET_CONNECTION_UNAVAILABLE/);release({user:{id:'late-owner',linked_accounts:[]}});await new Promise(r=>setTimeout(r,1));
  assert.equal(f.state.bridges,0);assert.deepEqual(f.methods,[]);
  const changed=fixture();let valid=true;changed.sdk.embeddedWallet.ping=async()=>{valid=false;return true;};
  await assert.rejects(inspectPrivyWalletConnection(owner,'10143',changed.sdk,'local-app',()=>{if(!valid)throw Error('SESSION_CHANGED');},changed.bridge),/SESSION_CHANGED/);
  assert.equal(changed.state.disposed,1);assert.deepEqual(changed.methods,[]);
});
