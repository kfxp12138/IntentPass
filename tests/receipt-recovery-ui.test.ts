import test from 'node:test';
import assert from 'node:assert/strict';
import type {PurchaseFlow} from '../apps/web/src/purchase-flow.js';
import {receiptRecoveryControls,attachReceiptRecoveryControls} from '../apps/web/src/receipt-recovery-ui.js';
class Node {disabled=false;checked=false;isConnected=true;textContent='';files=[];handlers=new Map<string,()=>void>();addEventListener(name:string,work:()=>void){this.handlers.set(name,work);}emit(name:string){assert.equal(this.disabled,false);this.handlers.get(name)?.();}}
function fixture(){
  const nodes=new Map([...receiptRecoveryControls.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Node()])),get=(id:string)=>nodes.get(id)!;
  let time=1000n,working=false,unknown=false,calls=0;
  const flow={authorizationLocked:false,draft:{quote:{expiresAt:'3000'},intent:{deliveryDeadline:'2500'}},reviewResult:{source:'JEV',decision:'PASS',executable:true,receipt:{expiresAt:'1300'}},recoverReceipt:async(confirmation:boolean)=>{calls++;if(confirmation&&unknown)return {status:'UNKNOWN',code:'RECEIPT_RENEWAL_SIGNING_UNRESOLVED'};return {status:'SIGNED',receipt:{expiresAt:confirmation?'1600':'1300'}};}} as unknown as PurchaseFlow;
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>get(selector.slice(1))}});
  const controls=attachReceiptRecoveryControls(flow,async work=>work(),()=>{},()=>time,()=>working);
  return {flow,get,controls,setTime:(value:bigint)=>{time=value;controls.refresh();},working:(value:boolean)=>{working=value;controls.refresh();},unknown:()=>{unknown=true;},calls:()=>calls,close:()=>{controls.dispose();if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else Reflect.deleteProperty(globalThis,'document');}};
}
test('receipt countdown requires explicit readiness only after expiry, disables busy or signed flows and stops at original delivery deadline',()=>{
  const f=fixture();try{
    assert.ok(f.get('receipt-validity').textContent.includes('300'));assert.equal(f.get('renew-original-receipt').disabled,true);
    f.get('ready-original-receipt').checked=true;f.get('ready-original-receipt').emit('change');assert.equal(f.get('renew-original-receipt').disabled,true);
    f.setTime(1300n);assert.ok(f.get('receipt-validity').textContent.includes('已过期'));assert.equal(f.get('renew-original-receipt').disabled,false);
    f.working(true);assert.equal(f.get('renew-original-receipt').disabled,true);assert.equal(f.get('read-original-receipt').disabled,true);f.working(false);
    f.flow.signedAuthorization={} as PurchaseFlow['signedAuthorization'];Object.defineProperty(f.flow,'authorizationLocked',{value:true,writable:true});f.controls.refresh();assert.equal(f.get('renew-original-receipt').disabled,true);assert.equal(f.get('read-original-receipt').disabled,true);
    Object.defineProperty(f.flow,'authorizationLocked',{value:false,writable:true});f.setTime(2500n);assert.equal(f.get('renew-original-receipt').disabled,true);assert.equal(f.calls(),0);
  }finally{f.close();}
});
test('unknown signing response prevents a second request even after another expiry; only a read can resolve that observation',async()=>{
  const f=fixture();try{
    f.setTime(1300n);f.get('ready-original-receipt').checked=true;f.get('ready-original-receipt').emit('change');f.unknown();f.get('renew-original-receipt').emit('click');await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.calls(),1);assert.equal(f.get('renew-original-receipt').disabled,true);
    f.get('ready-original-receipt').checked=true;f.setTime(1700n);assert.equal(f.get('renew-original-receipt').disabled,true);assert.equal(f.get('read-original-receipt').disabled,false);
    f.get('read-original-receipt').emit('click');await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.calls(),2);assert.equal(f.get('ready-original-receipt').checked,false);assert.equal(f.get('renew-original-receipt').disabled,true);
  }finally{f.close();}
});
