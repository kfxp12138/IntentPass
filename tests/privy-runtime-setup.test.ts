import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,readFileSync,writeFileSync,readdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareRuntimeSetup,installRuntimeSetup,type RuntimeConfig,type RuntimePort} from '../scripts/privy-runtime-setup.js';
const operatorPublic=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64');
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
function fixture(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-runtime-'));mkdirSync(join(root,'.tools'),{mode:0o700});
  const config:RuntimeConfig={appId:'test-app',chainId:'10143',arbiter:a(10),model:'jev-1.13.0',questionConfigHash:'0x'+'11'.repeat(32),roles:{reviewer:{address:a(1),walletId:'review-wallet',initialPolicyId:'review-deny'},executor:{address:a(2),walletId:'exec-wallet',initialPolicyId:'exec-deny'}},owner:{schemaVersion:1,assetMode:'demo-erc20',chainId:'10143',operatorOwner:{quorumId:'operator-owner',authorizationThreshold:1,expectedPublicKeys:[operatorPublic]}}};
  const quorums=new Map<string,any>(),policies=new Map<string,any>(),wallets=new Map<string,any>(),calls:{kind:string;body:any}[]=[];
  const owner={id:'operator-owner',authorization_threshold:1,authorization_keys:[{public_key:operatorPublic}],user_ids:[],key_quorum_ids:[]};quorums.set(owner.id,owner);
  for(const r of Object.values(config.roles)){policies.set(r.initialPolicyId,{id:r.initialPolicyId,owner_id:'operator-owner',version:'1.0',chain_type:'ethereum',rules:[{method:'*',action:'DENY',conditions:[]}]});wallets.set(r.walletId,{id:r.walletId,address:r.address,owner_id:'operator-owner',chain_type:'ethereum',policy_ids:[r.initialPolicyId],additional_signers:[],exported_at:null,imported_at:null,archived_at:null,automations:[]});}
  const port:RuntimePort={quorum:async id=>structuredClone(quorums.get(id)),createQuorum:async body=>{assert.ok(body.display_name.length<=50,'Privy OpenAPI display_name maxLength is 50');calls.push({kind:'quorum',body});const q={id:'runtime-'+quorums.size,authorization_threshold:body.authorization_threshold,authorization_keys:body.public_keys.map(public_key=>({public_key})),user_ids:[],key_quorum_ids:[]};quorums.set(q.id,q);return structuredClone(q);},
    policy:async id=>structuredClone(policies.get(id)),wallet:async id=>structuredClone(wallets.get(id)),
    createPolicy:async(body,ownerId,idempotencyKey)=>{calls.push({kind:'policy',body:{...body,owner_id:ownerId,idempotency_key:idempotencyKey}});const p={...structuredClone(body),id:'runtime-policy-'+policies.size,owner_id:ownerId};policies.set(p.id,p);return structuredClone(p);},
    addSigner:async(id,body)=>{calls.push({kind:'delegate',body:{id,...body}});wallets.get(id).additional_signers=structuredClone(body.additional_signers);return structuredClone(wallets.get(id));}};
  let verifications=0;const run=()=>installRuntimeSetup({root,config,approved:true,port,verifyDeployment:async()=>{verifications++;}});
  return {root,config,port,quorums,policies,wallets,calls,run,verifications:()=>verifications,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('separate runtime keys never enter public plans and match only their exact signing scopes',()=>{
  const f=fixture();try{const p=prepareRuntimeSetup(f.root,f.config),m=JSON.parse(readFileSync(join(f.root,'.tools/privy-runtime/material.json'),'utf8'));for(const role of ['reviewer','executor'])assert.ok(!JSON.stringify(p).includes(m.roles[role].privateKey));assert.notEqual(m.roles.reviewer.publicKey,m.roles.executor.publicKey);assert.equal(p.roles[0].policy.rules[0].method,'eth_signTypedData_v4');assert.equal(p.roles[1].policy.rules.length,3);assert.deepEqual(prepareRuntimeSetup(f.root,f.config),p);}finally{f.close();}
});
test('creates only two keys two policies and two constrained delegations, retains the owner deny-all policies, and resumes without mutation',async()=>{
  const f=fixture();try{const r=await f.run();assert.equal(r.mutationsThisRun,6);assert.equal(f.verifications(),2);assert.deepEqual(f.calls.map(x=>x.kind),['quorum','policy','delegate','quorum','policy','delegate']);
    for(const role of r.roles){const w=f.wallets.get(role.walletId);assert.equal(w.owner_id,'operator-owner');assert.deepEqual(w.policy_ids,[role.initialPolicyId]);assert.deepEqual(w.additional_signers,[{signer_id:role.signerId,override_policy_ids:[role.policyId]}]);assert.deepEqual(f.policies.get(role.initialPolicyId).rules,[{method:'*',action:'DENY',conditions:[]}]);}
    const again=await f.run();assert.equal(again.mutationsThisRun,0);assert.equal(f.calls.length,6);
  }finally{f.close();}
});
test('unverified deployment blocks every provider mutation',async()=>{const f=fixture();try{await assert.rejects(installRuntimeSetup({root:f.root,config:f.config,approved:true,port:f.port,verifyDeployment:async()=>{throw Error('DEPLOYMENT_MISMATCH');}}));assert.equal(f.calls.length,0);}finally{f.close();}});
test('lost quorum create response is never retried with a new quorum',async()=>{const f=fixture();try{const create=f.port.createQuorum;f.port.createQuorum=async p=>{await create(p);throw Error('PRIVATE_TOKEN');};await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);f.port.createQuorum=create;await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);assert.equal(f.calls.length,1);}finally{f.close();}});
test('lost delegation response recovers by current exact wallet state without a second PATCH',async()=>{const f=fixture();try{const patch=f.port.addSigner;let first=true;f.port.addSigner=async(id,p)=>{const r=await patch(id,p);if(first){first=false;throw Error('lost response');}return r;};await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);const r=await f.run();assert.equal(r.recoveredUpdates,1);assert.equal(f.calls.filter(c=>c.kind==='delegate').length,2);assert.equal(f.calls.length,6);}finally{f.close();}});
test('a failed unapplied delegation remains unknown and cannot PATCH again',async()=>{const f=fixture();try{let attempts=0;f.port.addSigner=async()=>{attempts++;throw Error('PRIVATE_BODY');};await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);assert.equal(attempts,1);}finally{f.close();}});
test('unexpected pre-existing signer and changed baseline policy are rejected before registration',async()=>{for(const kind of ['signer','policy']){const f=fixture();try{if(kind==='signer')f.wallets.get('review-wallet').additional_signers=[{signer_id:'foreign',override_policy_ids:['foreign-policy']}];else f.policies.get('review-deny').rules[0].action='ALLOW';await assert.rejects(f.run());assert.equal(f.calls.length,0);}finally{f.close();}}});
test('quorum membership drift and broader policy responses cannot install signer authority',async()=>{for(const kind of ['key','policy']){const f=fixture();try{if(kind==='key'){const create=f.port.createQuorum;f.port.createQuorum=async p=>({...await create(p) as object,authorization_keys:[{public_key:operatorPublic}]});}else{const create=f.port.createPolicy;f.port.createPolicy=async(p,o,k)=>({...await create(p,o,k) as object,rules:[{method:'*',action:'ALLOW',conditions:[]}]});}await assert.rejects(f.run());assert.equal(f.calls.some(c=>c.kind==='delegate'),false);}finally{f.close();}}});
test('changed config, malformed material and public material modes never create resources',async()=>{const f=fixture();try{prepareRuntimeSetup(f.root,f.config);assert.throws(()=>prepareRuntimeSetup(f.root,{...f.config,arbiter:a(99)}));const path=join(f.root,'.tools/privy-runtime/material.json');chmodSync(path,0o644);await assert.rejects(f.run());assert.equal(f.calls.length,0);chmodSync(path,0o600);writeFileSync(path,'{');await assert.rejects(f.run());assert.equal(f.calls.length,0);}finally{f.close();}});
test('explicit approval is checked before any key generation or provider mutation',async()=>{const f=fixture();try{await assert.rejects(installRuntimeSetup({root:f.root,config:f.config,approved:false,port:f.port,verifyDeployment:async()=>{}}),/APPROVAL_REQUIRED/);assert.equal(f.calls.length,0);assert.equal(readdirSync(join(f.root,'.tools')).length,0);}finally{f.close();}});
test('only the published invalid-name correction can proceed and the original unknown reservation is preserved',async()=>{
  const f=fixture();try{
    const create=f.port.createQuorum;f.port.createQuorum=async()=>{throw Error('interrupted');};await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);f.port.createQuorum=create;
    const directory=join(f.root,'.tools/privy-runtime/execution'),path=join(directory,'reviewer-key.reserved.json');const reservation=JSON.parse(readFileSync(path,'utf8')),plan=prepareRuntimeSetup(f.root,f.config);
    reservation.request.display_name=`IntentPass reviewer runtime ${plan.planId}`;writeFileSync(path,JSON.stringify(reservation));const original=readFileSync(path,'utf8');
    await assert.rejects(f.run(),/INVALID_NAME_CORRECTION_REQUIRED/);assert.equal(f.calls.length,0);
    const result=await installRuntimeSetup({root:f.root,config:f.config,approved:true,correctInvalidQuorumName:true,port:f.port,verifyDeployment:async()=>{}});
    assert.equal(result.mutationsThisRun,6);assert.equal(readFileSync(path,'utf8'),original);assert.ok(readdirSync(directory).includes('reviewer-key-name-correction.reserved.json'));
    const again=await f.run();assert.equal(again.mutationsThisRun,0);assert.equal(f.calls.length,6);
  }finally{f.close();}
});
test('name correction cannot release a valid request whose response was lost',async()=>{
  const f=fixture();try{const create=f.port.createQuorum;f.port.createQuorum=async()=>{throw Error('lost');};await assert.rejects(f.run(),/OUTCOME_UNKNOWN/);f.port.createQuorum=create;await assert.rejects(installRuntimeSetup({root:f.root,config:f.config,approved:true,correctInvalidQuorumName:true,port:f.port,verifyDeployment:async()=>{}}),/OUTCOME_UNKNOWN/);assert.equal(f.calls.length,0);}finally{f.close();}
});
