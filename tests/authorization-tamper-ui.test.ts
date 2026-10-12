import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizationTamperControls,attachAuthorizationTamperControls} from '../apps/web/src/authorization-tamper-ui.js';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import type {RecoveryDeployment} from '../packages/capsule/src/recovery.js';
import {originalAuthorizationFixture,readTestAddress} from './support/original-authorization.js';

// DOM and identity transport doubles; the actual button handler and authorization verifier run.
class Control {
  disabled=false;hidden=false;isConnected=true;textContent='';
  private handlers=new Map<string,(()=>void)[]>();
  addEventListener(event:string,handler:()=>void){this.handlers.set(event,[...(this.handlers.get(event)??[]),handler]);}
  click(){assert.equal(this.disabled,false);for(const handler of this.handlers.get('click')??[])handler();}
}
async function waitFor(done:()=>boolean){const deadline=Date.now()+3000;while(!done()){if(Date.now()>deadline)throw new Error('CONTROL_DID_NOT_FINISH');await new Promise(resolve=>setTimeout(resolve,1));}}
function fixture(payload:unknown,deployment:RecoveryDeployment|null,wallets:string[]){
  const nodes=new Map<string,Control>();for(const match of authorizationTamperControls.matchAll(/id="([^"]+)"/g))nodes.set(match[1],new Control());
  const get=(id:string)=>nodes.get(id)!,documentBefore=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>get(selector.slice(1))}});
  let original=payload,subject='local-original-buyer',sessionReads=0,walletOperations=0,logouts=0;
  let offline=false,delay:((read:number)=>Promise<void>)|undefined;
  const requests:string[]=[],forbiddenWalletOperation=async()=>{walletOperations++;throw new Error('UNEXPECTED_WALLET_OPERATION');};
  const port:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-private-session-token',logout:async()=>{logouts++;},signGrant:forbiddenWalletOperation,approveAsset:forbiddenWalletOperation,deliverOrder:forbiddenWalletOperation,signAcceptance:forbiddenWalletOperation,submitVote:forbiddenWalletOperation,withdrawOrder:forbiddenWalletOperation};
  const session=new BrowserSession(async()=>port,async(input,init)=>{
    const path=String(input);assert.ok(path==='/api/config'||path==='/api/session',path);requests.push(path);
    if(offline)throw new Error('OFFLINE local-private-session-token LOCAL PRIVATE EVIDENCE');
    if(path==='/api/session'){assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer local-private-session-token');sessionReads++;await delay?.(sessionReads);}
    return new Response(JSON.stringify(path==='/api/config'?{privyAppId:'local-app',meraRpId:'localhost',recoveryDeployment:deployment}:{subject,wallets}));
  });
  const paint=attachAuthorizationTamperControls(()=>original,session),button=get('test-authorization-tamper'),preview=get('authorization-tamper-preview'),feedback=get('authorization-tamper-feedback');
  return {button,preview,feedback,session,requests,paint,counts:()=>({sessionReads,walletOperations,logouts}),setPayload:(value:unknown)=>{original=value;},setSubject:(value:string)=>{subject=value;},setOffline:()=>{offline=true;},delay:(work:(read:number)=>Promise<void>)=>{delay=work;},
    cleanup:()=>{if(documentBefore)Object.defineProperty(globalThis,'document',documentBefore);else Reflect.deleteProperty(globalThis,'document');}};
}

