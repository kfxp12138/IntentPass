import test from 'node:test';
import assert from 'node:assert/strict';
import {requestEmailCode,loginFailureMessage} from '../apps/web/src/email-code.js';
import {attachLoginControls} from '../apps/web/src/login-ui.js';
import type {BrowserSession} from '../apps/web/src/browser-session.js';

test('email requests require an explicit accepted result and never retry failed or ambiguous responses',async()=>{
  for(const result of [false,null,undefined,{}, {success:false},{success:'true'}]){
    let calls=0;await assert.rejects(requestEmailCode(async()=>{calls++;return result;},'member@example.com'),/EMAIL_CODE_NOT_ACCEPTED/);assert.equal(calls,1);
  }
  let calls=0;await requestEmailCode(async email=>{calls++;assert.equal(email,'member@example.com');return {success:true};},'member@example.com');assert.equal(calls,1);
  const original=Object.assign(new Error('private provider response'),{code:'too_many_requests'});
  await assert.rejects(requestEmailCode(async()=>{throw original;},'member@example.com'),error=>error===original);
});
test('diagnostics use allowlisted codes and never echo provider bodies email tokens or arbitrary messages',()=>{
  assert.match(loginFailureMessage({code:'invalid_origin'},'send'),/origin/);
  assert.match(loginFailureMessage({status:429},'send'),/Too many requests/);
  assert.match(loginFailureMessage({code:'invalid_captcha'},'send'),/additional challenge/);
  assert.match(loginFailureMessage({code:'invalid_credentials'},'login'),/invalid or expired/);
  for(const error of [{code:'member@example.com',message:'secret-provider-body'},new Error('secret-provider-body'),{error:'secret-provider-body'},null]){
    const shown=loginFailureMessage(error,'send');assert.doesNotMatch(shown,/secret-provider-body|member@example.com/);assert.match(shown,/delivery was not confirmed/);
  }
});

class Control{
  value='';textContent='';disabled=false;isConnected=true;checked=false;
  handlers=new Map<string,(event:{preventDefault():void})=>void>();
  addEventListener(name:string,work:(event:{preventDefault():void})=>void){this.handlers.set(name,work);}
  emit(name:string){this.handlers.get(name)?.({preventDefault(){}});}
}
function fixture(send:(email:string)=>Promise<void>,overrides:Partial<BrowserSession>={}){
  const nodes=new Map(['login-form','login-feedback','email-code-feedback','login-email','login-code','send-code','logout','submit','remember-login'].map(id=>[id,new Control()]));
  const get=(id:string)=>nodes.get(id)!,form=get('login-form') as Control&{querySelectorAll():Control[];reset():void};
  form.querySelectorAll=()=>['send-code','logout','submit'].map(get);form.reset=()=>{get('login-email').value='';get('login-code').value='';};
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>get(selector.slice(1))}});
  const session={sendCode:send,login:async()=>({subject:'private-user',wallets:[]}),logout:async()=>{},...overrides} as unknown as BrowserSession;
  attachLoginControls(()=>{},session);
  return {get,form,cleanup:()=>{if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');}};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('restoring login blocks OTP input until verification and reports only checked wallets',async()=>{
  let release!:(value:{subject:string;wallets:`0x${string}`[]})=>void,sends=0;
  const waiting=new Promise<{subject:string;wallets:`0x${string}`[]}>(r=>{release=r;});
  const f=fixture(async()=>{sends++;},{restore:()=>waiting,remembered:true});
  try{
    assert.equal(f.get('send-code').disabled,true);assert.match(f.get('login-feedback').textContent,/Checking your saved session/);
    f.get('login-email').value='member@example.com';f.get('send-code').emit('click');assert.equal(sends,0);
    release({subject:'never-display-subject',wallets:['0x0000000000000000000000000000000000000001']});await settle();
    assert.equal(f.get('remember-login').checked,true);assert.equal(f.get('send-code').disabled,true);assert.equal(f.get('logout').disabled,false);
    assert.match(f.get('login-feedback').textContent,/Session restored and verified/);assert.doesNotMatch(f.get('login-feedback').textContent,/never-display/);
  }finally{f.cleanup();}
});
test('remembering requires the login checkbox and restored failure cannot claim success or send an OTP',async()=>{
  let remembered:boolean|undefined;const f=fixture(async()=>{},{login:async(_email,_code,remember)=>{remembered=remember;return {subject:'private',wallets:[]};}});
  try{f.get('login-email').value='member@example.com';f.get('login-code').value='123456';f.get('remember-login').checked=true;f.form.emit('submit');await settle();assert.equal(remembered,true);}finally{f.cleanup();}
  let sends=0;const failed=fixture(async()=>{sends++;},{restore:async()=>{throw Error('private-token');}});
  try{await settle();assert.equal(sends,0);assert.equal(failed.get('send-code').disabled,false);assert.match(failed.get('login-feedback').textContent,/could not be restored/);assert.doesNotMatch(failed.get('login-feedback').textContent,/private-token|Session restored/);}finally{failed.cleanup();}
});
test('send button validates before any request and shows progress beside it until acceptance, with no duplicate dispatch',async()=>{
  let calls=0,finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;}),f=fixture(async()=>{calls++;await pending;});
  try{
    f.get('send-code').emit('click');assert.equal(calls,0);assert.match(f.get('email-code-feedback').textContent,/valid email/);
    f.get('login-email').value='member@example.com';f.get('send-code').emit('click');assert.equal(calls,1);assert.match(f.get('email-code-feedback').textContent,/Requesting/);
    assert.equal(f.get('login-email').disabled,true);f.get('send-code').emit('click');assert.equal(calls,1);
    finish();await settle();assert.match(f.get('email-code-feedback').textContent,/accepted the request/);assert.match(f.get('email-code-feedback').textContent,/spam/);assert.equal(f.get('send-code').disabled,false);assert.equal(f.get('login-feedback').textContent,'');
  }finally{f.cleanup();}
});
test('a rejected request never claims acceptance and a detached page receives no late success',async()=>{
  const failed=fixture(async()=>{throw {code:'allowlist_rejected',error:'private-provider-body'};});
  try{failed.get('login-email').value='member@example.com';failed.get('send-code').emit('click');await settle();assert.match(failed.get('email-code-feedback').textContent,/not allowed/);assert.doesNotMatch(failed.get('email-code-feedback').textContent,/accepted|private-provider-body/);}finally{failed.cleanup();}
  let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;}),f=fixture(async()=>pending);
  try{f.get('login-email').value='member@example.com';f.get('send-code').emit('click');f.form.isConnected=false;const before=f.get('email-code-feedback').textContent;finish();await settle();assert.equal(f.get('email-code-feedback').textContent,before);}finally{f.cleanup();}
});

