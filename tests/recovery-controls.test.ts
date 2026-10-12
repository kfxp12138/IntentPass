import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import {attachLoginControls,loginControls} from '../apps/web/src/login-ui.js';
import {attachRecoveryControls,recoveryControls} from '../apps/web/src/recovery-ui.js';
import {RestoredOrderContext} from '../apps/web/src/restored-order-context.js';
import {refreshRestoredContext} from '../apps/web/src/restored-order-ui.js';
import {createApp} from '../apps/web/src/server.js';
import {createPasskeyReference} from '../apps/web/src/passkey-reference.js';
import {encryptCapsule,exportCapsule,type PrfSource} from '../packages/capsule/src/crypto.js';
import {memoryNamespace,authorizationNamespace,MemoryPayloadSchema,type CapsuleFile} from '../packages/capsule/src/format.js';
import {originalOrderReadProof,type RecoveryDeployment} from '../packages/capsule/src/recovery.js';
import {createReport} from '../packages/protocol/src/report.js';
import {originalAuthorizationFixture,readTestHash} from './support/original-authorization.js';

const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const reference={rpId:'localhost',credentialId:'AQ'};
// Platform and DOM doubles only. Encryption, Mera SDK and browser controls are real code.
const output=(salt:Uint8Array)=>new Uint8Array(createHmac('sha256','LOCAL RECOVERY CONTROL TEST').update(salt).digest());
const source:PrfSource={evaluate:async salt=>output(salt)};
async function memoryFile(id:number){
  const dataset=[id,id+1],payload=MemoryPayloadSchema.parse({schemaVersion:1,kind:'memory',policy:{schemaVersion:1,taskId:h(id),datasetHash:createReport(dataset).datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'10',allowedAsset:a(9),requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'},taskInput:{dataset,buyer:a(1),seller:a(2)},evidence:{schemaVersion:2,salt:h(id+100),taskText:`Local task ${id}`,documents:[]}});
  return {payload,file:await encryptCapsule(payload,{namespace:memoryNamespace(payload.policy.taskId),objectId:payload.policy.taskId,revision:'1'},reference,source)};
}
type Event={preventDefault:()=>void};
class Control {
  disabled=false;hidden=false;checked=false;isConnected=true;textContent='';value='';href='';files:{size:number;text:()=>Promise<string>}[]=[];
  private handlers=new Map<string,((event:Event)=>void)[]>();
  addEventListener(event:string,handler:(event:Event)=>void){this.handlers.set(event,[...(this.handlers.get(event)??[]),handler]);}
  emit(event:string){if(event==='click'&&this.disabled)throw new Error('DOM_BUTTON_DISABLED');for(const handler of this.handlers.get(event)??[])handler({preventDefault:()=>{}});}
  querySelectorAll(_selector:string):Control[]{return [];}
  append(child:Control){this.textContent+=child.textContent;}
  reset(){}
}
async function waitFor(done:()=>boolean){const deadline=Date.now()+3000;while(!done()){if(Date.now()>deadline)throw new Error('CONTROL_DID_NOT_FINISH');await new Promise(resolve=>setTimeout(resolve,1));}}
function fixture(options:{deployment?:RecoveryDeployment;wallets?:string[];origin?:string;canRestoreMemory?:()=>boolean}={}){
  const nodes=new Map<string,Control>();for(const match of (loginControls+recoveryControls).matchAll(/id="([^"]+)"/g))nodes.set(match[1],new Control());
  const get=(id:string)=>nodes.get(id)!;get('capsule-preview').hidden=true;
  get('login-form').querySelectorAll=()=>[get('send-code'),get('logout')];get('login-form').reset=()=>{get('login-email').value=get('login-code').value='';};
  const saved=new Map(['document','window','navigator','location'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  let delay:(()=>Promise<void>)|undefined,assertions=0,logouts=0,subject='first-user';
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>get(selector.slice(1)),createElement:()=>new Control()}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true}});
  if(options.origin)Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:options.origin,hostname:'localhost'}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{credentials:{get:async(request:{publicKey:{rpId:string;userVerification:string;allowCredentials:{id:Uint8Array}[];extensions:{prf:{eval:{first:Uint8Array}}}}})=>{
    const r=request.publicKey;assert.equal(r.rpId,reference.rpId);assert.equal(r.userVerification,'required');assert.deepEqual(new Uint8Array(r.allowCredentials[0].id),new Uint8Array([1]));assertions++;await delay?.();
    return {type:'public-key',rawId:new Uint8Array([1]).buffer,getClientExtensionResults:()=>({prf:{results:{first:output(r.extensions.prf.eval.first).buffer}}})};
  }}}});
  let authenticated=false;
  const port:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async(email)=>{subject=email;authenticated=true;},token:async()=>authenticated?'local-session':null,logout:async()=>{logouts++;authenticated=false;}};
  const session=new BrowserSession(async()=>port,async url=>{assert.ok(url==='/api/config'||url==='/api/session');return new Response(JSON.stringify(url==='/api/config'?{privyAppId:'local-app',meraRpId:'localhost',recoveryDeployment:options.deployment??null}:{subject,wallets:options.wallets??[a(1)]}));});
  let context=new RestoredOrderContext(),memory:unknown,orders=0;const references=createPasskeyReference();
  attachRecoveryControls(()=>undefined,payload=>{memory=payload;},()=>{orders++;},references,()=>context,session,options.canRestoreMemory);
  attachLoginControls(()=>{context=new RestoredOrderContext();memory=undefined;references.clear();get('capsule-preview').textContent='';get('capsule-preview').hidden=true;},session);
  return {get,session,context:()=>context,memory:()=>memory,references,counts:()=>({assertions,logouts,orders}),delay:(work:()=>Promise<void>)=>{delay=work;},
    open:(file:CapsuleFile)=>{const text=exportCapsule(file);get('capsule-file').files=[{size:Buffer.byteLength(text),text:async()=>text}];get('decrypt-file').emit('click');},
    login:async(email:string)=>{await waitFor(()=>!get('login-email').disabled);get('login-email').value=email;get('login-code').value='123456';get('login-form').emit('submit');await waitFor(()=>get('login-feedback').textContent.includes('Account verified'));},
    logout:async()=>{get('logout').emit('click');await waitFor(()=>get('login-feedback').textContent.includes('cleared'));},
    cleanup:()=>{for(const [name,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}};
}
test('same recovery controls use the new context after actual logout and login without the old task lock',async()=>{
  const first=await memoryFile(1),second=await memoryFile(2),f=fixture();
  try{
    await f.login('first@example.com');f.open(first.file);await waitFor(()=>!f.get('capsule-preview').hidden);
    assert.deepEqual(f.context().memoryPayload,first.payload);const old=f.context(),generation=f.session.generation;
    await f.logout();assert.ok(f.session.generation>generation);assert.notEqual(f.context(),old);assert.equal(f.memory(),undefined);assert.equal(f.references.get(),undefined);assert.equal(f.get('capsule-preview').textContent,'');
    await f.login('second@example.com');f.open(second.file);await waitFor(()=>!f.get('decrypt-file').disabled);
    assert.deepEqual(f.context().memoryPayload,second.payload);assert.deepEqual(f.memory(),second.payload);assert.equal(f.get('capsule-preview').hidden,false);assert.ok(f.get('capsule-preview').textContent.includes('Local task 2'));assert.deepEqual(f.counts(),{assertions:2,logouts:1,orders:0});
  }finally{f.cleanup();}
});
test('logout during the real recovery control Passkey wait discards its old result and preserves cleared content',async()=>{
  const first=await memoryFile(3),second=await memoryFile(4),f=fixture();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  try{
    await f.login('first@example.com');f.delay(()=>pending);const old=f.context();f.open(first.file);await waitFor(()=>f.counts().assertions===1);
    await f.logout();const feedback=f.get('capsule-feedback').textContent;release();await waitFor(()=>!f.get('decrypt-file').disabled);
    assert.equal(old.memoryPayload,undefined);assert.equal(f.context().memoryPayload,undefined);assert.equal(f.memory(),undefined);assert.equal(f.references.get(),undefined);assert.equal(f.get('capsule-preview').textContent,'');assert.equal(f.get('capsule-preview').hidden,true);assert.equal(f.get('capsule-feedback').textContent,feedback);
    await f.login('second@example.com');f.open(second.file);await waitFor(()=>!f.get('decrypt-file').disabled);assert.deepEqual(f.context().memoryPayload,second.payload);assert.deepEqual(f.counts(),{assertions:2,logouts:1,orders:0});
  }finally{release();f.cleanup();}
});
test('real recovery controls and HTTP read canonical unfunded history with two original namespaces and no wallet operation',async()=>{
  const x=await originalAuthorizationFixture(),memory=MemoryPayloadSchema.parse({schemaVersion:1,kind:'memory',policy:x.payload.policy,evidence:x.payload.evidence,taskInput:{dataset:x.dataset,buyer:x.buyer.address,seller:x.seller.address}});
  const memoryBackup=await encryptCapsule(memory,{namespace:memoryNamespace(memory.policy.taskId),objectId:memory.policy.taskId,revision:'1'},reference,source),authorizationBackup=await encryptCapsule(x.payload,{namespace:authorizationNamespace(x.payload.intent.orderId),objectId:x.payload.intent.orderId,revision:'1'},reference,source);
  let funded=false,reads=0;const requests:{path:string;body:unknown}[]=[];
  const app=await createApp({dependencyPrebundling:false,orderApi:{deployment:x.deployment,auth:{authenticate:async token=>{assert.equal(token,'local-session');return {subject:'local-buyer',wallets:[x.buyer.address]};}},read:async id=>{reads++;assert.equal(id,x.payload.intent.orderId);const order=x.snapshot(funded?'FUNDED':'UNREGISTERED');return funded?{...order,block:{...order.block,number:'101',hash:readTestHash(12)}}:order;}}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`,f=fixture({deployment:x.deployment,wallets:[x.buyer.address],origin}),nativeFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,origin);assert.equal(url.pathname,`/api/orders/${x.payload.intent.orderId}/read-original`);assert.equal(init?.method,'POST');requests.push({path:url.pathname,body:JSON.parse(String(init?.body))});return nativeFetch(input,init);};
  try{
    await f.login('local-buyer@example.com');f.open(memoryBackup);await waitFor(()=>!f.get('decrypt-file').disabled);assert.deepEqual(f.context().memoryPayload,memory);
    f.open(authorizationBackup);await waitFor(()=>!f.get('decrypt-file').disabled);
    assert.ok(f.get('capsule-feedback').textContent.includes('尚未入金'),f.get('capsule-feedback').textContent);assert.equal(f.get('capsule-preview').hidden,false);assert.equal(JSON.parse(f.get('capsule-preview').textContent).state,'UNREGISTERED');
    assert.equal(f.context().hasAuthorization,true);assert.deepEqual(f.context().originalPayload,x.payload);assert.equal(f.context().order?.buyer,a(0));assert.equal(f.context().canHandoff,false);assert.throws(()=>f.context().continuationInput(),/FUNDED_ORDER_REQUIRED/);
    assert.equal((await refreshRestoredContext(f.context(),f.session)).state,'UNREGISTERED');assert.equal(f.context().canHandoff,false);
    funded=true;assert.equal((await refreshRestoredContext(f.context(),f.session)).state,'FUNDED');assert.deepEqual(f.context().continuationInput(),{payload:x.payload});assert.equal(f.context().canHandoff,true);assert.equal(f.context().order?.orderId,x.payload.intent.orderId);
    assert.equal(reads,3);assert.equal(requests.length,3);for(const request of requests){assert.deepEqual(request.body,originalOrderReadProof(x.payload));assert.ok(!JSON.stringify(request.body).includes('LOCAL PRIVATE'));assert.deepEqual(Object.keys(request.body as object).sort(),['grant','intent','ownerSignature']);}
    assert.deepEqual(f.counts(),{assertions:2,logouts:0,orders:1});
  }finally{globalThis.fetch=nativeFetch;f.cleanup();await app.close();}
});

test('unresolved owner request rejects decrypted task replacement before changing RAM context or Passkey reference',async()=>{
  let allowed=false;const original=await memoryFile(32),f=fixture({canRestoreMemory:()=>allowed});try{f.open(original.file);await waitFor(()=>f.get('capsule-feedback').textContent.includes('结果待核对'));assert.equal(f.memory(),undefined);assert.equal(f.context().memoryPayload,undefined);assert.equal(f.references.get(),undefined);assert.equal(f.counts().orders,0);
    allowed=true;f.open(original.file);await waitFor(()=>f.get('capsule-feedback').textContent.includes('已在页面内存恢复'));assert.deepEqual(f.memory(),original.payload);assert.deepEqual(f.context().memoryPayload,original.payload);assert.deepEqual(f.references.get(),reference);assert.equal(f.counts().orders,0);
  }finally{f.cleanup();}
});
