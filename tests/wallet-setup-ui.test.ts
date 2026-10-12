import test from 'node:test';
import assert from 'node:assert/strict';
import type {Address} from 'viem';
import {attachWalletSetupControls,walletSetupControls,type WalletSetupSession} from '../apps/web/src/wallet-setup-ui.js';

const wallet=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
class Control {
  disabled=false;checked=false;hidden=false;isConnected=true;writes=0;children:Control[]=[];
  private content='';private handlers=new Map<string,Set<()=>void>>();
  get textContent(){return this.content+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.content=value;this.children=[];this.writes++;}
  addEventListener(name:string,handler:()=>void){const handlers=this.handlers.get(name)??new Set();handlers.add(handler);this.handlers.set(name,handlers);}
  removeEventListener(name:string,handler:()=>void){this.handlers.get(name)?.delete(handler);}
  emit(name:string,allowDisabled=false){if(!allowDisabled)assert.equal(this.disabled,false);for(const handler of this.handlers.get(name)??[])handler();}
  append(child:Control){this.children.push(child);this.writes++;}
}
async function waitFor(done:()=>boolean){const deadline=Date.now()+3000;while(!done()){if(Date.now()>deadline)throw new Error('CONTROL_DID_NOT_FINISH');await new Promise(resolve=>setTimeout(resolve,1));}}
const deferred=()=>{let resolve!:(value:{subject:string;addresses:Address[]})=>void;const promise=new Promise<{subject:string;addresses:Address[]}>(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
  const nodes=new Map<string,Control>();for(const match of walletSetupControls.matchAll(/id="([^"]+)"/g))nodes.set(match[1],new Control());
  for(const id of ['login-form','logout'])nodes.set(id,new Control());
  const get=(id:string)=>nodes.get(id)!,oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),events=new Control();
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>nodes.get(selector.slice(1)),createElement:()=>new Control()}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)}});
  let generation=0,readCalls=0,createCalls=0,readWork=async()=>({subject:'private-verified-user',addresses:[wallet(1)]}),createWork=readWork;
  const listeners=new Set<()=>void>(),session:WalletSetupSession={get generation(){return generation;},setupWallets:async()=>{readCalls++;return readWork();},createSetupWallet:async confirmation=>{assert.equal(confirmation,true);createCalls++;return createWork();},onGenerationChange:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const dispose=attachWalletSetupControls(session),read=get('read-setup-wallets'),create=get('create-setup-wallet'),consent=get('setup-wallet-consent'),addresses=get('setup-wallet-addresses'),feedback=get('setup-wallet-feedback');
  return {get,nodes,session,read,create,consent,addresses,feedback,dispose,pagehide:()=>events.emit('pagehide'),counts:()=>({read:readCalls,create:createCalls,listeners:listeners.size}),generationChange:()=>{generation++;for(const listener of listeners)listener();},sessionNotification:()=>{for(const listener of listeners)listener();},setRead:(work:typeof readWork)=>{readWork=work;},setCreate:(work:typeof createWork)=>{createWork=work;},detach:()=>{for(const node of nodes.values())node.isConnected=false;},cleanup:()=>{dispose();if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else Reflect.deleteProperty(globalThis,'document');if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');}};
}

test('wallet preparation attaches with no provider operations and only an explicit read displays checked public addresses',async()=>{
  const f=fixture();try{
    assert.deepEqual(f.counts(),{read:0,create:0,listeners:1});assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);assert.equal(f.addresses.hidden,true);
    f.read.emit('click');await waitFor(()=>!f.read.disabled);
    assert.deepEqual(f.counts(),{read:1,create:0,listeners:1});assert.equal(f.addresses.hidden,false);assert.equal(f.addresses.children.length,1);assert.equal(f.addresses.textContent,wallet(1));
    assert.match(f.feedback.textContent,/wallet is verified/);assert.ok(!f.feedback.textContent.includes('private-verified-user'));assert.equal(f.create.disabled,true);
  }finally{f.cleanup();}
});

test('creation requires the current checkbox, consumes consent and never repeats while awaiting the explicit creation result',async()=>{
  const f=fixture(),pending=deferred();try{
    f.create.emit('click',true);assert.equal(f.counts().create,0);
    f.setCreate(()=>pending.promise);f.consent.checked=true;f.consent.emit('change');assert.equal(f.create.disabled,false);assert.equal(f.counts().create,0);
    f.create.emit('click');assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);assert.equal(f.read.disabled,true);assert.equal(f.counts().create,1);
    f.create.emit('click',true);f.read.emit('click',true);assert.deepEqual(f.counts(),{read:0,create:1,listeners:1});
    pending.resolve({subject:'private-verified-user',addresses:[wallet(2)]});await waitFor(()=>!f.read.disabled);
    assert.equal(f.addresses.textContent,wallet(2));assert.equal(f.create.disabled,true);assert.equal(f.consent.checked,false);
  }finally{pending.resolve({subject:'private-verified-user',addresses:[]});f.cleanup();}
});
test('a known pre-creation frame failure is not reported as an unknown wallet creation',async()=>{
  const f=fixture();try{
    f.setCreate(async()=>{throw Error('WALLET_FRAME_UNAVAILABLE');});f.consent.checked=true;f.consent.emit('change');f.create.emit('click');
    await waitFor(()=>!f.read.disabled);assert.equal(f.counts().create,1);assert.match(f.feedback.textContent,/No creation request was sent/);
    assert.doesNotMatch(f.feedback.textContent,/Creation is unconfirmed/);assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);assert.equal(f.consent.disabled,false);
  }finally{f.cleanup();}
});

