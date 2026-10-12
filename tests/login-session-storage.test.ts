import test from 'node:test';
import assert from 'node:assert/strict';
import {LoginSessionStorage} from '../apps/web/src/login-session-storage.js';
class Store{
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
test('tab reload restores auth while role, app, client, tab and private SDK material remain isolated',()=>{
  const tab=new Store(),local=new Store(),buyer=new LoginSessionStorage('app','client','buyer',tab,local);
  buyer.put('privy:token','synthetic-buyer');buyer.put('embedded-private-material','never-persist');buyer.put('privy:__storage__test','temporary');
  const reload=new LoginSessionStorage('app','client','buyer',tab,local);
  assert.equal(reload.get('privy:token'),'synthetic-buyer');assert.equal(reload.get('embedded-private-material'),undefined);
  assert.doesNotMatch([...tab.values.values()].join(''),/never-persist|temporary/);assert.equal(local.values.size,0);
  for(const other of [new LoginSessionStorage('app','client','seller',tab,local),new LoginSessionStorage('other','client','buyer',tab,local),new LoginSessionStorage('app','other','buyer',tab,local),new LoginSessionStorage('app','client','buyer',new Store(),local)])assert.equal(other.get('privy:token'),undefined);
});
test('remembered sessions restore in a new tab and logout cannot delete a new account or the other role',()=>{
  const local=new Store(),tab=new Store(),buyer=new LoginSessionStorage('app',undefined,'buyer',tab,local),seller=new LoginSessionStorage('app',undefined,'seller',tab,local);
  buyer.setRemember(true);buyer.put('privy:token','synthetic-buyer');seller.setRemember(true);seller.put('privy:token','synthetic-seller');
  const another=new LoginSessionStorage('app',undefined,'buyer',new Store(),local);
  assert.equal(another.remembered,true);assert.equal(another.get('privy:token'),'synthetic-buyer');buyer.clear();
  assert.throws(()=>another.get('privy:token'),/SESSION_CHANGED/);
  const replacement=new LoginSessionStorage('app',undefined,'buyer',tab,local);replacement.setRemember(true);replacement.put('privy:token','synthetic-new-buyer');
  another.clear();assert.equal(replacement.get('privy:token'),'synthetic-new-buyer');assert.equal(seller.get('privy:token'),'synthetic-seller');
  assert.throws(()=>another.put('privy:token','late-result'),/SESSION_CHANGED/);
});
test('retention is capped without sliding expiry; expired or malformed persistence cannot restore a login',()=>{
  const tab=new Store(),local=new Store();let now=1000;
  const buyer=new LoginSessionStorage('app',undefined,'buyer',tab,local,()=>now);buyer.put('privy:token','synthetic');
  now+=8*60*60*1000;assert.throws(()=>buyer.get('privy:token'),/LOGIN_SESSION_EXPIRED/);
  assert.equal(new LoginSessionStorage('app',undefined,'buyer',tab,local,()=>now).get('privy:token'),undefined);
  const remembered=new LoginSessionStorage('app',undefined,'buyer',tab,local,()=>now);remembered.setRemember(true);remembered.put('privy:token','synthetic');
  now+=6*24*60*60*1000;remembered.put('privy:token','synthetic-refresh');now+=24*60*60*1000;
  assert.throws(()=>remembered.get('privy:token'),/LOGIN_SESSION_EXPIRED/);
  assert.equal(new LoginSessionStorage('app',undefined,'buyer',tab,local,()=>now).get('privy:token'),undefined);
  tab.setItem('intentpass:login:v1:app::buyer','{bad-json');
  assert.equal(new LoginSessionStorage('app',undefined,'buyer',tab,local,()=>now).get('privy:token'),undefined);assert.equal(tab.values.size,0);
});
test('changing persistence cannot migrate an authenticated account; unavailable device storage never claims persistence',()=>{
  const tab=new Store(),storage=new LoginSessionStorage('app',undefined,'buyer',tab,undefined);
  assert.throws(()=>storage.setRemember(true),/LOGIN_STORAGE_UNAVAILABLE/);storage.put('privy:token','synthetic');
  assert.throws(()=>storage.setRemember(false),/LOGIN_SWITCH_ACCOUNT_REQUIRED/);
  storage.del('privy:token');storage.setRemember(false);storage.put('privy:token','synthetic-next');assert.equal(storage.get('privy:token'),'synthetic-next');
  const broken={getItem:()=>null,setItem:()=>{throw Error('private-message');},removeItem:()=>{}};
  const failed=new LoginSessionStorage('app',undefined,'buyer',broken,broken);failed.setRemember(true);
  assert.throws(()=>failed.put('privy:token','synthetic'),/^Error: LOGIN_STORAGE_UNAVAILABLE$/);
});
test('two fresh tabs cannot overwrite or merge concurrently created remembered accounts',()=>{
  const local=new Store(),first=new LoginSessionStorage('app',undefined,'buyer',new Store(),local),second=new LoginSessionStorage('app',undefined,'buyer',new Store(),local);
  first.setRemember(true);second.setRemember(true);first.put('privy:token','synthetic-first');
  assert.throws(()=>second.put('privy:token','synthetic-second'),/SESSION_CHANGED/);
  assert.equal(first.get('privy:token'),'synthetic-first');
});
