import test from 'node:test';
import assert from 'node:assert/strict';
import {attachPurchaseControls,purchaseControls} from '../apps/web/src/purchase-ui.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {createPasskeyReference} from '../apps/web/src/passkey-reference.js';
import {WalletSignatureNotRequested} from '../apps/web/src/privy-grant-wallet.js';
import {CapsuleFileSchema} from '../packages/capsule/src/format.js';
class Control {
  disabled=false;checked=false;isConnected=true;hidden=false;textContent='';value='';files=[];children:Control[]=[];
  handlers=new Map<string,(()=>void)[]>();
  addEventListener(name:string,work:()=>void){this.handlers.set(name,[...(this.handlers.get(name)??[]),work]);}
  emit(name:string){assert.equal(this.disabled,false);for(const work of this.handlers.get(name)??[])work();}
  click(){this.emit('click');}
  querySelectorAll(){return this.children;}
  append(...children:Control[]){this.children.push(...children);}
  after(){}
  innerHTML='';
}
function dom(){
  const nodes=new Map([...purchaseControls.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Control()]));
  for(const id of ['buyer-handoff-consent','buyer-handoff'])nodes.set(id,new Control());
  const get=(id:string)=>{const node=nodes.get(id);assert.ok(node,id);return node;};
  get('authorization-window').value='300';get('approval-step').value='SET';get('disclose-evidence').checked=true;
  const windowBefore=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true}});
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>get(selector.slice(1)),createElement:()=>new Control()}});
  return {get,close:()=>{if(windowBefore)Object.defineProperty(globalThis,'window',windowBefore);else Reflect.deleteProperty(globalThis,'window');for(const n of nodes.values())n.isConnected=false;if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else Reflect.deleteProperty(globalThis,'document');}};
}
async function waitFor(done:()=>boolean){const end=Date.now()+3000;while(!done()){if(Date.now()>end)throw Error('CONTROL_DID_NOT_FINISH');await new Promise(r=>setTimeout(r,1));}}
async function stage(f:Awaited<ReturnType<typeof purchaseEvidenceFixture>>,ui:ReturnType<typeof dom>){
  const reference=createPasskeyReference();reference.set({rpId:'localhost',credentialId:'AQ'});
  f.session.walletConnection=async wallet=>({wallet,chainId:f.configuration.recoveryDeployment.chainId,status:'READY'});
  attachPurchaseControls(f.task,undefined,reference,undefined,{flow:f.flow,session:f.session,clock:f.clock,prfSource:()=>({evaluate:async()=>new Uint8Array(32).fill(9)})});
  ui.get('auto-purchase-prepare').emit('click');await waitFor(()=>ui.get('auto-purchase-feedback').textContent.startsWith('设备验证与自动准备完成'));
}
async function prepared(){const f=await purchaseEvidenceFixture();f.setChoice('SUPPORTED');await f.flow.catalog();await f.flow.propose([f.entry.quote.quoteId]);await f.flow.review();await f.flow.prepare('41','1200');return f;}
test('actual automatic signing button replaces the running label with a stopped result and keeps an unknown signature frozen',async()=>{
  for(const error of [new Error('WALLET_FRAME_UNAVAILABLE'),new Error('local private provider credential')]){
    const f=await prepared(),ui=dom();let signs=0;
    f.session.signGrant=async()=>{signs++;throw error;};
    try{
      await stage(f,ui);
      const agree=ui.get('agree-grant'),button=ui.get('auto-sign-backup'),feedback=ui.get('auto-purchase-feedback');
      agree.checked=true;agree.emit('change');button.emit('click');await waitFor(()=>feedback.textContent.startsWith('自动推进已停止'));
      assert.equal(signs,1);assert.equal(f.flow.authorizationLocked,true);assert.equal(button.disabled,true);assert.equal(ui.get('auto-purchase-pay').disabled,true);
      assert.ok(!feedback.textContent.includes('正在签署'));assert.match(feedback.textContent,/未取得可核对的原签名/);assert.ok(!feedback.textContent.includes('private provider'));
      assert.match(feedback.textContent,error.message==='WALLET_FRAME_UNAVAILABLE'?/WALLET_FRAME_UNAVAILABLE/:/PURCHASE_OPERATION_UNAVAILABLE/);
      await assert.rejects(f.flow.sign(),/OUTCOME_UNKNOWN/);assert.equal(signs,1);
    }finally{ui.close();}
  }
});
test('failed read-only connection before automatic preparation preserves the original candidate and review without another model or signer call',async()=>{
  const f=await prepared(),ui=dom(),before=structuredClone(f.flow.draft),review=structuredClone(f.flow.reviewResult);
  f.session.walletConnection=async()=>{throw Error('WALLET_CHAIN_MISMATCH');};
  try{
    attachPurchaseControls(f.task,undefined,undefined,undefined,{flow:f.flow,session:f.session,clock:f.clock});ui.get('auto-purchase-prepare').emit('click');
    await waitFor(()=>ui.get('auto-purchase-feedback').textContent.startsWith('自动推进已停止'));
    assert.match(ui.get('auto-purchase-feedback').textContent,/WALLET_CHAIN_MISMATCH/);assert.deepEqual(f.flow.draft,before);assert.deepEqual(f.flow.reviewResult,review);
    assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:0});assert.equal(f.flow.authorizationLocked,false);assert.equal(ui.get('check-purchase-wallet').disabled,false);
  }finally{ui.close();}
});
test('a trusted no-request signing failure keeps the candidate editable and stops the automatic label without retrying',async()=>{
  const f=await prepared(),ui=dom();let attempts=0;const original=structuredClone(f.flow.authorization);
  f.session.signGrant=async()=>{attempts++;throw new WalletSignatureNotRequested(new Error('WALLET_FRAME_UNAVAILABLE'));};
  try{
    await stage(f,ui);
    ui.get('agree-grant').checked=true;ui.get('agree-grant').emit('change');ui.get('auto-sign-backup').emit('click');
    await waitFor(()=>ui.get('auto-purchase-feedback').textContent.startsWith('自动推进已停止'));
    assert.match(ui.get('auto-purchase-feedback').textContent,/本次钱包签署没有发起/);assert.equal(f.flow.authorizationLocked,false);assert.deepEqual(f.flow.authorization,original);assert.equal(attempts,1);
  }finally{ui.close();}
});

