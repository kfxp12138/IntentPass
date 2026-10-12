import test from 'node:test';
import assert from 'node:assert/strict';
import {attachLocalTaskControls,localTaskControls} from '../apps/web/src/local-task-ui.js';
import {createReport} from '../packages/protocol/src/report.js';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const dataset=[3,7,11,19];
const original={policy:{schemaVersion:1,taskId:h(1),datasetHash:createReport(dataset).datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'10',allowedAsset:a(9),requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'},taskInput:{dataset,buyer:a(1),seller:a(2)},evidence:{schemaVersion:2,salt:h(8),taskText:'Original task',documents:[]}};
class Control {files:{size:number;text:()=>Promise<string>}[]=[];disabled=false;checked=false;isConnected=true;value='';textContent='';href='';target='';rel='';private handlers=new Map<string,(()=>void)[]>();addEventListener(event:string,handler:()=>void){this.handlers.set(event,[...(this.handlers.get(event)??[]),handler]);}emit(event:string){for(const handler of this.handlers.get(event)??[])handler();}append(...children:(Control|string)[]){this.textContent+=children.map(x=>typeof x==='string'?x:x.textContent).join('');}}
function fixture(initial:unknown=original){
  const nodes=new Map([...localTaskControls.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Control()])),saved=new Map(['document','navigator','location'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));let current=initial,locked=false,copies:string[]=[],imports=0;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(s:string)=>nodes.get(s.slice(1)),createElement:()=>new Control()}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async(text:string)=>{copies.push(text);}}}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'http://127.0.0.1:3000',hostname:'127.0.0.1'}});
  attachLocalTaskControls({current:()=>current,locked:()=>locked,import:task=>{imports++;current=task;}});
  return {get:(id:string)=>nodes.get(id)!,copies:()=>copies,imports:()=>imports,current:()=>current,lock:()=>{locked=true;},close:()=>{for(const [k,d] of saved)d?Object.defineProperty(globalThis,k,d):delete(globalThis as unknown as Record<string,unknown>)[k];}};
}
test('clipboard export requires consent and rechecks authorization state at action time',async()=>{
  const f=fixture();try{f.get('copy-local-task').emit('click');assert.equal(f.copies().length,0);f.get('local-task-copy-consent').checked=true;f.get('local-task-copy-consent').emit('change');assert.equal(f.get('copy-local-task').disabled,false);f.lock();f.get('copy-local-task').emit('click');await new Promise(r=>setTimeout(r,0));assert.equal(f.copies().length,0);assert(f.get('local-task-feedback').textContent.includes('not confirmed'));}finally{f.close();}
});
test('import is only performed after consent and preserves the original IDs and evidence rather than generating a new task',()=>{
  const f=fixture(null);try{f.get('local-task-input').value=JSON.stringify(original);f.get('import-local-task').emit('click');assert.equal(f.imports(),0);f.get('local-task-import-consent').checked=true;f.get('import-local-task').emit('click');assert.equal(f.imports(),1);assert.deepEqual(f.current(),original);assert.equal(f.get('local-task-input').value,'');}finally{f.close();}
});
test('importing an already present task does not clear its history, while differing input or a detached view cannot replace it',()=>{
  const f=fixture();try{f.get('local-task-import-consent').checked=true;f.get('local-task-input').value=JSON.stringify(original);f.get('import-local-task').emit('click');assert.equal(f.imports(),0);
    f.get('local-task-import-consent').checked=true;f.get('local-task-input').value=JSON.stringify({...original,evidence:{...original.evidence,salt:h(99)}});f.get('import-local-task').emit('click');assert.equal(f.imports(),0);assert.deepEqual(f.current(),original);
    f.get('local-task-feedback').isConnected=false;f.get('local-task-input').value=JSON.stringify(original);f.get('import-local-task').emit('click');assert.equal(f.imports(),0);
  }finally{f.close();}
});

test('local task file is validated before display and still requires explicit import consent',async()=>{
  const f=fixture(null);try{
    f.get('local-task-file').files=[{size:1000,text:async()=>JSON.stringify(original)}];f.get('local-task-file').emit('change');await new Promise(r=>setTimeout(r,1));
    assert.equal(f.imports(),0);assert.equal(f.get('import-local-task').disabled,true);assert.equal(f.get('local-task-import-consent').checked,false);
    f.get('local-task-import-consent').checked=true;f.get('import-local-task').emit('click');assert.equal(f.imports(),1);assert.deepEqual(f.current(),original);
  }finally{f.close();}
});
test('invalid or oversized files and a lock acquired while reading cannot populate or replace the original task',async()=>{
  for(const scenario of ['invalid','large','locked'] as const){const f=fixture(null);let release!:(text:string)=>void;try{
    f.get('local-task-file').files=[{size:scenario==='large'?1048577:1000,text:()=>scenario==='locked'?new Promise(r=>{release=r;}):Promise.resolve(JSON.stringify(scenario==='invalid'?{...original,ownerSignature:'untrusted-extra-authority'}:original))}];
    f.get('local-task-file').emit('change');if(scenario==='locked'){f.lock();release(JSON.stringify(original));}await new Promise(r=>setTimeout(r,1));
    assert.equal(f.get('local-task-input').value,'');assert.equal(f.imports(),0);assert.equal(f.current(),null);
  }finally{f.close();}}
});
