import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserAuth} from '../apps/web/src/browser-session.js';
import {LoginSessionStorage} from '../apps/web/src/login-session-storage.js';

test('pinned SDK restores isolated buyer and seller sessions and refreshes credentials without another email OTP',async()=>{
  class Store{values=new Map<string,string>();getItem(key:string){return this.values.get(key)??null;}setItem(key:string,value:string){this.values.set(key,value);}removeItem(key:string){this.values.delete(key);}}
  const local=new Store(),tab=new Store(),configuration={privyAppId:'local-test-app',meraRpId:null,recoveryDeployment:null},originalFetch=globalThis.fetch;
  const tokenClock=Math.floor(Date.now()/1000);
  const jwt=(subject:string,expired=false)=>[Buffer.from(JSON.stringify({alg:'ES256'})).toString('base64url'),Buffer.from(JSON.stringify({sub:subject,aud:configuration.privyAppId,iss:'privy.io',exp:tokenClock+(expired?-60:3600)})).toString('base64url'),'synthetic-signature'].join('.');
  const response=(id:string)=>{const token=jwt(id);return {user:{id,created_at:1,linked_accounts:[{type:'email',address:`${id.split(':').at(-1)}@example.invalid`}],has_accepted_terms:false,is_guest:false},token,privy_access_token:token,refresh_token:`synthetic-refresh-${id}`,session_update_action:'set'};};
  let logins=0,sends=0,refreshes=0;const clients:Awaited<ReturnType<typeof createBrowserAuth>>[]=[];
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url);assert.equal(url.origin,'https://auth.privy.io');
    const body=request.method==='POST'?JSON.parse(await request.text()):{},json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    if(url.pathname===`/api/v1/apps/${configuration.privyAppId}`)return json({id:configuration.privyAppId,embedded_wallet_config:{create_on_login:'off',ethereum:{create_on_login:'off'},solana:{create_on_login:'off'}}});
    if(url.pathname==='/api/v1/analytics_events'||url.pathname==='/api/v1/sessions/logout')return json({success:true});
    if(url.pathname==='/api/v1/passwordless/init'){sends++;return json({success:true});}
    if(url.pathname==='/api/v1/passwordless/authenticate'){assert.equal(request.headers.has('authorization'),false);logins++;return json(response(`did:privy:${body.email.split('@')[0]}`));}
    if(url.pathname==='/api/v1/sessions'){refreshes++;const id=JSON.parse(Buffer.from(request.headers.get('authorization')!.split('.')[1],'base64url').toString()).sub;return json(response(id));}
    throw Error(`UNEXPECTED_TEST_REQUEST:${url.pathname}`);
  };
  try{
    const buyerStorage=new LoginSessionStorage(configuration.privyAppId,undefined,'buyer',tab,local),sellerStorage=new LoginSessionStorage(configuration.privyAppId,undefined,'seller',tab,local);
    const buyer=await createBrowserAuth(configuration,{role:'buyer',storage:buyerStorage}),seller=await createBrowserAuth(configuration,{role:'seller',storage:sellerStorage});clients.push(buyer,seller);
    for(const [client,email] of [[buyer,'buyer@example.invalid'],[seller,'seller@example.invalid']] as const){await client.initialize();client.setRemember!(true);await client.sendCode(email);await client.login(email,'123456');}
    const reload=await createBrowserAuth(configuration,{role:'buyer',storage:new LoginSessionStorage(configuration.privyAppId,undefined,'buyer',new Store(),local)});clients.push(reload);await reload.initialize();
    assert.equal(await reload.token(),jwt('did:privy:buyer'));assert.equal(await seller.token(),jwt('did:privy:seller'));assert.equal(logins,2);assert.equal(sends,2);
    await assert.rejects(reload.sendCode('other@example.invalid'),/LOGIN_SWITCH_ACCOUNT_REQUIRED/);assert.equal(sends,2);
    buyerStorage.put('privy:token',jwt('did:privy:buyer',true));buyerStorage.put('privy:pat',jwt('did:privy:buyer',true));
    assert.equal(await reload.token(),jwt('did:privy:buyer'));assert.equal(refreshes,1);assert.equal(logins,2);assert.equal(sends,2);
    await reload.logout();await assert.rejects(buyer.token(),/SESSION_CHANGED/);assert.equal(await seller.token(),jwt('did:privy:seller'));
    const empty=await createBrowserAuth(configuration,{role:'buyer',storage:new LoginSessionStorage(configuration.privyAppId,undefined,'buyer',new Store(),local)});clients.push(empty);await empty.initialize();assert.equal(await empty.token(),null);
  }finally{for(const client of clients)try{await client.logout();}catch{/* A replaced client cannot clear a newer role session. */}await new Promise(resolve=>setTimeout(resolve,10));globalThis.fetch=originalFetch;}
});