test('joint checkout cannot request a signature or asset action without explicit consent and prepared device verification',async()=>{
  const f=await prepared(),ui=dom();let calls=0;f.session.signGrant=async()=>{calls++;throw Error('UNEXPECTED_SIGNING');};
  try{
    attachPurchaseControls(f.task,undefined,undefined,undefined,{flow:f.flow,session:f.session,clock:f.clock});
    assert.equal(ui.get('auto-checkout').disabled,true);ui.get('agree-checkout').checked=true;ui.get('agree-checkout').emit('change');assert.equal(ui.get('auto-checkout').disabled,true);assert.equal(calls,0);assert.equal(f.flow.authorizationLocked,false);
  }finally{ui.close();}
});
test('joint checkout signs and encrypts with the prepared device key but stops before any money action when ciphertext persistence is unknown',async()=>{
  const f=await prepared(),ui=dom(),beforeFetch=globalThis.fetch,locationBefore=Object.getOwnPropertyDescriptor(globalThis,'location');let moneyCalls=0,uploads=0;
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'http://localhost:3000',hostname:'localhost'}});
  globalThis.fetch=async(input,init)=>{
    assert.match(String(input),/\/api\/capsules\//);assert.equal(init?.method,'PUT');const body=JSON.parse(String(init?.body));CapsuleFileSchema.parse(body.file);uploads++;
    assert.ok(!JSON.stringify(body).includes('LOCAL PRIVATE TASK'));return new Response(JSON.stringify({code:'STORE_UNAVAILABLE'}),{status:503});
  };
  f.session.approveAsset=async()=>{moneyCalls++;throw Error('UNEXPECTED_MONEY_ACTION');};
  try{
    await stage(f,ui);ui.get('agree-checkout').checked=true;ui.get('agree-checkout').emit('change');ui.get('auto-checkout').emit('click');
    await waitFor(()=>ui.get('auto-purchase-feedback').textContent.startsWith('自动推进已停止'));
    assert.equal(f.counts().signatures,1);assert.ok(f.flow.signedAuthorization);assert.equal(uploads,1);assert.equal(moneyCalls,0);assert.equal(ui.get('auto-checkout').disabled,true);
  }finally{globalThis.fetch=beforeFetch;if(locationBefore)Object.defineProperty(globalThis,'location',locationBefore);else Reflect.deleteProperty(globalThis,'location');ui.close();}
});
