import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserSession,createBrowserAuth,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import {configuredBrowserApi} from '../apps/web/src/browser-api.js';
import {createApp} from '../apps/web/src/server.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {refreshRestoredOrder} from '../apps/web/src/order-view.js';
import type {OrderSnapshot} from '../packages/protocol/src/escrow-read.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
const configuration={privyAppId:'local-test-app',meraRpId:'localhost',recoveryDeployment:null};
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`;
const order:OrderSnapshot={chainId:'10143',arbiter:a(9),asset:a(8),orderId:h(1),contextHash:h(2),buyer:a(1),seller:a(2),payee:a(2),price:'10',bond:'5',deliveryDeadline:'100',settlementDeadline:'200',datasetHash:h(3),serviceTermsHash:h(4),evidenceHash:h(5),voteMask:3,state:'CERTIFIED',credits:{buyer:'0',payee:'0'},withdrawn:{buyer:'0',payee:'0'},accounting:{locked:'15',outstanding:'0',balance:'15'},block:{number:'10',hash:h(10),timestamp:'50'}};
function port():BrowserAuthPort {return {initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-test-token',logout:async()=>{}};}
test('restoration requires a current server verified identity, sends no OTP and keeps role configuration distinct',async()=>{
  let sends=0,logins=0,reads=0;const roles:string[]=[],auth={...port(),sendCode:async()=>{sends++;},login:async()=>{logins++;}};
  for(const role of ['buyer','seller'] as const){
    const session=new BrowserSession(async(_,options)=>{roles.push(options!.role);return auth;},async url=>{if(url==='/api/config')return new Response(JSON.stringify(configuration));reads++;return new Response(JSON.stringify({subject:`verified-${role}`,wallets:[a(role==='buyer'?1:2)]}));},{role});
    assert.equal(session.hasAuthenticatedSession,false);const restored=await session.restore();
    assert.equal(restored!.subject,`verified-${role}`);assert.equal(session.hasAuthenticatedSession,true);
    await assert.rejects(session.walletConnection(a(3)),/WALLET_OWNER_MISMATCH/);
  }
  assert.deepEqual(roles,['buyer','seller']);assert.equal(sends,0);assert.equal(logins,0);assert.equal(reads,4);
});
test('missing or rejected restored credentials do not claim login and network failure does not consume another OTP',async()=>{
  const transport:typeof fetch=async()=>new Response(JSON.stringify(configuration));
  const empty=new BrowserSession(async()=>({...port(),token:async()=>null}),transport);assert.equal(await empty.restore(),null);assert.equal(empty.hasAuthenticatedSession,false);
  for(const status of [401,503]){
    let logouts=0;const session=new BrowserSession(async()=>({...port(),logout:async()=>{logouts++;}}),async url=>url==='/api/config'?new Response(JSON.stringify(configuration)):new Response('{}',{status}));
    await assert.rejects(session.restore(),new RegExp(`SESSION_HTTP_${status}`));assert.equal(session.hasAuthenticatedSession,status!==401);assert.equal(logouts,status===401?1:0);
  }
});
test('logout during restoration prevents the returned identity from reviving the saved session',async()=>{
  let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  const session=new BrowserSession(async()=>port(),async url=>{if(url==='/api/config')return new Response(JSON.stringify(configuration));entered();await wait;return new Response(JSON.stringify({subject:'old',wallets:[a(1)]}));});
  const restoring=session.restore();await started;await session.logout();release();await assert.rejects(restoring,/SESSION_CHANGED/);assert.equal(session.hasAuthenticatedSession,false);
});
test('session transport uses the browser global receiver through configuration and authenticated reads',async()=>{
  let reads=0;
  const nativeLikeFetch:typeof fetch=async function(this:unknown,url){
    assert.equal(this,globalThis,'native Window.fetch rejects a BrowserSession receiver');reads++;
    return new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]}));
  };
  let sends=0;const session=new BrowserSession(async()=>({...port(),sendCode:async()=>{sends++;}}),nativeLikeFetch);
  await session.sendCode('member@example.com');assert.equal(sends,1);assert.equal(reads,1);
  assert.deepEqual(await session.verified(),{subject:'verified-user',wallets:[a(1)]});assert.equal(reads,2);
});
test('browser configuration exposes only explicit public metadata; partial chain setup cannot enable recovery',()=>{
  assert.equal(configuredBrowserApi({}),undefined);
  const env={PRIVY_APP_ID:'local-test-app',PRIVY_APP_SECRET:['DO_NOT_EXPOSE_','APP_SECRET'].join(''),PRIVY_AUTHORIZATION_PRIVATE_KEY:['DO_NOT_EXPOS','E_SIGNER_SECRET'].join(''),MONAD_RPC_URL:'https://rpc.example/DO_NOT_EXPOSE_RPC_SECRET'};
  const api=configuredBrowserApi(env)!;assert.equal(api.configuration.recoveryDeployment,null);
  const publicJson=JSON.stringify(api.configuration);assert.ok(!publicJson.includes('DO_NOT_EXPOSE'));
  const full=configuredBrowserApi({...env,CHAIN_ID:'10143',ARBITER_ADDRESS:a(1),CVA_ADDRESS:a(2),ELIGIBILITY_GATE_ADDRESS:a(3),REVIEWER_ADDRESS:a(4),COMMITTEE_ADDRESSES:[a(5),a(6),a(7)].join(','),PRIVY_EXECUTOR_ADDRESS:a(8)})!;
  assert.equal(full.configuration.recoveryDeployment?.chainId,'10143');assert.equal(full.configuration.recoveryDeployment?.executor,a(8));assert.ok(!JSON.stringify(full.configuration).includes('DO_NOT_EXPOSE'));
  assert.throws(()=>configuredBrowserApi({...env,PRIVY_APP_ID:'invalid\napp'}));
});
test('browser session uses server-verified identity, fresh tokens and strict public configuration',async()=>{
  let initialized=0,sent=0,logins=0,tokens=0;
  const auth={...port(),initialize:async()=>{initialized++;},sendCode:async email=>{assert.equal(email,'user@example.com');sent++;},login:async(email,code)=>{assert.equal(email,'user@example.com');assert.equal(code,'123456');logins++;},token:async()=>`local-${++tokens}`} satisfies BrowserAuthPort;
  const transport:typeof fetch=async(url,init)=>{assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');if(url==='/api/config')return new Response(JSON.stringify(configuration));assert.equal(url,'/api/session');assert.equal((init?.headers as Record<string,string>).Authorization,`Bearer local-${tokens}`);return new Response(JSON.stringify({subject:'verified-by-server',wallets:[a(1)]}));};
  const session=new BrowserSession(async config=>{assert.deepEqual(config,configuration);return auth;},transport);
  await session.sendCode('user@example.com');assert.deepEqual(await session.login('user@example.com','123456'),{subject:'verified-by-server',wallets:[a(1)]});await session.verified();
  assert.equal(initialized,1);assert.equal(sent,1);assert.equal(logins,1);assert.equal(tokens,2);
  await assert.rejects(session.sendCode('bad-email'));await assert.rejects(session.login('user@example.com','bad-code'));assert.equal(sent,1);assert.equal(logins,1);
  await assert.rejects(new BrowserSession(async()=>port(),async()=>new Response(JSON.stringify({...configuration,appSecret:'forbidden'}))).configuration());
  await assert.rejects(new BrowserSession(async()=>port(),async()=>new Response('x'.repeat(16385))).configuration(),/SESSION_RESPONSE_INVALID/);
});
test('provider-authenticated state survives a server verification failure and clears synchronously on logout',async()=>{
  const session=new BrowserSession(async()=>port(),async url=>url==='/api/config'?new Response(JSON.stringify(configuration)):new Response('{}',{status:503}));
  assert.equal(session.hasAuthenticatedSession,false);
  await assert.rejects(session.login('member@example.com','123456'),/SESSION_HTTP_503/);
  assert.equal(session.hasAuthenticatedSession,true,'do not ask the user to consume the same OTP again');
  const logout=session.logout();assert.equal(session.hasAuthenticatedSession,false);await logout;
});
test('read-only signing connection verifies the same buyer before and after the provider and cannot expose another wallet or survive logout',async()=>{
  const connectedConfiguration={...configuration,recoveryDeployment:{chainId:'10143',arbiter:a(9),asset:a(8),reviewer:a(7),committee:[a(1),a(2),a(3)],executor:a(4)}};
  let calls=0,subject='local-buyer',mismatch=false,release!:()=>void,entered!:()=>void;
  let delay:Promise<void>|undefined;
  const auth={...port(),inspectWalletConnection:async(wallet:string,active:()=>void)=>{calls++;entered?.();await delay;active();return {wallet:mismatch?a(2):wallet,chainId:connectedConfiguration.recoveryDeployment.chainId,status:'READY' as const};}};
  const session=new BrowserSession(async()=>auth,async url=>new Response(JSON.stringify(url==='/api/config'?connectedConfiguration:{subject,wallets:[a(1)]})));
  await assert.rejects(session.walletConnection(a(2)),/WALLET_OWNER_MISMATCH/);assert.equal(calls,0);
  assert.equal((await session.walletConnection(a(1))).status,'READY');assert.equal(calls,1);
  mismatch=true;await assert.rejects(session.walletConnection(a(1)),/WALLET_CONNECTION_RESPONSE_INVALID/);mismatch=false;
  const started=new Promise<void>(r=>{entered=r;});delay=new Promise<void>(r=>{release=r;});
  const pending=session.walletConnection(a(1));await started;await session.logout();release();await assert.rejects(pending,/SESSION_CHANGED/);
});
test('actual Privy browser SDK is wrapped with only narrow Grant signing and exact asset approval; fresh logged-out instance sends no request',async()=>{
  const previous=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('Unexpected real provider request in local test');};
  try{const auth=await createBrowserAuth(configuration);assert.deepEqual(Object.keys(auth).sort(),['connectGeneralWallet','remembered','setRemember','initialize','sendCode','login','token','logout','setupWallets','createSetupWallet','signGrant','approveAsset','deliverOrder','signAcceptance','submitVote','withdrawOrder','signQuote','inspectWalletConnection'].sort());await auth.logout();await assert.rejects(auth.inspectWalletConnection!(a(1),()=>{}),/SESSION_CHANGED/);await assert.rejects(auth.setupWallets!('local-user',()=>{}),/SESSION_CHANGED/);await assert.rejects(auth.createSetupWallet!('local-user',true,()=>{}),/SESSION_CHANGED/);await assert.rejects(auth.withdrawOrder!({},{},async()=>undefined,()=>{}),/SESSION_CHANGED/);await assert.rejects(auth.submitVote!({},async()=>undefined,()=>{}),/SESSION_CHANGED/);await assert.rejects(auth.signAcceptance!({},async()=>undefined,()=>{}),/SESSION_CHANGED/);await assert.rejects(auth.deliverOrder!({},async()=>undefined,()=>{}),/SESSION_CHANGED/);await assert.rejects(auth.approveAsset!({},'SET',async()=>undefined,()=>{}),/SESSION_CHANGED/);assert.equal(requests,0);}finally{globalThis.fetch=previous;}
});
test('logout invalidates an in-flight verified response and initialization without reviving the old account',async()=>{
  let release!:()=>void,started!:()=>void;const pending=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{started=r;});let logouts=0;
  const session=new BrowserSession(async()=>({...port(),logout:async()=>{logouts++;}}),async url=>{
    if(url==='/api/config')return new Response(JSON.stringify(configuration));started();await pending;return new Response(JSON.stringify({subject:'old-user',wallets:[a(1)]}));
  });
  const result=session.verified();await reached;await session.logout();release();await assert.rejects(result,/SESSION_CHANGED/);assert.equal(logouts,1);
  let finish!:()=>void,initStarted!:()=>void;const initWait=new Promise<void>(r=>{finish=r;}),initReached=new Promise<void>(r=>{initStarted=r;});let cleaned=0;
  const initializing=new BrowserSession(async()=>({...port(),initialize:async()=>{initStarted();await initWait;},logout:async()=>{cleaned++;}}),async()=>new Response(JSON.stringify(configuration)));
  const token=initializing.token();await initReached;await initializing.logout();finish();await assert.rejects(token,/SESSION_CHANGED/);assert.equal(cleaned,1);
});
test('restored order refresh uses current verified wallet and rejects changed anchors or stale finalized snapshots',async()=>{
  let reads=0;
  const session=new BrowserSession(async()=>port(),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]})));
  const current={...order,state:'ALLOCATED_PAID' as const,credits:{buyer:'5',payee:'10'},block:{...order.block,number:'11',hash:h(11)}};
  assert.deepEqual(await refreshRestoredOrder(order,session,async(id,token)=>{reads++;assert.equal(id,order.orderId);assert.equal(token,'local-test-token');return current;}),current);
  for(const changed of [{...current,payee:a(3)},{...current,contextHash:h(3)},{...current,block:{...current.block,number:'9'}},{...order,block:{...order.block,hash:h(11)}}])await assert.rejects(refreshRestoredOrder(order,session,async()=>changed));
  await assert.rejects(refreshRestoredOrder(current,session,async()=>({...current,state:'ALLOCATED_REFUND'})),/TERMINAL_CHANGED/);
  const stranger=new BrowserSession(async()=>port(),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'other-user',wallets:[a(3)]})));
  await assert.rejects(refreshRestoredOrder(order,stranger,async()=>{reads++;return current;}),/ACCESS_DENIED/);assert.equal(reads,1);
});
test('logout while order refresh is waiting discards the returned chain record',async()=>{
  const session=new BrowserSession(async()=>port(),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]})));
  let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{started=r;});
  const result=refreshRestoredOrder(order,session,async()=>{started();await wait;return order;});await reached;await session.logout();release();await assert.rejects(result,/SESSION_CHANGED/);
});
test('logout during login cleans the pending SDK session and rejects its later success',async()=>{
  let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{started=r;});let cleanups=0,verified=0;
  const session=new BrowserSession(async()=>({...port(),login:async()=>{started();await wait;},logout:async()=>{cleanups++;}}),async url=>{if(url==='/api/session')verified++;return new Response(JSON.stringify(configuration));});
  const login=session.login('user@example.com','123456');await reached;await session.logout();release();await assert.rejects(login,/SESSION_CHANGED/);assert.equal(cleanups,2);assert.equal(verified,0);
});
test('session API authenticates caller and sanitizes failed lookups; public config does not expose session',async()=>{
  let lookups=0;
  const app=await createApp({dependencyPrebundling:false,browserApi:{configuration,auth:{authenticate:async token=>{lookups++;if(token==='invalid')throw new AuthenticationRejected();if(token==='failure')throw new Error('DO_NOT_EXPOSE_PROVIDER_SECRET');return {subject:'verified-user',wallets:[a(1)]};}}}});
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const address=app.server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const get=(token:string)=>fetch(base+'/api/session',{headers:{Authorization:`Bearer ${token}`}});
  try {
    const config=await fetch(base+'/api/config');assert.equal(config.status,200);assert.deepEqual(await config.json(),configuration);assert.equal(lookups,0);
    assert.equal((await fetch(base+'/api/session')).status,401);assert.equal(lookups,0);assert.equal((await get('invalid')).status,401);
    const response=await get('valid');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{subject:'verified-user',wallets:[a(1)]});
    const failure=await get('failure');assert.equal(failure.status,503);assert.deepEqual(await failure.json(),{code:'SESSION_UNAVAILABLE'});
    assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{Authorization:'Bearer valid'},body:'{"subject":"spoofed"}'})).status,405);
    assert.equal((await(await fetch(base+'/health')).json()).ready,false);
  }finally{await app.close();}
});
test('setup intersects current SDK embedded addresses with fresh server verified wallets without requiring deployment',async()=>{
  let lists=0,creates=0;
  const auth={...port(),setupWallets:async(subject:string)=>{lists++;return {subject,addresses:[a(1),a(2)]};},createSetupWallet:async(subject:string,confirmation:boolean)=>{assert.equal(confirmation,true);creates++;return {subject,addresses:[a(1)]};}};
  const session=new BrowserSession(async()=>auth,async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1),a(3)]})));
  assert.deepEqual(await session.setupWallets(),{subject:'verified-user',addresses:[a(1)]});assert.equal(lists,1);assert.equal(creates,0);
  await assert.rejects(session.createSetupWallet(false),/CONFIRMATION_REQUIRED/);assert.equal(creates,0);
  assert.deepEqual(await session.createSetupWallet(true),{subject:'verified-user',addresses:[a(1)]});assert.equal(creates,1);
});
test('setup rejects either SDK identity mismatch or server subject change and discards after logout',async()=>{
  const identitySession=new BrowserSession(async()=>({...port(),setupWallets:async()=>({subject:'wrong-sdk-user',addresses:[a(1)]})}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]})));
  await assert.rejects(identitySession.setupWallets(),/SESSION_CHANGED/);
  let subject='first-user';const changed=new BrowserSession(async()=>({...port(),setupWallets:async expected=>{subject='second-user';return {subject:expected,addresses:[a(1)]};}}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject,wallets:[a(1)]})));
  await assert.rejects(changed.setupWallets(),/SESSION_CHANGED/);
  let release!:()=>void,started!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{started=resolve;});
  const delayed=new BrowserSession(async()=>({...port(),setupWallets:async subject=>{started();await wait;return {subject,addresses:[a(1)]};}}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]})));
  const result=delayed.setupWallets();await reached;await delayed.logout();release();await assert.rejects(result,/SESSION_CHANGED/);
});
test('unknown creation remains read only across same-subject logout and login until a verified embedded address appears',async()=>{
  let creates=0,lists=0,found=false;
  const session=new BrowserSession(async()=>({...port(),setupWallets:async subject=>{lists++;return {subject,addresses:found?[a(1)]:[]};},createSetupWallet:async()=>{creates++;throw Error('WALLET_SETUP_CREATION_OUTCOME_UNKNOWN');}}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]})));
  await assert.rejects(session.createSetupWallet(true),/CREATION_OUTCOME_UNKNOWN/);await session.logout();await session.login('user@example.com','123456');
  await assert.rejects(session.createSetupWallet(true),/CREATION_OUTCOME_UNKNOWN/);assert.equal(creates,1);assert.equal(lists,1);
  found=true;assert.deepEqual(await session.createSetupWallet(true),{subject:'verified-user',addresses:[a(1)]});assert.equal(creates,1);assert.equal(lists,2);
});
test('unknown subject cannot clear a creation lock with empty read but a different subject can prepare its first wallet',async()=>{
  let subject='first-user',creates=0,found=false;
  const session=new BrowserSession(async()=>({...port(),setupWallets:async subject=>({subject,addresses:found?[a(1)]:[]}),createSetupWallet:async subject=>{creates++;if(subject==='first-user')throw Error('WALLET_SETUP_CREATION_OUTCOME_UNKNOWN');found=true;return {subject,addresses:[a(1)]};}}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject,wallets:found?[a(1)]:[]})));
  await assert.rejects(session.createSetupWallet(true),/CREATION_OUTCOME_UNKNOWN/);await assert.rejects(session.setupWallets(),/CREATION_OUTCOME_UNKNOWN/);assert.equal(creates,1);
  await session.logout();subject='second-user';await session.login('user@example.com','123456');
  assert.deepEqual(await session.setupWallets(),{subject:'second-user',addresses:[]});assert.equal(creates,1);
  assert.deepEqual(await session.createSetupWallet(true),{subject:'second-user',addresses:[a(1)]});assert.equal(creates,2);
  await session.logout();subject='first-user';found=false;await session.login('user@example.com','123456');
  await assert.rejects(session.setupWallets(),/CREATION_OUTCOME_UNKNOWN/);await assert.rejects(session.createSetupWallet(true),/CREATION_OUTCOME_UNKNOWN/);assert.equal(creates,2);
});
test('provider success followed by server failure cannot create again after same-subject logout and login',async()=>{
  let creates=0,lists=0,failAfterCreate=false,found=false;
  const session=new BrowserSession(async()=>({...port(),setupWallets:async subject=>{lists++;return {subject,addresses:found?[a(1)]:[]};},createSetupWallet:async subject=>{creates++;failAfterCreate=true;return {subject,addresses:[a(1)]};}}),async url=>url==='/api/session'&&failAfterCreate?new Response('{"code":"SESSION_UNAVAILABLE"}',{status:503}):new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]})));
  await assert.rejects(session.createSetupWallet(true),/SESSION_HTTP_503/);await session.logout();failAfterCreate=false;await session.login('user@example.com','123456');
  await assert.rejects(session.createSetupWallet(true),/CREATION_OUTCOME_UNKNOWN/);assert.equal(creates,1);assert.equal(lists,1);
  found=true;assert.deepEqual(await session.createSetupWallet(true),{subject:'verified-user',addresses:[a(1)]});assert.equal(creates,1);
});
test('provider wallet missing from server index stays unknown across same-subject logout and login',async()=>{
  let creates=0,lists=0,indexed=false;
  const session=new BrowserSession(async()=>({...port(),setupWallets:async subject=>{lists++;return {subject,addresses:[a(1)]};},createSetupWallet:async subject=>{creates++;return {subject,addresses:[a(1)]};}}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:indexed?[a(1)]:[]})));
  await assert.rejects(session.createSetupWallet(true),/CREATION_OUTCOME_UNKNOWN/);await session.logout();await session.login('user@example.com','123456');
  await assert.rejects(session.createSetupWallet(true),/CREATION_OUTCOME_UNKNOWN/);assert.equal(creates,1);assert.equal(lists,1);
  indexed=true;assert.deepEqual(await session.createSetupWallet(true),{subject:'verified-user',addresses:[a(1)]});assert.equal(creates,1);
});
test('setup creation mutex rejects duplicate call and generation subscriptions synchronously clear on logout',async()=>{
  let release!:()=>void,started!:()=>void,creates=0;const wait=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{started=resolve;});
  const session=new BrowserSession(async()=>({...port(),createSetupWallet:async subject=>{creates++;started();await wait;return {subject,addresses:[a(1)]};}}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject:'verified-user',wallets:[a(1)]})));
  let changes=0;const unsubscribe=session.onGenerationChange(()=>{changes++;});session.onGenerationChange(()=>{throw Error('LOCAL_VIEW_ERROR');});
  const result=session.createSetupWallet(true);await reached;await assert.rejects(session.createSetupWallet(true),/WALLET_SIGNATURE_PENDING/);
  const logout=session.logout();assert.equal(changes,1);await logout;assert.equal(changes,2);unsubscribe();release();await assert.rejects(result,/SESSION_CHANGED/);assert.equal(creates,1);
  await session.logout();assert.equal(changes,2);
});
test('login start and completion invalidate setup reads without changing the original signing generation',async()=>{
  let finishLogin!:()=>void,startLogin!:()=>void,finishRead!:()=>void,startRead!:()=>void,subject='old-user';
  const loginWait=new Promise<void>(resolve=>{finishLogin=resolve;}),loginReached=new Promise<void>(resolve=>{startLogin=resolve;}),readWait=new Promise<void>(resolve=>{finishRead=resolve;}),readReached=new Promise<void>(resolve=>{startRead=resolve;});
  const session=new BrowserSession(async()=>({...port(),login:async()=>{startLogin();await loginWait;subject='new-user';},setupWallets:async subject=>{startRead();await readWait;return {subject,addresses:[a(1)]};}}),async url=>new Response(JSON.stringify(url==='/api/config'?configuration:{subject,wallets:[a(1)]})));
  let changes=0;session.onGenerationChange(()=>{changes++;});const epoch=session.generation;
  const oldRead=session.setupWallets();await readReached;const login=session.login('user@example.com','123456');await loginReached;assert.equal(changes,1);assert.equal(session.generation,epoch);
  await assert.rejects(session.setupWallets(),/LOGIN_PENDING/);await assert.rejects(session.createSetupWallet(true),/LOGIN_PENDING/);
  finishRead();await assert.rejects(oldRead,/SESSION_CHANGED/);finishLogin();assert.equal((await login).subject,'new-user');assert.equal(changes,2);assert.equal(session.generation,epoch);
  assert.deepEqual(await session.setupWallets(),{subject:'new-user',addresses:[a(1)]});
});
