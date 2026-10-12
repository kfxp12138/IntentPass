import test from 'node:test';
import assert from 'node:assert/strict';
import {attachTaskContextControls} from '../apps/web/src/task-context-ui.js';
import type {BrowserSession} from '../apps/web/src/browser-session.js';
const a=(n:string)=>`0x${n.repeat(40)}`,context={status:'CONFIGURED_CONTEXT',chainId:'10143',buyer:a('1'),seller:a('2'),asset:a('3'),arbiter:a('4'),configurationOnly:true};
class Control{value='';disabled=false;isConnected=true;textContent='';handlers:Function[]=[];addEventListener(_name:string,fn:Function){this.handlers.push(fn);}click(){this.handlers.forEach(fn=>fn());}}
function fixture(){
  const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldFetch=globalThis.fetch,button=new Control(),feedback=new Control(),fields=Object.fromEntries(['buyer','seller','asset','dataset','budget'].map(n=>[n,new Control()]));fields.dataset.value='[5,9]';fields.budget.value='27';
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(s:string)=>s==='#task-form'?{querySelector:(selector:string)=>fields[selector.match(/name="(\w+)"/)![1]]}:s==='#read-task-context'?button:feedback}});
  let locked=false;const session={generation:0,token:async()=> 'local-synthetic-token'};
  attachTaskContextControls(()=>locked,session as unknown as BrowserSession);
  return {button,feedback,fields,session,lock:()=>{locked=true;},close:()=>{globalThis.fetch=oldFetch;if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else Reflect.deleteProperty(globalThis,'document');}};
}
async function settled(){await new Promise(r=>setTimeout(r,10));}
test('configured task context fills only wallet/asset inputs and never confirms a task or changes the chosen data/budget',async()=>{
  const f=fixture();try{globalThis.fetch=async(_url,init)=>{assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),{action:'context'});return new Response(JSON.stringify(context));};f.button.click();await settled();assert.equal(f.fields.buyer.value,context.buyer);assert.equal(f.fields.seller.value,context.seller);assert.equal(f.fields.asset.value,context.asset);assert.equal(f.fields.dataset.value,'[5,9]');assert.equal(f.fields.budget.value,'27');assert.match(f.feedback.textContent,/no permission or payment was sent/);}finally{f.close();}
});
test('late configuration cannot overwrite edits, a changed account or a task locked during the request',async()=>{
  for(const reason of ['edited','account','locked'] as const){const f=fixture();let release!:(r:Response)=>void;try{globalThis.fetch=()=>new Promise(r=>{release=r;});f.button.click();await settled();if(reason==='edited')f.fields.buyer.value='user-edited';if(reason==='account')f.session.generation++;if(reason==='locked')f.lock();release(new Response(JSON.stringify(context)));await settled();assert.equal(f.fields.buyer.value,reason==='edited'?'user-edited':'');assert.equal(f.fields.asset.value,'');}finally{f.close();}}
});
