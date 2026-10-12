import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,lstatSync,realpathSync,rmSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrivyClient} from '@privy-io/node';
import {canonicalP256PublicKey,parsePrivyServiceOwnerConfiguration,preparePrivyServiceBootstrap,inspectPrivyServiceOwner,
  privyServiceOwnerReadPort,PrivyServiceBootstrapError} from '../scripts/privy-service-bootstrap.js';
import {runPrivyServiceBootstrap,readPrivyServiceOwnerConfiguration,writePrivyServiceBootstrapPlan,
  privyServiceOwnerInputName,privyServicePlanDirectory,type PrivyServiceBootstrapRuntime} from '../scripts/prepare-privy-service-wallets.js';
import type {ReleaseSourceSnapshot} from '../scripts/release-source.js';
// Ephemeral local cryptography fixtures and SDK transports only; no user's keys or provider resources.
const localPublic=(curve='prime256v1')=>generateKeyPairSync('ec',{namedCurve:curve}).publicKey.export({format:'der',type:'spki'}).toString('base64');
const first=localPublic(),second=localPublic();
const config={schemaVersion:1,assetMode:'demo-erc20',chainId:'10143',operatorOwner:{quorumId:'local-operator-quorum',expectedPublicKeys:[first,second],authorizationThreshold:2}};
const clone=<T>(value:T):T=>structuredClone(value);
const source:ReleaseSourceSnapshot={sourceCommit:'1'.repeat(40),bindings:[{path:'scripts/privy-service-bootstrap.ts',bytes:10,sha256:'2'.repeat(64)}]};
const owner=()=>({id:config.operatorOwner.quorumId,authorization_keys:[{public_key:second,display_name:null},{public_key:first,display_name:null}],authorization_threshold:2,user_ids:null,key_quorum_ids:[],display_name:'local operator'});
function runtime(){
  const counts={source:0,input:0,port:0,gets:0,writes:0},env={PRIVY_APP_ID:'local-test-app',PRIVY_APP_SECRET:['LOCAL_TEST_APP_', 'CREDENTIAL_ONLY'].join('')};let saved:ReturnType<typeof preparePrivyServiceBootstrap>|undefined;
  const value:PrivyServiceBootstrapRuntime={argv:[],env,clock:()=>1791072000000,captureSource:()=>{counts.source++;return clone(source);},readOwnerConfiguration:()=>{counts.input++;return clone(config);},
    ownerReadPort:()=>{counts.port++;return {quorum:async id=>{counts.gets++;assert.equal(id,config.operatorOwner.quorumId);return owner();}};},writePlan:plan=>{counts.writes++;saved=plan;}};
  return {counts,env,value,saved:()=>saved};
}
test('private application-bound offline graph owns both deny-all policies and wallets without guessed policy identifiers',()=>{
  const plan=preparePrivyServiceBootstrap(config,'local-test-app');assert.equal(plan.appId,'local-test-app');assert.equal(plan.arbiter,null);assert.equal(plan.canExecute,false);assert.equal(plan.runtimeSignerAssigned,false);
  assert.deepEqual(plan.roles.map(role=>role.role),['reviewer','executor']);const ids=[];
  for(const role of plan.roles){
    assert.equal(role.policyCreate.request.owner_id,config.operatorOwner.quorumId);assert.deepEqual(role.policyCreate.request.rules,[{name:'Deny all requests',method:'*',action:'DENY',conditions:[]}]);
    assert.equal(role.walletCreate.request.owner_id,config.operatorOwner.quorumId);assert.deepEqual(role.walletCreate.request.additional_signers,[]);
    assert.equal('policy_ids'in role.walletCreate.request,false);assert.equal(role.walletCreate.policyIdsFrom.stepId,role.policyCreate.stepId);assert.equal(role.walletCreate.policyIdsFrom.field,'id');
    assert.equal(role.walletCreate.policyIdsFrom.requiredResult,'VERIFIED_CREATED_POLICY');assert.equal(role.walletCreate.policyIdsFrom.cardinality,1);
    assert.match(role.walletCreate.request.external_id,/^ip-[a-f0-9-]{36}-(reviewer|executor)$/);ids.push(role.policyCreate.request.idempotency_key,role.walletCreate.request.idempotency_key);
  }
  assert.equal(new Set(ids).size,4);assert.ok(ids.every(id=>/^[a-f0-9-]{36}$/.test(id)));assert.ok(Object.isFrozen(plan.roles[0].policyCreate.request.rules));
});
test('ownerless null extra fields credential keys malformed SPKI duplicate members and invalid thresholds never prepare',()=>{
  const bad=[{...config,operatorOwner:null},{...config,operatorOwner:{}},{...config,arbiter:'0x'+'11'.repeat(20)},
    {...config,operatorOwner:{...config.operatorOwner,quorumId:null}}, {...config,operatorOwner:{...config.operatorOwner,expectedPublicKeys:[]}},
    {...config,operatorOwner:{...config.operatorOwner,expectedPublicKeys:[first,first]}}, {...config,operatorOwner:{...config.operatorOwner,authorizationThreshold:0}},
    {...config,operatorOwner:{...config.operatorOwner,authorizationThreshold:3}}, {...config,operatorOwner:{...config.operatorOwner,expectedPublicKeys:['LOCAL_SECRET_AS_PUBLIC_KEY']}}];
  for(const input of bad)assert.throws(()=>preparePrivyServiceBootstrap(input,'local-test-app'),/^Error: PRIVY_SERVICE_OWNER_CONFIGURATION_INVALID$/);
  assert.throws(()=>canonicalP256PublicKey(localPublic('secp384r1')),/CONFIGURATION_INVALID/);
  const localPrivate=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
  assert.throws(()=>canonicalP256PublicKey(localPrivate),/CONFIGURATION_INVALID/);assert.throws(()=>canonicalP256PublicKey(first+'\n'),/CONFIGURATION_INVALID/);
  assert.throws(()=>preparePrivyServiceBootstrap(config,'bad\napp'),/CONFIGURATION_INVALID/);assert.throws(()=>preparePrivyServiceBootstrap(config,'local-app','not-a-uuid'),/CONFIGURATION_INVALID/);
});
test('owner inspector compares all members and threshold with exactly two stable GETs, without claiming key possession',async()=>{
  let reads=0;const result=await inspectPrivyServiceOwner(config,{quorum:async()=>{reads++;return owner();}});
  assert.equal(reads,2);assert.equal(result.readCallsAttempted,2);assert.equal(result.authorizationThreshold,2);assert.equal(result.authorizationPublicKeyCount,2);
  assert.equal(result.authorizationKeyPossessionVerified,false);assert.equal(result.runtimeMultisigSupported,false);assert.equal(result.canExecute,false);
  const text=JSON.stringify(result);assert.equal(text.includes(first),false);assert.equal(text.includes(config.operatorOwner.quorumId),false);
});
test('extra keys duplicate keys user members nested quorums owner mismatch and snapshot drift reject sanitized',async()=>{
  const changes=[{authorization_keys:[{public_key:first}]},{authorization_keys:[{public_key:first},{public_key:first}]},
    {authorization_keys:[{public_key:first},{public_key:second},{public_key:localPublic()}]}, {user_ids:['local-user']},{key_quorum_ids:['local-nested']},
    {authorization_threshold:1},{authorization_threshold:null},{id:'local-other-quorum'},{authorization_keys:[{public_key:'PRIVATE_BAD_PROVIDER_BODY'}]}];
  for(const change of changes)await assert.rejects(inspectPrivyServiceOwner(config,{quorum:async()=>({...owner(),...change})}),error=>{
    assert.ok(error instanceof PrivyServiceBootstrapError);assert.match(error.message,/^PRIVY_SERVICE_OWNER_METADATA_(INVALID|MISMATCH)$/);assert.equal(error.readCallsAttempted,1);assert.equal(JSON.stringify(error).includes('PRIVATE_BAD_PROVIDER_BODY'),false);return true;
  });
  let reads=0;await assert.rejects(inspectPrivyServiceOwner(config,{quorum:async()=>++reads===1?owner():({...owner(),authorization_threshold:1})}),/METADATA_MISMATCH/);assert.equal(reads,2);
  await assert.rejects(inspectPrivyServiceOwner(config,{quorum:async()=>{throw Error('PRIVATE_PROVIDER_TOKEN');}}),error=>error instanceof PrivyServiceBootstrapError&&error.message==='PRIVY_SERVICE_OWNER_READ_UNAVAILABLE'&&error.readCallsAttempted===1);
});
test('SDK capability adapter captures only quorum GET and resists later method replacement',async()=>{
  let forbidden=0,reads=0;const reject=()=>{forbidden++;throw Error('Forbidden local capability');};
  class Resource {get(id:string){assert.ok(this instanceof Resource);assert.equal(id,config.operatorOwner.quorumId);reads++;return Promise.resolve(owner());}create=reject;update=reject;}
  const resource=new Resource(),client={keyQuorums:()=>resource,wallets:reject,policies:reject} as unknown as PrivyClient;
  const port=privyServiceOwnerReadPort(client);resource.get=reject;assert.deepEqual(Object.keys(port),['quorum']);await inspectPrivyServiceOwner(config,port);assert.equal(reads,2);assert.equal(forbidden,0);
  for(const id of ['','../secret','https://local.invalid','sk-local','apikey_local'])await assert.rejects(port.quorum(id),/IDENTIFIER_INVALID/);assert.equal(reads,2);
});
test('pinned public SDK graph parameters become idempotency headers, absent from body, on a mocked transport only',async()=>{
  const plan=preparePrivyServiceBootstrap(config,'local-test-app'),requests:{path:string;headers:Headers;body:Record<string,unknown>}[]=[];
  const client=new PrivyClient({appId:'local-test-app',appSecret:['LOCAL_FIXTURE_', 'APP_CREDENTIAL'].join(''),maxRetries:0,logLevel:'off',fetch:async(input,init)=>{
    const path=new URL(String(input)).pathname,headers=new Headers(init?.headers),body=JSON.parse(String(init?.body));requests.push({path,headers,body});
    assert.equal(init?.method,'POST');assert.equal('idempotency_key'in body,false);assert.equal('privy-idempotency-key'in body,false);
    return new Response(JSON.stringify(path==='/v1/policies'?{...body,id:'local-created-policy',created_at:1}:{...body,id:'local-created-wallet',address:'0x'+'11'.repeat(20),created_at:1,exported_at:null,imported_at:null}),{headers:{'Content-Type':'application/json'}});
  }});
  const role=plan.roles[0];const policy=await client.policies().create(role.policyCreate.request);
  await client.wallets().create({...role.walletCreate.request,policy_ids:[policy.id]});
  assert.deepEqual(requests.map(request=>request.path),['/v1/policies','/v1/wallets']);
  assert.equal(requests[0].headers.get('privy-idempotency-key'),role.policyCreate.request.idempotency_key);assert.equal(requests[1].headers.get('privy-idempotency-key'),role.walletCreate.request.idempotency_key);
  assert.deepEqual(requests[1].body.policy_ids,['local-created-policy']);assert.equal(requests[1].body.owner_id,config.operatorOwner.quorumId);
});
test('CLI preparation reads public App ID only and saves a private plan without publishing owner identifiers or fingerprints',async()=>{
  const r=runtime();r.value.env=new Proxy(r.env,{get(target,key){if(typeof key==='string'&&key!=='PRIVY_APP_ID')throw Error('Forbidden credential read');return Reflect.get(target,key);}});
  const result=await runPrivyServiceBootstrap(r.value);assert.equal(result.exitCode,0);assert.equal(result.report.status,'PREPARED');assert.equal(result.report.privatePlanSaved,true);
  assert.deepEqual(r.counts,{source:2,input:2,port:0,gets:0,writes:1});assert.equal(r.saved()!.appId,r.env.PRIVY_APP_ID);
  const publicText=JSON.stringify(result.report);for(const value of [first,second,config.operatorOwner.quorumId,r.env.PRIVY_APP_ID,r.env.PRIVY_APP_SECRET])assert.equal(publicText.includes(value),false);
  assert.equal(result.report.inputFingerprintsRecorded,false);assert.equal(result.report.authorizationPrivateKeysRead,false);assert.equal(result.report.walletPrivateKeysRead,false);
});
test('optional inspection uses fixed authenticated app and two GETs, saving metadata only in the public report',async()=>{
  const r=runtime();r.value.argv=['--inspect'];r.value.ownerReadPort=credentials=>{r.counts.port++;assert.equal(credentials.appId,r.env.PRIVY_APP_ID);assert.equal(credentials.appSecret,r.env.PRIVY_APP_SECRET);return {quorum:async()=>{r.counts.gets++;return owner();}};};
  const result=await runPrivyServiceBootstrap(r.value);assert.equal(result.exitCode,0);assert.equal(result.report.status,'CURRENT_OPERATOR_OWNER_METADATA_VERIFIED');assert.equal(result.report.ownerMetadataVerified,true);assert.equal(result.report.readCallsAttempted,2);assert.equal(result.report.authorizationThreshold,2);
  assert.equal(result.report.canExecute,false);assert.equal(result.report.authorizationKeyPossessionVerified,false);assert.equal(r.counts.writes,1);
});
test('missing config application or inspection credentials stay BLOCKED with zero GETs and no private plan',async()=>{
  const missing=runtime();missing.value.argv=['--inspect'];missing.value.readOwnerConfiguration=()=>{throw new PrivyServiceBootstrapError('PRIVY_SERVICE_OWNER_INPUT_MISSING');};
  const absent=await runPrivyServiceBootstrap(missing.value);assert.equal(absent.exitCode,1);assert.equal(absent.report.status,'BLOCKED');assert.deepEqual(absent.report.missing,['PRIVY_SERVICE_OWNER_CONFIG']);assert.equal(absent.report.appConfigured,true);assert.equal(missing.counts.gets,0);assert.equal(missing.counts.writes,0);
  const noApp=runtime();delete (noApp.env as Partial<typeof noApp.env>).PRIVY_APP_ID;const appResult=await runPrivyServiceBootstrap(noApp.value);assert.equal(appResult.report.status,'BLOCKED');assert.deepEqual(appResult.report.missing,['PRIVY_APP_ID']);assert.equal(noApp.counts.gets,0);assert.equal(noApp.counts.writes,0);
  const noCredentials=runtime();noCredentials.value.argv=['--inspect'];delete (noCredentials.env as Partial<typeof noCredentials.env>).PRIVY_APP_SECRET;const credentialResult=await runPrivyServiceBootstrap(noCredentials.value);assert.equal(credentialResult.report.status,'BLOCKED');assert.deepEqual(credentialResult.report.missing,['PRIVY_APP_SECRET']);assert.equal(noCredentials.counts.port,0);assert.equal(noCredentials.counts.writes,0);
});
test('unsupported execution or arbitrary paths fail before input source credential reads or GETs',async()=>{
  for(const args of [['--execute'],['--inspect','--execute'],['/private/local.json'],['--url=https://local.invalid']]){
    const r=runtime();r.value.argv=args;r.value.env=new Proxy({},{get(){throw Error('Forbidden credential read');}});
    const result=await runPrivyServiceBootstrap(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_SERVICE_ARGUMENT_INVALID');assert.deepEqual(r.counts,{source:0,input:0,port:0,gets:0,writes:0});
  }
});
test('source or clock drift discards metadata success and never saves a plan',async()=>{
  const r=runtime();r.value.argv=['--inspect'];r.value.captureSource=()=>++r.counts.source===1?clone(source):({...clone(source),sourceCommit:'3'.repeat(40)});
  const result=await runPrivyServiceBootstrap(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_SERVICE_SOURCE_CHANGED');assert.equal(result.report.ownerMetadataVerified,false);assert.equal(r.counts.writes,0);
  const clock=runtime();let calls=0;clock.value.clock=()=>++calls===1?1791072000000:1791071999999;const clockResult=await runPrivyServiceBootstrap(clock.value);assert.equal(clockResult.report.reason,'PRIVY_SERVICE_CLOCK_INVALID');assert.equal(clock.counts.writes,0);
});
test('private owner input drift across the GETs fails without publishing changed values or saving a plan',async()=>{
  const r=runtime();r.value.argv=['--inspect'];r.value.readOwnerConfiguration=()=>++r.counts.input===1?clone(config):({...clone(config),operatorOwner:{...clone(config.operatorOwner),quorumId:'changed-private-owner'}});
  const result=await runPrivyServiceBootstrap(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_SERVICE_OWNER_CONFIGURATION_CHANGED');assert.equal(result.report.ownerMetadataVerified,false);assert.equal(r.counts.gets,2);assert.equal(r.counts.writes,0);assert.equal(JSON.stringify(result.report).includes('changed-private-owner'),false);
});
function files(){const root=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-privy-service-'));mkdirSync(join(root,'.tools'),{mode:0o700});return {root,path:join(root,privyServiceOwnerInputName),close:()=>rmSync(root,{recursive:true,force:true})};}
test('actual fixed owner file accepts canonical 0600 strict JSON and rejects public modes symlinks duplicate keys or oversized bytes',()=>{
  const f=files();try{
    writeFileSync(f.path,JSON.stringify(config),{mode:0o600});assert.deepEqual(parsePrivyServiceOwnerConfiguration(readPrivyServiceOwnerConfiguration(f.root)),config);
    chmodSync(f.path,0o644);assert.throws(()=>readPrivyServiceOwnerConfiguration(f.root),/^Error: PRIVY_SERVICE_OWNER_INPUT_INVALID$/);chmodSync(f.path,0o600);
    for(const raw of ['{"schemaVersion":1,"schemaVersion":1}',' '.repeat(65537)]){writeFileSync(f.path,raw);assert.throws(()=>readPrivyServiceOwnerConfiguration(f.root),/INPUT_INVALID/);}
    rmSync(f.path);const other=join(f.root,'other.json');writeFileSync(other,JSON.stringify(config),{mode:0o600});symlinkSync(other,f.path);assert.throws(()=>readPrivyServiceOwnerConfiguration(f.root),/INPUT_INVALID/);
  }finally{f.close();}
});
test('actual private plan writer creates one immutable 0600 UUID file and never overwrites or follows a symlink directory',()=>{
  const f=files();try{
    const plan=preparePrivyServiceBootstrap(config,'local-app',randomUUID());writePrivyServiceBootstrapPlan(f.root,plan,source);
    const directory=join(f.root,privyServicePlanDirectory),path=join(directory,plan.planId+'.json');assert.equal(lstatSync(path).mode&0o777,0o600);assert.equal(lstatSync(directory).mode&0o777,0o700);
    const bytes=readFileSync(path,'utf8');assert.equal(JSON.parse(bytes).appId,'local-app');assert.equal(JSON.parse(bytes).configuration.operatorOwner.quorumId,config.operatorOwner.quorumId);
    assert.throws(()=>writePrivyServiceBootstrapPlan(f.root,plan,source),/PLAN_WRITE_UNAVAILABLE/);assert.equal(readFileSync(path,'utf8'),bytes);assert.equal(readdirSync(directory).length,1);
    rmSync(directory,{recursive:true});const target=join(f.root,'outside');mkdirSync(target);symlinkSync(target,directory);assert.throws(()=>writePrivyServiceBootstrapPlan(f.root,preparePrivyServiceBootstrap(config,'local-app'),source),/PLAN_WRITE_UNAVAILABLE/);assert.deepEqual(readdirSync(target),[]);
  }finally{f.close();}
});
