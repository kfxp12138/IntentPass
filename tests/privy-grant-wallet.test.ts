import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {hashTypedData} from 'viem';
import {grantTypedData,verifyGrantSignature} from '../packages/protocol/src/typed-data.js';
import {signPrivyGrant,createWalletBridge,walletFrameReady,WalletSignatureNotRequested,type WalletSdk,type WalletBridgeFactory} from '../apps/web/src/privy-grant-wallet.js';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
// Provider and platform are explicit local doubles; signatures use temporary local keys.
function fixture(){
  const account=privateKeyToAccount(generatePrivateKey()),other=privateKeyToAccount(generatePrivateKey());
  const base=JSON.parse(readFileSync('fixtures/dev/authorization-vector.json','utf8')).grant,grant={...base,owner:account.address,chainId:'143'};
  const deployment={chainId:'143',arbiter:grant.arbiter,asset:grant.asset,reviewer:a(7),committee:[a(1),a(2),a(3)] as [string,string,string],executor:grant.executor};
  const state={chain:'0x8f',owner:account.address,signer:account,fail:false,users:1,signs:0,bridges:0,disposed:0,afterSignature:()=>{}},methods:string[]=[];
  const provider={request:async({method,params}:any)=>{
    methods.push(method);if(state.fail)throw new Error('private provider credential');
    if(method==='eth_chainId')return state.chain;if(method==='eth_accounts')return [state.owner];
    assert.equal(method,'eth_signTypedData_v4');assert.equal(params[0].toLowerCase(),grant.owner.toLowerCase());
    assert.equal(hashTypedData(JSON.parse(params[1])),hashTypedData(grantTypedData(grant)));state.signs++;const signature=await state.signer.signTypedData(grantTypedData(grant));state.afterSignature();return signature;
  }};
  const sdk={user:{get:async()=>({user:{id:'local-owner',linked_accounts:Array.from({length:state.users},()=>({type:'wallet',chain_type:'ethereum',wallet_client_type:'privy',connector_type:'embedded',address:account.address}))}})},embeddedWallet:{ping:async()=>true,getProvider:async(wallet:any)=>{assert.equal(wallet.address,account.address);return provider;}}} as unknown as WalletSdk;
  const bridge:WalletBridgeFactory=()=>{state.bridges++;return {dispose:()=>{state.disposed++;}};};
  return {account,other,grant,deployment,state,methods,sdk,bridge};
}
test('Privy owner adapter sends only the canonical Grant signing RPC and verifies owner with no wallet creation or transaction',async()=>{
  const x=fixture(),signature=await signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge);
  assert.equal(await verifyGrantSignature(x.grant,signature),true);assert.equal(x.state.signs,1);assert.equal(x.state.disposed,1);
  assert.deepEqual(x.methods,['eth_chainId','eth_accounts','eth_signTypedData_v4','eth_chainId','eth_accounts']);
});
test('Privy Grant adapter rejects changed deployment, ambiguous owner, wrong network, changed account and another signature',async()=>{
  const x=fixture();await assert.rejects(signPrivyGrant({...x.grant,executor:a(30)},x.deployment,x.sdk,'local-app',x.bridge),/DEPLOYMENT_MISMATCH/);assert.equal(x.state.bridges,0);
  for(const users of [0,2]){x.state.users=users;await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/OWNER_UNAVAILABLE/);}x.state.users=1;
  x.state.chain='0x1';await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/CHAIN_MISMATCH/);assert.equal(x.state.signs,0);x.state.chain='0x8f';
  x.state.owner=x.other.address;await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/OWNER_MISMATCH/);assert.equal(x.state.signs,0);x.state.owner=x.account.address;
  x.state.signer=x.other;await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/OWNER_SIGNATURE_INVALID/);
  x.state.signer=x.account;x.state.afterSignature=()=>{x.state.chain='0x1';};await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/CHAIN_MISMATCH/);x.state.chain='0x8f';
  x.state.afterSignature=()=>{x.state.owner=x.other.address;};await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/OWNER_MISMATCH/);x.state.owner=x.account.address;x.state.afterSignature=()=>{};
  x.state.fail=true;await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/^Error: WALLET_SIGNATURE_CANCELLED_OR_UNAVAILABLE$/);
  assert.equal(x.state.disposed,x.state.bridges);
});
test('one SDK instance cannot open concurrent signing frames and an unavailable owner never creates a frame',async()=>{
  const x=fixture();let release!:(value:any)=>void;const original=x.sdk.user.get.bind(x.sdk.user);x.sdk.user.get=()=>new Promise(resolve=>{release=resolve;});
  const pending=signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge);await new Promise(resolve=>setTimeout(resolve,0));
  await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/WALLET_SIGNATURE_PENDING/);
  release(await original());await pending;assert.equal(x.state.signs,1);assert.equal(x.state.bridges,1);
  x.sdk.user.get=async()=>{throw new Error('private token');};await assert.rejects(signPrivyGrant(x.grant,x.deployment,x.sdk,'local-app',x.bridge),/^Error: WALLET_OWNER_UNAVAILABLE$/);assert.equal(x.state.bridges,1);
});
test('only a failure before the Grant signing RPC is known not requested, and expiry is checked immediately before dispatch',async()=>{
  const before=fixture();before.state.chain='0x1';
  await assert.rejects(signPrivyGrant(before.grant,before.deployment,before.sdk,'local-app',before.bridge),error=>error instanceof WalletSignatureNotRequested);
  assert.equal(before.state.signs,0);
  const expired=fixture();expired.grant.deadline=String(Math.floor(Date.now()/1000)-1);
  await assert.rejects(signPrivyGrant(expired.grant,expired.deployment,expired.sdk,'local-app',expired.bridge),error=>error instanceof WalletSignatureNotRequested&&error.message==='AUTHORIZATION_EXPIRED');
  assert.equal(expired.state.signs,0);
  const after=fixture();after.state.signer=after.other;
  await assert.rejects(signPrivyGrant(after.grant,after.deployment,after.sdk,'local-app',after.bridge),error=>error instanceof Error&&!(error instanceof WalletSignatureNotRequested)&&error.message==='WALLET_OWNER_SIGNATURE_INVALID');
  assert.equal(after.state.signs,1);
});
test('a timed-out read-only precheck cannot resume and dispatch a late signing RPC',async()=>{
  const f=fixture();let release!:(chain:string)=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
  f.sdk.embeddedWallet.getProvider=async()=>({request:async({method}:any)=>{f.methods.push(method);if(method==='eth_chainId'){entered();return await new Promise(resolve=>{release=resolve;});}throw Error('LATE_SIGNING_RPC_FORBIDDEN');}} as any);
  const pending=signPrivyGrant(f.grant,f.deployment,f.sdk,'local-app',f.bridge,30);await started;
  await assert.rejects(pending,error=>error instanceof WalletSignatureNotRequested);
  release('0x8f');await new Promise(r=>setTimeout(r,1));assert.deepEqual(f.methods,['eth_chainId']);assert.equal(f.state.disposed,1);assert.equal(f.state.signs,0);
});
test('Privy wallet frame checks exact origin and source, bounds outbound target and removes its listener on disposal',()=>{
  const oldWindow=globalThis.window,oldDocument=globalThis.document;let receive!:(event:any)=>void,loaded!:()=>void,removed=0,handled=0,posted=0,poster:any;
  const contentWindow={postMessage:(message:unknown,origin:string)=>{assert.equal(origin,'https://auth.privy.io');assert.deepEqual(message,{event:'privy:iframe:ready'});posted++;}};
  const frame={contentWindow,remove:()=>{removed++;},setAttribute:()=>{},src:'',addEventListener:(_event:string,fn:()=>void)=>{loaded=fn;},removeEventListener:()=>{}};
  const sdk={embeddedWallet:{getURL:()=> 'https://auth.privy.io/apps/local-app/embedded-wallets',onMessage:()=>{handled++;}},setMessagePoster:(value:any)=>{poster=value;}} as unknown as WalletSdk;
  globalThis.window={addEventListener:(_name:string,listener:any)=>{receive=listener;},removeEventListener:()=>{}} as unknown as Window&typeof globalThis;
  globalThis.document={createElement:()=>frame,body:{append:()=>{}}} as unknown as Document;
  try{
    const bridge=createWalletBridge(sdk,'local-app');
    receive({origin:'https://evil.example',source:contentWindow,data:{event:'privy:iframe:ready'}});receive({origin:'https://auth.privy.io',source:{},data:{event:'privy:iframe:ready'}});assert.equal(handled,0);
    receive({origin:'https://auth.privy.io',source:contentWindow,data:{event:'privy:iframe:ready'}});assert.equal(handled,1);
    receive({origin:'https://auth.privy.io',source:contentWindow,data:JSON.stringify({event:'privy:iframe:ready'})});assert.equal(handled,2);
    for(const data of ['bad-json','x'.repeat(1_000_001),'{"event":"other"}'])receive({origin:'https://auth.privy.io',source:contentWindow,data});assert.equal(handled,2);
    receive({origin:'https://evil.example',source:contentWindow,data:JSON.stringify({event:'privy:iframe:ready'})});assert.equal(handled,2);
    const ready=JSON.stringify({event:'privy:iframe:ready'});
    assert.throws(()=>poster.postMessage(ready,'https://evil.example'),/ORIGIN_INVALID/);
    poster.postMessage(ready,'*');assert.equal(posted,0);loaded();assert.equal(posted,1);
    poster.postMessage(ready,'https://auth.privy.io');assert.equal(posted,2);
    assert.throws(()=>poster.postMessage({},'*'),/MESSAGE_INVALID/);
    for(const message of ['not-json','[]','{"event":"other"}','x'.repeat(1_000_001)])assert.throws(()=>poster.postMessage(message,'*'),/MESSAGE_INVALID/);
    poster.reload();poster.postMessage(ready,'*');assert.equal(posted,2);bridge.dispose();loaded();assert.equal(posted,2);bridge.dispose();assert.equal(removed,1);
    assert.throws(()=>poster.postMessage(ready,'*'),/ORIGIN_INVALID/);
    receive({origin:'https://auth.privy.io',source:contentWindow,data:{event:'privy:iframe:ready'}});assert.equal(handled,2);
    assert.throws(()=>createWalletBridge(sdk,'another-app'),/WALLET_FRAME_INVALID/);
  }finally{if(oldWindow===undefined)Reflect.deleteProperty(globalThis,'window');else globalThis.window=oldWindow;if(oldDocument===undefined)Reflect.deleteProperty(globalThis,'document');else globalThis.document=oldDocument;}
});
test('readiness tolerates a lost startup ping while retaining its deadline and session guard',async()=>{
  let calls=0;
  const sdk={embeddedWallet:{ping:async(timeout:number)=>{assert.ok(timeout>0&&timeout<=250);return ++calls===2;}}} as unknown as WalletSdk;
  assert.equal(await walletFrameReady(sdk),true);assert.equal(calls,2);
  calls=0;sdk.embeddedWallet.ping=async()=>{calls++;return false;};
  // Under a loaded process the 20 ms deadline can pass before the first ping.
  assert.equal(await walletFrameReady(sdk,()=>{},20),false);assert.ok(calls<=2);
  let active=true;sdk.embeddedWallet.ping=async()=>{active=false;return true;};
  await assert.rejects(walletFrameReady(sdk,()=>{if(!active)throw Error('SESSION_CHANGED');}),/SESSION_CHANGED/);
});
test('browser signing rechecks verified account and discards a signature that returns after logout',async()=>{
  const x=fixture(),configuration={privyAppId:'local-app',meraRpId:null,recoveryDeployment:x.deployment};let owner=x.account.address,signs=0,release!:(sig:string)=>void;
  const auth:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-token',logout:async()=>{},signGrant:async grant=>{assert.ok(Object.isFrozen(grant));signs++;return x.account.signTypedData(grantTypedData(grant));}};
  const session=new BrowserSession(async()=>auth,async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-local-owner',wallets:[owner]})));
  const sig=await session.signGrant(x.grant);assert.equal(await verifyGrantSignature(x.grant,sig as `0x${string}`),true);assert.equal(signs,1);
  owner=x.other.address;await assert.rejects(session.signGrant(x.grant),/WALLET_OWNER_MISMATCH/);assert.equal(signs,1);owner=x.account.address;
  let reached!:()=>void;const started=new Promise<void>(resolve=>{reached=resolve;});auth.signGrant=()=>{reached();return new Promise(resolve=>{release=resolve;});};
  const pending=session.signGrant(x.grant);await started;await session.logout();release(sig);await assert.rejects(pending,/SESSION_CHANGED/);
});
