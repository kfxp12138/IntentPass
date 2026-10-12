import test from 'node:test';
import assert from 'node:assert/strict';
import {attachPurchaseControls,purchaseControls,type PendingAuthorization} from '../apps/web/src/purchase-ui.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {createPasskeyReference} from '../apps/web/src/passkey-reference.js';
// DOM only is a local platform double. The actual UI handlers and flow are used.
class Control {
  disabled=false;checked=false;hidden=false;isConnected=true;value='';type='';children:Control[]=[];private text='';private handlers=new Map<string,((event:{target:Control})=>void)[]>();
  constructor(readonly tag:string,private register:(html:string)=>void){}
  get textContent(){return this.text;}set textContent(value:string){this.text=value;this.children=[];}
  set innerHTML(value:string){this.register(value);}
  append(...children:Control[]){this.children.push(...children);}
  after(_child:Control){}
  querySelectorAll(selector:string):Control[]{return this.children.flatMap(child=>[...(child.tag==='input'&&(!selector.includes(':checked')||child.checked)?[child]:[]),...child.querySelectorAll(selector)]);}
  addEventListener(event:string,work:(event:{target:Control})=>void){this.handlers.set(event,[...(this.handlers.get(event)??[]),work]);}
  emit(event:string,force=false){if(!force&&event==='click'&&this.disabled)throw Error('DOM_BUTTON_DISABLED');for(const handler of this.handlers.get(event)??[])handler({target:this});}
}
function dom(){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),nodes=new Map<string,Control>(),register=(html:string)=>{for(const m of html.matchAll(/<(\w+)[^>]*id="([^"]+)"[^>]*>/g)){const node=new Control(m[1],register);node.hidden=m[0].includes(' hidden');node.disabled=m[0].includes(' disabled');nodes.set(m[2],node);}};register(purchaseControls);nodes.get('authorization-window')!.value='120';nodes.get('approval-step')!.value='SET';
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>nodes.get(selector.slice(1)),createElement:(tag:string)=>new Control(tag,register),createTextNode:(text:string)=>{const n=new Control('text',register);n.textContent=text;return n;}}});
  return {get:(id:string)=>nodes.get(id)!,cleanup:()=>{for(const node of nodes.values())node.isConnected=false;if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}};
}
async function waitFor(done:()=>boolean){const end=Date.now()+5000;while(!done()){if(Date.now()>end)throw Error('EVIDENCE_UI_DID_NOT_FINISH');await new Promise(resolve=>setTimeout(resolve,1));}}
test('actual evidence controls retain old ABSTAIN append escaped text reset consent and require new review before a new permission',async()=>{
  const f=await purchaseEvidenceFixture(),d=dom();let pending:PendingAuthorization|undefined;
  try{attachPurchaseControls(f.task,{get:()=>pending,set:p=>{pending=p;}},createPasskeyReference(),()=>{}, {flow:f.flow,session:f.session,clock:f.clock,onEvidenceChanged:f.updateEvidence});d.get('load-catalog').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);const input=d.get('quote-list').querySelectorAll('input')[0];input.checked=true;d.get('quote-list').emit('change');d.get('disclose-evidence').checked=true;d.get('disclose-evidence').emit('change');d.get('propose-draft').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);assert.ok(f.flow.draft);assert.equal(d.get('additional-evidence').disabled,false);
    d.get('review-draft').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);assert.ok(d.get('purchase-feedback').textContent.includes('审查暂停'));assert.ok(d.get('evidence-history').textContent.includes('ABSTAIN'));assert.equal(d.get('review-draft').disabled,true);
    const old=structuredClone(f.flow.draft!),text='<script>untrusted evidence</script>\nCommercial license addition.';d.get('agree-grant').checked=true;d.get('additional-evidence').value=text;d.get('additional-evidence').emit('input');assert.equal(d.get('disclose-evidence').checked,false);assert.equal(d.get('agree-grant').checked,false);assert.equal(d.get('prepare-grant').disabled,true);assert.equal(d.get('review-draft').disabled,true);d.get('add-evidence').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);
    assert.equal(f.flow.draft?.intent.attempt,'2');assert.notEqual(f.flow.draft?.intent.orderId,old.intent.orderId);assert.deepEqual(f.flow.draft?.evidence.documents,[...old.evidence.documents,{id:'additional-1',subjectQuoteId:f.entry.quote.quoteId,text}]);assert.equal(f.task().evidence.documents.length,3);assert.ok(d.get('draft-preview').textContent.includes(text));assert.equal(d.get('draft-preview').children.length,0);assert.equal(d.get('review-preview').hidden,true);assert.equal(d.get('disclose-evidence').checked,false);assert.equal(f.counts().jev,1);
    f.setChoice('SUPPORTED');d.get('disclose-evidence').checked=true;d.get('disclose-evidence').emit('change');d.get('review-draft').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);assert.ok(d.get('purchase-feedback').textContent.includes('审查通过'));assert.equal(d.get('prepare-grant').disabled,false);assert.equal(d.get('review-draft').disabled,true);assert.ok(d.get('evidence-history').textContent.includes('ABSTAIN'));assert.ok(d.get('evidence-history').textContent.includes('PASS'));d.get('prepare-grant').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);assert.equal(f.flow.authorization?.payload.intent.orderId,f.flow.draft?.intent.orderId);assert.equal(d.get('confirm-grant').disabled,true);assert.equal(pending,undefined);assert.deepEqual(f.counts(),{planner:1,jev:2,signatures:0});
  }finally{d.cleanup();}
});
test('reattached controls retain the exact candidate and review history while invalid input and a signed original cannot replace them',async()=>{
  const f=await purchaseEvidenceFixture();await f.flow.catalog();await f.flow.propose([f.entry.quote.quoteId]);await f.flow.review();const old=structuredClone(f.flow.draft!);let d=dom();
  try{const attach=()=>attachPurchaseControls(f.task,undefined,createPasskeyReference(),()=>{}, {flow:f.flow,session:f.session,clock:f.clock,onEvidenceChanged:f.updateEvidence});attach();assert.equal(d.get('draft-preview').hidden,false);assert.ok(d.get('evidence-history').textContent.includes('ABSTAIN'));assert.equal(d.get('review-draft').disabled,true);d.cleanup();d=dom();attach();assert.deepEqual(f.flow.draft,old);assert.ok(d.get('evidence-history').textContent.includes('ABSTAIN'));
    d.get('additional-evidence').value='x'.repeat(16001);d.get('additional-evidence').emit('input');d.get('add-evidence').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);assert.deepEqual(f.flow.draft,old);assert.ok(d.get('purchase-feedback').textContent.includes('原候选仍保留'));assert.equal(f.counts().jev,1);
    d.get('additional-evidence').value='Valid appended material.';d.get('additional-evidence').emit('input');d.get('add-evidence').emit('click');await waitFor(()=>!d.get('load-catalog').disabled);f.setChoice('SUPPORTED');await f.flow.review();await f.flow.prepare('0','1200');const signed=await f.flow.sign();d.cleanup();d=dom();attach();assert.equal(d.get('additional-evidence').disabled,true);assert.equal(d.get('add-evidence').disabled,true);d.get('additional-evidence').value='Replace after signing.';d.get('add-evidence').emit('click',true);await waitFor(()=>!d.get('authorization-window').isConnected||d.get('purchase-feedback').textContent.includes('不会被改写'));assert.equal(f.flow.signedAuthorization,signed);assert.equal(f.flow.draft?.intent.orderId,signed.payload.intent.orderId);assert.equal(f.counts().signatures,1);
  }finally{d.cleanup();}
});
