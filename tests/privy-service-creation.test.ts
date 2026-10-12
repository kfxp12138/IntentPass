import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServiceWallets,validateServiceCreationPlan,type ServiceCreationPort} from '../scripts/create-privy-service-wallets.js';
import {preparePrivyServiceBootstrap} from '../scripts/privy-service-bootstrap.js';
const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64');
const owner={schemaVersion:1 as const,assetMode:'demo-erc20' as const,chainId:'10143' as const,operatorOwner:{quorumId:'test-owner',expectedPublicKeys:[key],authorizationThreshold:1}};
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-service-creation-'));mkdirSync(join(root,'.tools'),{mode:0o700});mkdirSync(join(root,'.tools/privy-service-wallet-plans'),{mode:0o700});
  const plan=preparePrivyServiceBootstrap(owner,'local-app'),planPath=join(root,'.tools/privy-service-wallet-plans',plan.planId+'.json');
  writeFileSync(join(root,'.tools/privy-service-owner.json'),JSON.stringify(owner),{mode:0o600});writeFileSync(planPath,JSON.stringify(plan),{mode:0o600});
  const policies=new Map<string,unknown>(),wallets=new Map<string,unknown>(),calls:{kind:string;request:unknown}[]=[];
  const port:ServiceCreationPort={quorum:async()=>({id:'test-owner',authorization_keys:[{public_key:key}],authorization_threshold:1,user_ids:[],key_quorum_ids:[]}),
    createPolicy:async request=>{calls.push({kind:'policy',request});const id='test-policy-'+policies.size,p={...request,id};delete (p as Partial<typeof p>).idempotency_key;policies.set(id,p);return structuredClone(p);},policy:async id=>structuredClone(policies.get(id)),
    createWallet:async request=>{calls.push({kind:'wallet',request});const id='test-wallet-'+wallets.size,w={...request,id,address:'0x'+String(wallets.size+1).padStart(40,'0'),exported_at:null,imported_at:null,archived_at:null};delete (w as Partial<typeof w>).idempotency_key;wallets.set(id,w);return structuredClone(w);},wallet:async id=>structuredClone(wallets.get(id))};
  const run=()=>createServiceWallets({root,planId:plan.planId,appId:'local-app',approved:true,port});
  return {root,plan,planPath,port,calls,policies,wallets,run,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('creates only owned deny-all roles with durable original reservations, real policy references, and read-only resumption',async()=>{
  const f=fixture();try{
    const create=f.port.createPolicy;f.port.createPolicy=async request=>{const files=readdirSync(join(f.root,'.tools/privy-service-execution'));assert.ok(files.some(n=>n.endsWith('.reserved.json')));return create(request);};
    const result=await f.run();assert.equal(result.status,'SERVICE_WALLETS_VERIFIED_DENY_ALL');assert.equal(result.mutationsThisRun,4);assert.equal(result.canExecute,false);
    assert.deepEqual(f.calls.map(c=>c.kind),['policy','wallet','policy','wallet']);
    for(let i=0;i<2;i++){
      const p=f.calls[i*2].request as any,w=f.calls[i*2+1].request as any;
      assert.equal(p.owner_id,'test-owner');assert.deepEqual(p.rules,[{name:'Deny all requests',method:'*',action:'DENY',conditions:[]}]);
      assert.equal(w.owner_id,'test-owner');assert.deepEqual(w.additional_signers,[]);assert.deepEqual(w.policy_ids,['test-policy-'+i]);
      assert.equal(p.idempotency_key,f.plan.roles[i].policyCreate.request.idempotency_key);assert.equal(w.idempotency_key,f.plan.roles[i].walletCreate.request.idempotency_key);
    }
    const again=await f.run();assert.equal(again.mutationsThisRun,0);assert.equal(f.calls.length,4);assert.deepEqual(again.roles,result.roles);
  }finally{f.close();}
});
test('lost response reserves forever across new invocations and never creates a replacement',async()=>{
  const f=fixture();try{
    const create=f.port.createPolicy;f.port.createPolicy=async request=>{await create(request);throw Error('PRIVATE_RESPONSE');};
    await assert.rejects(f.run(),/^Error: PRIVY_SERVICE_CREATE_OUTCOME_UNKNOWN$/);assert.equal(f.calls.length,1);
    f.port.createPolicy=create;await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);assert.equal(f.calls.length,1);
    assert.equal(readdirSync(join(f.root,'.tools/privy-service-execution')).filter(n=>n.endsWith('.response.json')).length,0);
  }finally{f.close();}
});
test('a failed GET after saved creation resumes through GET without repeating POST',async()=>{
  const f=fixture();try{
    const get=f.port.policy;f.port.policy=async()=>{throw Error('PRIVATE_TOKEN');};
    await assert.rejects(f.run(),/^Error: PRIVY_SERVICE_CREATE_READ_UNAVAILABLE$/);assert.equal(f.calls.length,1);
    f.port.policy=get;const result=await f.run();assert.equal(result.mutationsThisRun,3);assert.equal(f.calls.length,4);
  }finally{f.close();}
});
test('malformed or broader resource responses cannot enable the dependent wallet creation',async()=>{
  for(const change of [{owner_id:'foreign-owner'},{rules:[{name:'Allow',method:'*',action:'ALLOW',conditions:[]}]}]){
    const f=fixture();try{const create=f.port.createPolicy;f.port.createPolicy=async request=>({...await create(request) as object,...change});await assert.rejects(f.run(),/POLICY_INVALID/);assert.equal(f.calls.length,1);await assert.rejects(f.run(),/POLICY_INVALID/);assert.equal(f.calls.length,1);}finally{f.close();}
  }
});
test('wallet policy/owner changes and unexpected signers are rejected without creating later roles',async()=>{
  for(const change of [{owner_id:'foreign-owner'},{policy_ids:[]},{additional_signers:[{signer_id:'foreign'}]},{exported_at:1}]){
    const f=fixture();try{const create=f.port.createWallet;f.port.createWallet=async request=>({...await create(request) as object,...change});await assert.rejects(f.run(),/WALLET_INVALID/);assert.equal(f.calls.length,2);}finally{f.close();}
  }
});
test('plan tampering, another app, extra fields and reused idempotency keys fail before mutation',async()=>{
  const f=fixture();try{
    for(const change of ['app','rule','signer','extra','idempotency']){
      const p=structuredClone(f.plan) as any;
      if(change==='app')p.appId='other-app';if(change==='rule')p.roles[0].policyCreate.request.rules[0].action='ALLOW';if(change==='signer')p.roles[0].walletCreate.request.additional_signers=[{signer_id:'foreign'}];if(change==='extra')p.roles[0].walletCreate.request.owner={user_id:'foreign'};if(change==='idempotency')p.roles[1].walletCreate.request.idempotency_key=p.roles[0].walletCreate.request.idempotency_key;
      assert.throws(()=>validateServiceCreationPlan(p,owner,'local-app'),/PLAN_INVALID/);
    }
    await assert.rejects(createServiceWallets({root:f.root,planId:f.plan.planId,appId:'local-app',approved:false,port:f.port}),/APPROVAL_REQUIRED/);assert.equal(f.calls.length,0);
  }finally{f.close();}
});
test('another plan cannot replace the original creation slots even after successful execution',async()=>{
  const f=fixture();try{
    await f.run();const second=preparePrivyServiceBootstrap(owner,'local-app');writeFileSync(join(f.root,'.tools/privy-service-wallet-plans',second.planId+'.json'),JSON.stringify(second),{mode:0o600});
    await assert.rejects(createServiceWallets({root:f.root,planId:second.planId,appId:'local-app',approved:true,port:f.port}),/ORIGINAL_PLAN_REQUIRED/);assert.equal(f.calls.length,4);
  }finally{f.close();}
});
test('saved source manifests above 64 KiB are accepted, while files above the explicit 1 MiB bound are rejected',async()=>{
  const f=fixture();try{
    writeFileSync(f.planPath,JSON.stringify({...f.plan,source:{bindings:[{path:'synthetic-source',notes:'x'.repeat(75000)}]}}));
    assert.equal((await f.run()).mutationsThisRun,4);
    writeFileSync(f.planPath,JSON.stringify({...f.plan,source:{notes:'x'.repeat(1024*1024)}}));
    await assert.rejects(f.run(),/PRIVATE_FILE_INVALID/);assert.equal(f.calls.length,4);
  }finally{f.close();}
});
test('concurrent invocations cannot duplicate an in-flight creation',async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  try{const create=f.port.createPolicy;f.port.createPolicy=async request=>{entered();await wait;return create(request);};const first=f.run();await started;await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);release();await first;assert.equal(f.calls.length,4);}finally{release();f.close();}
});
test('insecure files, symlink journals and a truncated reservation fail closed before provider creation',async()=>{
  for(const kind of ['mode','symlink','partial']){
    const f=fixture();try{
      if(kind==='mode')chmodSync(f.planPath,0o644);
      if(kind==='symlink'){const target=join(f.root,'other');mkdirSync(target,{mode:0o700});symlinkSync(target,join(f.root,'.tools/privy-service-execution'));}
      if(kind==='partial'){f.port.createPolicy=async()=>{throw Error('interrupted');};await assert.rejects(f.run());const p=join(f.root,'.tools/privy-service-execution/reviewer-initial-policy.reserved.json');writeFileSync(p,'{');}
      await assert.rejects(f.run());assert.equal(f.calls.length,0);
    }finally{f.close();}
  }
});