test('real pinned SDK cannot send or authenticate another email until the original session is explicitly logged out',async()=>{
  const originalFetch=globalThis.fetch,requests:{path:string;authorization:boolean;body:Record<string,unknown>}[]=[];
  const configuration={privyAppId:'local-test-app',meraRpId:null,recoveryDeployment:null};
  const jwt=(subject:string)=>[Buffer.from(JSON.stringify({alg:'ES256'})).toString('base64url'),Buffer.from(JSON.stringify({sub:subject,aud:configuration.privyAppId,iss:'privy.io',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'synthetic-signature'].join('.');
  let successfulLogins=0;
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url);
    assert.equal(url.origin,'https://auth.privy.io');
    const body=request.method==='POST'?JSON.parse(await request.text()):{};
    const entry={path:url.pathname,authorization:request.headers.has('authorization'),body};requests.push(entry);
    const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
    if(url.pathname===`/api/v1/apps/${configuration.privyAppId}`)return json({id:configuration.privyAppId,embedded_wallet_config:{create_on_login:'off',ethereum:{create_on_login:'off'},solana:{create_on_login:'off'}}});
    if(url.pathname==='/api/v1/analytics_events'||url.pathname==='/api/v1/sessions/logout')return json({success:true});
    if(url.pathname==='/api/v1/passwordless/init')return json({success:true});
    if(url.pathname==='/api/v1/passwordless/authenticate'){
      if(entry.authorization)return json({code:'cannot_link_more_of_type',error:'User already has one email account linked'},400);
      successfulLogins++;const id=`did:privy:synthetic-user-${successfulLogins}`,token=jwt(id);
      return json({user:{id,created_at:1,linked_accounts:[{type:'email',address:body.email}],has_accepted_terms:false,is_guest:false},token,privy_access_token:token,refresh_token:'synthetic-refresh',session_update_action:'set'});
    }
    throw Error(`UNEXPECTED_TEST_REQUEST:${url.pathname}`);
  };
  let first:Awaited<ReturnType<typeof createBrowserAuth>>|undefined,second:typeof first;
  try{
    first=await createBrowserAuth(configuration);await first.initialize();
    await first.sendCode('first@example.invalid');await first.login('first@example.invalid','123456');
    const before=requests.filter(r=>r.path.startsWith('/api/v1/passwordless/')).length;
    await assert.rejects(first.sendCode('second@example.invalid'),/LOGIN_SWITCH_ACCOUNT_REQUIRED/);
    await assert.rejects(first.login('second@example.invalid','654321'),/LOGIN_SWITCH_ACCOUNT_REQUIRED/);
    assert.equal(requests.filter(r=>r.path.startsWith('/api/v1/passwordless/')).length,before,'blocked switching must not send emails or consume an OTP');
    await first.logout();
    second=await createBrowserAuth(configuration);await second.initialize();await second.sendCode('second@example.invalid');await second.login('second@example.invalid','654321');
    assert.equal(successfulLogins,2);
    const authentication=requests.filter(r=>r.path==='/api/v1/passwordless/authenticate');
    assert.equal(authentication.length,2);assert.ok(authentication.every(r=>!r.authorization));
    assert.equal(authentication[1].body.email,'second@example.invalid');
    assert.ok(!requests.some(r=>r.path.includes('/link')||r.path.includes('/embedded_wallets')));
  }finally{await first?.logout();await second?.logout();await new Promise(resolve=>setTimeout(resolve,10));globalThis.fetch=originalFetch;}
});