test('successful login blocks another email request and login until explicit logout, even when events are dispatched directly',async()=>{
  let sends=0,logins=0,logouts=0;
  const f=fixture(async()=>{sends++;},{login:async()=>{logins++;return {subject:'private-user',wallets:[]};},logout:async()=>{logouts++;}});
  try{
    f.get('login-email').value='first@example.com';f.get('login-code').value='123456';f.form.emit('submit');await settle();
    for(const id of ['login-email','login-code','send-code','submit'])assert.equal(f.get(id).disabled,true);
    assert.equal(f.get('logout').disabled,false);
    f.get('login-email').value='second@example.com';f.get('login-code').value='654321';f.get('send-code').emit('click');f.form.emit('submit');await settle();
    assert.equal(sends,0);assert.equal(logins,1);assert.match(f.get('login-feedback').textContent,/Sign out/);
    f.get('logout').emit('click');await settle();assert.equal(logouts,1);assert.equal(f.get('login-email').disabled,false);assert.equal(f.get('login-code').value,'');
    f.get('login-email').value='second@example.com';f.get('send-code').emit('click');await settle();assert.equal(sends,1);
  }finally{f.cleanup();}
});
test('reattaching to an existing authenticated session disables login without making any provider call',()=>{
  let sends=0;const f=fixture(async()=>{sends++;},{hasAuthenticatedSession:true});
  try{assert.equal(f.get('send-code').disabled,true);assert.equal(f.get('submit').disabled,true);assert.equal(f.get('logout').disabled,false);assert.match(f.get('login-feedback').textContent,/You are signed in/);f.get('send-code').emit('click');assert.equal(sends,0);}finally{f.cleanup();}
});
test('editing the email or explicitly requesting a new code discards the previous code and its stale notices',async()=>{
  const f=fixture(async()=>{});try{
    f.get('login-code').value='123456';f.get('email-code-feedback').textContent='old accepted request';f.get('login-email').emit('input');
    assert.equal(f.get('login-code').value,'');assert.equal(f.get('email-code-feedback').textContent,'');
    f.get('login-email').value='second@example.com';f.get('login-code').value='654321';f.get('send-code').emit('click');await settle();assert.equal(f.get('login-code').value,'');
  }finally{f.cleanup();}
});
