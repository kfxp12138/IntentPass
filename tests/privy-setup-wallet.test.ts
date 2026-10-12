import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivySetupWallet,readPrivySetupWallets} from '../apps/web/src/privy-setup-wallet.js';
import type {WalletSdk,WalletBridgeFactory} from '../apps/web/src/privy-grant-wallet.js';
import {withWalletOperation} from '../apps/web/src/privy-wallet-operation.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
function fixture(){
  const state={subject:'local-user',addresses:[] as string[],external:[a(2)],solana:false,reads:0,creates:0,bridges:0,disposed:0,ping:true,fail:false,afterCreate:()=>{}};
  const user=()=>({id:state.subject,linked_accounts:[...state.addresses.map(address=>({type:'wallet',chain_type:'ethereum',wallet_client_type:'privy',connector_type:'embedded',address})),...state.external.map(address=>({type:'wallet',chain_type:'ethereum',wallet_client_type:'metamask',connector_type:'injected',address})),...(state.solana?[{type:'wallet',chain_type:'solana',wallet_client_type:'privy',connector_type:'embedded',address:'local-solana'}]:[])]});
  const sdk={user:{get:async()=>{state.reads++;return {user:user()};}},embeddedWallet:{ping:async()=>state.ping,create:async(options:unknown)=>{assert.deepEqual(options,{});state.creates++;if(state.fail)throw new Error('PRIVATE_PROVIDER_MESSAGE');state.addresses=[a(1)];state.afterCreate();return {user:user()};},getProvider:()=>{throw Error('FORBIDDEN_PROVIDER');},export:()=>{throw Error('FORBIDDEN_EXPORT');}},setMessagePoster:()=>{}} as unknown as WalletSdk;
  const bridge:WalletBridgeFactory=()=>{state.bridges++;return {dispose:()=>{state.disposed++;}};};return {state,user,sdk,bridge};
}
test('setup metadata reads only user embedded Ethereum addresses and never opens a wallet frame',async()=>{
  const x=fixture();x.state.addresses=[a(1),a(1)];x.state.solana=true;
  assert.deepEqual(await readPrivySetupWallets('local-user',x.sdk),{subject:'local-user',addresses:[a(1)]});assert.equal(x.state.reads,1);assert.equal(x.state.creates,0);assert.equal(x.state.bridges,0);
  await assert.rejects(readPrivySetupWallets('other-user',x.sdk),/SESSION_CHANGED/);
});
test('explicit creation uses one options object and disposes its frame; existing wallet is read only',async()=>{
  const x=fixture();assert.deepEqual(await createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),{subject:'local-user',addresses:[a(1)]});
  assert.equal(x.state.creates,1);assert.equal(x.state.bridges,1);assert.equal(x.state.disposed,1);
  assert.deepEqual(await createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),{subject:'local-user',addresses:[a(1)]});assert.equal(x.state.creates,1);assert.equal(x.state.bridges,1);
});
test('missing consent wrong subject unavailable frame and existing Solana never create',async()=>{
  const x=fixture();await assert.rejects(createPrivySetupWallet('local-user',false,x.sdk,'local-app',()=>{},x.bridge),/CONFIRMATION_REQUIRED/);assert.equal(x.state.reads,0);
  await assert.rejects(createPrivySetupWallet('other-user',true,x.sdk,'local-app',()=>{},x.bridge),/SESSION_CHANGED/);assert.equal(x.state.bridges,0);
  x.state.ping=false;await assert.rejects(createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),/FRAME_UNAVAILABLE/);
  x.state.ping=true;x.state.solana=true;await assert.rejects(createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),/EXISTING_SOLANA_UNSUPPORTED/);assert.equal(x.state.creates,0);assert.equal(x.state.disposed,x.state.bridges);
});
test('creation failure stays unknown and cannot retry from an absent wallet list',async()=>{
  const x=fixture();x.state.fail=true;await assert.rejects(createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),/^Error: WALLET_SETUP_CREATION_OUTCOME_UNKNOWN$/);
  x.state.fail=false;await assert.rejects(createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),/CREATION_OUTCOME_UNKNOWN/);assert.equal(x.state.creates,1);
  x.state.addresses=[a(1)];assert.deepEqual(await createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),{subject:'local-user',addresses:[a(1)]});assert.equal(x.state.creates,1);
});
test('UI timeout keeps original SDK mutex while in flight and disposes before late completion',async()=>{
  const x=fixture();let release!:(result:unknown)=>void,started!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;});
  x.sdk.embeddedWallet.create=(()=>{x.state.creates++;started();return new Promise<unknown>(resolve=>{release=resolve;});}) as WalletSdk['embeddedWallet']['create'];
  const result=createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge,15);await reached;await assert.rejects(result,/CREATION_OUTCOME_UNKNOWN/);assert.equal(x.state.disposed,1);
  await assert.rejects(withWalletOperation(x.sdk,async()=>undefined),/WALLET_SIGNATURE_PENDING/);assert.equal(x.state.creates,1);
  release({user:x.user()});await new Promise(resolve=>setTimeout(resolve,0));await withWalletOperation(x.sdk,async()=>undefined);
  await assert.rejects(createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),/CREATION_OUTCOME_UNKNOWN/);assert.equal(x.state.creates,1);assert.equal(x.state.disposed,1);
});
test('concurrent SDK wallet actions cannot create and subject change or logout discards returned address',async()=>{
  const x=fixture();let release!:()=>void,started!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;});
  const locked=withWalletOperation(x.sdk,async()=>{started();await new Promise<void>(resolve=>{release=resolve;});});await reached;
  await assert.rejects(createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),/WALLET_SIGNATURE_PENDING/);release();await locked;assert.equal(x.state.creates,0);
  x.state.afterCreate=()=>{x.state.subject='different-user';};await assert.rejects(createPrivySetupWallet('local-user',true,x.sdk,'local-app',()=>{},x.bridge),/CREATION_OUTCOME_UNKNOWN/);assert.equal(x.state.disposed,1);
  const y=fixture();let active=true;y.state.afterCreate=()=>{active=false;};await assert.rejects(createPrivySetupWallet('local-user',true,y.sdk,'local-app',()=>{if(!active)throw Error('SESSION_CHANGED');},y.bridge),/CREATION_OUTCOME_UNKNOWN/);assert.equal(y.state.disposed,1);
});