test('real tamper button verifies the original first and demonstrates a fixed local rejection without changing it or sending wallet operations',async()=>{
  const x=await originalAuthorizationFixture(),original=JSON.stringify(x.payload),f=fixture(undefined,x.deployment,[x.buyer.address]);
  try{
    assert.equal(f.button.disabled,true);assert.equal(f.requests.length,0);f.setPayload(x.payload);f.paint();assert.equal(f.button.disabled,false);assert.equal(f.requests.length,0);
    f.button.click();await waitFor(()=>!f.button.disabled);
    assert.match(f.feedback.textContent,/local authorization binding rejected/);assert.match(f.feedback.textContent,/not a live onchain rejection test/);assert.equal(f.preview.hidden,false);
    const preview=JSON.parse(f.preview.textContent);assert.deepEqual(Object.keys(preview).sort(),['contextHash','orderId','originalPayee','testField','testPayee']);
    assert.equal(preview.orderId,x.payload.intent.orderId);assert.equal(preview.contextHash,x.payload.grant.contextHash);assert.equal(preview.testField,'intent.payee');assert.equal(preview.originalPayee,x.payload.intent.payee);assert.notEqual(preview.testPayee.toLowerCase(),x.payload.intent.payee.toLowerCase());
    assert.equal(JSON.stringify(x.payload),original);assert.deepEqual(f.requests,['/api/config','/api/session','/api/session']);assert.deepEqual(f.counts(),{sessionReads:2,walletOperations:0,logouts:0});
    for(const secret of ['LOCAL PRIVATE','local-private-session-token','local-original-buyer',x.payload.ownerSignature])assert.ok(!(f.preview.textContent+f.feedback.textContent).includes(secret));
    f.setPayload(undefined);f.paint();assert.equal(f.button.disabled,true);
  }finally{f.cleanup();}
});

test('invalid original authorization, offline identity verification, missing deployment and wrong buyer never count as tamper rejection',async()=>{
  const x=await originalAuthorizationFixture(),invalid=structuredClone(x.payload);invalid.intent.payee=readTestAddress(20);
  const cases=[{payload:invalid,deployment:x.deployment,wallets:[x.buyer.address],offline:false},{payload:x.payload,deployment:x.deployment,wallets:[x.buyer.address],offline:true},{payload:x.payload,deployment:null,wallets:[x.buyer.address],offline:false},{payload:x.payload,deployment:x.deployment,wallets:[readTestAddress(21)],offline:false}];
  for(const scenario of cases){const f=fixture(scenario.payload,scenario.deployment,scenario.wallets);try{
    if(scenario.offline)f.setOffline();f.button.click();await waitFor(()=>!f.button.disabled);
    assert.match(f.feedback.textContent,/The check did not complete/);assert.ok(!f.feedback.textContent.includes('binding rejected'));assert.equal(f.preview.textContent,'');assert.equal(f.preview.hidden,true);assert.equal(f.counts().walletOperations,0);assert.ok(!f.feedback.textContent.includes('LOCAL PRIVATE'));assert.ok(!f.feedback.textContent.includes('local-private-session-token'));
  }finally{f.cleanup();}}
});

test('real tamper button discards an asynchronous result when the verified subject changes, even if the original buyer wallet remains',async()=>{
  const x=await originalAuthorizationFixture(),f=fixture(x.payload,x.deployment,[x.buyer.address]);let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  try{
    f.delay(read=>read===2?pending:Promise.resolve());f.button.click();await waitFor(()=>f.counts().sessionReads===2);f.setSubject('other-local-subject');release();await waitFor(()=>!f.button.disabled);
    assert.match(f.feedback.textContent,/The check did not complete/);assert.equal(f.preview.textContent,'');assert.equal(f.preview.hidden,true);assert.equal(f.counts().walletOperations,0);assert.ok(!f.feedback.textContent.includes('other-local-subject'));
  }finally{release();f.cleanup();}
});

test('logout generation and original-payload replacement invalidate pending real button results',async()=>{
  const x=await originalAuthorizationFixture();
  for(const change of ['logout','payload'] as const){const f=fixture(x.payload,x.deployment,[x.buyer.address]);let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});try{
    f.delay(read=>read===2?pending:Promise.resolve());f.button.click();await waitFor(()=>f.counts().sessionReads===2);
    if(change==='logout')await f.session.logout();else f.setPayload(undefined);
    release();await waitFor(()=>f.feedback.textContent.includes('The check did not complete'));
    assert.equal(f.preview.textContent,'');assert.equal(f.preview.hidden,true);assert.equal(f.counts().walletOperations,0);assert.ok(!f.feedback.textContent.includes('binding rejected'));
    if(change==='payload')assert.equal(f.button.disabled,true);else assert.equal(f.counts().logouts,1);
  }finally{release();f.cleanup();}}
});