test('an unknown creation keeps new creation locked until an explicit read finds a checked original address',async()=>{
  const f=fixture();try{
    f.setCreate(async()=>{throw new Error('private-verified-user private-provider-token');});f.consent.checked=true;f.consent.emit('change');f.create.emit('click');await waitFor(()=>!f.read.disabled);
    assert.match(f.feedback.textContent,/Read the original wallet/);assert.equal(f.create.disabled,true);assert.equal(f.consent.disabled,true);assert.equal(f.addresses.textContent,'');
    assert.ok(!f.feedback.textContent.includes('private-provider-token'));f.consent.checked=true;f.create.emit('click',true);assert.equal(f.counts().create,1);
    f.setRead(async()=>{throw new Error('SETUP_WALLET_CREATION_UNKNOWN');});f.read.emit('click');await waitFor(()=>!f.read.disabled);
    assert.match(f.feedback.textContent,/could not be verified/);assert.equal(f.consent.disabled,true);assert.equal(f.create.disabled,true);assert.equal(f.counts().create,1);
    f.setRead(async()=>{throw new Error('private-provider-token');});f.read.emit('click');await waitFor(()=>!f.read.disabled);assert.equal(f.consent.disabled,true);assert.equal(f.create.disabled,true);
    f.setRead(async()=>({subject:'private-verified-user',addresses:[wallet(3)]}));f.read.emit('click');await waitFor(()=>!f.read.disabled);
    assert.equal(f.addresses.textContent,wallet(3));assert.equal(f.consent.disabled,false);assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);assert.equal(f.counts().create,1);
  }finally{f.cleanup();}
});

test('an explicit successful empty read for another verified account releases the local unknown lock and still requires new creation consent',async()=>{
  const f=fixture();try{
    f.setCreate(async()=>{throw new Error('SETUP_WALLET_CREATION_UNKNOWN');});f.consent.checked=true;f.consent.emit('change');f.create.emit('click');await waitFor(()=>!f.read.disabled);
    assert.equal(f.consent.disabled,true);assert.equal(f.create.disabled,true);assert.equal(f.counts().create,1);
    f.sessionNotification();assert.equal(f.consent.disabled,true);assert.equal(f.counts().read,0);assert.equal(f.counts().create,1);
    f.setRead(async()=>({subject:'another-private-verified-user',addresses:[]}));f.read.emit('click');await waitFor(()=>!f.read.disabled);
    assert.equal(f.consent.disabled,false);assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);assert.equal(f.addresses.hidden,true);assert.equal(f.addresses.textContent,'');assert.match(f.feedback.textContent,/No embedded wallet/);
    assert.ok(!f.feedback.textContent.includes('another-private-verified-user'));assert.deepEqual(f.counts(),{read:1,create:1,listeners:1});
    f.setCreate(async()=>({subject:'another-private-verified-user',addresses:[wallet(4)]}));f.consent.checked=true;f.consent.emit('change');assert.equal(f.create.disabled,false);assert.equal(f.counts().create,1);
    f.create.emit('click');await waitFor(()=>!f.read.disabled);assert.equal(f.counts().create,2);assert.equal(f.addresses.textContent,wallet(4));assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);
  }finally{f.cleanup();}
});

test('each new read clears prior addresses immediately, and failed reads cannot leave old addresses or provider errors',async()=>{
  const f=fixture();try{
    f.read.emit('click');await waitFor(()=>!f.read.disabled);assert.equal(f.addresses.textContent,wallet(1));
    let reject!:(error:Error)=>void;f.setRead(()=>new Promise((_,r)=>{reject=r;}));f.read.emit('click');assert.equal(f.addresses.textContent,'');assert.equal(f.addresses.hidden,true);
    reject(new Error('private-email@example.com private-provider-token'));await waitFor(()=>!f.read.disabled);
    assert.match(f.feedback.textContent,/could not be verified/);assert.equal(f.addresses.textContent,'');assert.ok(!f.feedback.textContent.includes('private-provider-token'));assert.ok(!f.feedback.textContent.includes('private-email'));
  }finally{f.cleanup();}
});

test('generation changes, login submissions and logout clicks immediately clear checked addresses and consent without automatic reads',async()=>{
  for(const change of ['generation','login','logout','notification'] as const){const f=fixture();try{
    f.read.emit('click');await waitFor(()=>!f.read.disabled);f.consent.checked=true;f.consent.emit('change');assert.equal(f.create.disabled,false);
    if(change==='generation')f.generationChange();else if(change==='notification')f.sessionNotification();else f.get(change==='login'?'login-form':'logout').emit(change==='login'?'submit':'click');
    assert.equal(f.addresses.textContent,'');assert.equal(f.addresses.hidden,true);assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);assert.deepEqual(f.counts(),{read:1,create:0,listeners:1});
  }finally{f.cleanup();}}
});

test('pending reads cannot publish old account addresses after a generation change or login lifecycle notification',async()=>{
  for(const change of ['generation','login','notification'] as const){const f=fixture(),pending=deferred();try{
    f.setRead(()=>pending.promise);f.read.emit('click');if(change==='generation')f.generationChange();else if(change==='login')f.get('login-form').emit('submit');else f.sessionNotification();
    const writes=f.addresses.writes,feedback=f.feedback.textContent;pending.resolve({subject:'old-private-user',addresses:[wallet(9)]});await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.addresses.textContent,'');assert.equal(f.addresses.writes,writes);assert.equal(f.feedback.textContent,feedback);assert.equal(f.create.disabled,true);
  }finally{pending.resolve({subject:'old-private-user',addresses:[]});f.cleanup();}}
});

test('navigation disposal, page hiding and detached controls prevent pending results from writing into the old page',async()=>{
  for(const change of ['dispose','pagehide','detach'] as const){const f=fixture(),pending=deferred();try{
    f.setRead(()=>pending.promise);f.read.emit('click');if(change==='dispose')f.dispose();else if(change==='pagehide')f.pagehide();else f.detach();
    const writes=[f.addresses.writes,f.feedback.writes],feedback=f.feedback.textContent;pending.resolve({subject:'old-private-user',addresses:[wallet(9)]});await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.addresses.textContent,'');assert.deepEqual([f.addresses.writes,f.feedback.writes],writes);assert.equal(f.feedback.textContent,feedback);
    if(change!=='detach'){assert.equal(f.counts().listeners,0);f.read.emit('click',true);assert.equal(f.counts().read,1);}
  }finally{pending.resolve({subject:'old-private-user',addresses:[]});f.cleanup();}}
});

test('page hiding clears already visible addresses and consent instead of retaining them for browser page restoration',async()=>{
  const f=fixture();try{
    f.read.emit('click');await waitFor(()=>!f.read.disabled);f.consent.checked=true;f.consent.emit('change');f.pagehide();
    assert.equal(f.addresses.textContent,'');assert.equal(f.addresses.hidden,true);assert.equal(f.consent.checked,false);assert.equal(f.feedback.textContent,'');assert.equal(f.counts().listeners,0);
  }finally{f.cleanup();}
});

test('fresh controls can attach after page disposal without reviving consent, addresses, old handlers or automatic wallet operations',async()=>{
  const f=fixture();let disposeFresh:(()=>void)|undefined;try{
    f.read.emit('click');await waitFor(()=>!f.read.disabled);f.consent.checked=true;f.consent.emit('change');f.pagehide();
    disposeFresh=attachWalletSetupControls(f.session);assert.equal(f.addresses.textContent,'');assert.equal(f.consent.checked,false);assert.equal(f.create.disabled,true);assert.deepEqual(f.counts(),{read:1,create:0,listeners:1});
    f.read.emit('click');await waitFor(()=>!f.read.disabled);assert.equal(f.counts().read,2);assert.equal(f.addresses.textContent,wallet(1));assert.equal(f.counts().create,0);
  }finally{disposeFresh?.();f.cleanup();}
});

test('invalid or repeated address responses fail without partially rendering an unverified address',async()=>{
  for(const addresses of [[wallet(1),'private-provider-token' as Address],[wallet(1),wallet(1)]]){const f=fixture();try{
    f.setRead(async()=>({subject:'private-verified-user',addresses}));f.read.emit('click');await waitFor(()=>!f.read.disabled);
    assert.equal(f.addresses.hidden,true);assert.equal(f.addresses.textContent,'');assert.match(f.feedback.textContent,/could not be verified/);assert.equal(f.counts().create,0);
  }finally{f.cleanup();}}
});
