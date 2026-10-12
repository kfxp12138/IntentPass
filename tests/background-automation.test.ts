import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,statSync,writeFileSync,rmSync,chmodSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {BackgroundVault} from '../packages/storage/src/background-vault.js';
import {BackgroundScopeSchema,backgroundScopeHash,assertBackgroundTask} from '../packages/automation/src/background-scope.js';
import {backgroundActorPolicy,inspectBackgroundAuthority} from '../packages/adapters/src/privy-background-policy.js';
import {BackgroundProcurement,type BackgroundPorts} from '../apps/worker/src/background-procurement.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {readTestHash,readTestAddress} from './support/original-authorization.js';
import type {AutomaticPayment} from '../apps/web/src/purchase-automation.js';
import type {CompleteOrderAutomation} from '../apps/web/src/order-automation.js';
import {AuthorizationPayloadSchema} from '../packages/capsule/src/format.js';
import {reportDelivery} from '../packages/protocol/src/fulfillment.js';
import {withdrawalAnchor} from '../packages/protocol/src/withdrawal-api.js';
import {createBackgroundActor} from '../packages/adapters/src/privy-background-actor.js';
import {generateKeyPairSync} from 'node:crypto';
import type {PrivyClient} from '@privy-io/node';

const hash='a'.repeat(64),id='b'.repeat(64);
function directory(){return mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-background-'));}
test('backend AES-GCM backup survives restart without WebAuthn, binds namespaces and keeps cleartext out of private files',()=>{
  const root=directory();let vault:BackgroundVault|undefined,restarted:BackgroundVault|undefined;
  try{
    vault=new BackgroundVault(root);const payload={original:'LOCAL_SYNTHETIC_SIGNED_AUTHORIZATION',dataset:[3,7,11,19]};
    const receipt=vault.save('authorization',id,hash,payload);assert.equal(receipt.format,'IntentPass.BackgroundBackup.v1');
    assert.deepEqual(vault.open('authorization',id,hash),payload);vault.dispose();restarted=new BackgroundVault(root);assert.deepEqual(restarted.open('authorization',id,hash),payload);
    for(const file of readdirSync(root)){assert.equal(statSync(resolve(root,file)).mode&0o777,0o600);assert.doesNotMatch(readFileSync(resolve(root,file),'utf8'),/LOCAL_SYNTHETIC_SIGNED_AUTHORIZATION|\[3,7,11,19\]/);}
    assert.throws(()=>restarted!.open('authorization',id,'c'.repeat(64)),/BACKGROUND_BACKUP_UNAVAILABLE/);
    assert.throws(()=>restarted!.open('memory',id,hash),/BACKGROUND_BACKUP_UNAVAILABLE/);
    assert.throws(()=>restarted!.save('authorization',id,hash,payload),/ORIGINAL_BACKUP_LOCKED/);
    const path=resolve(root,`authorization-${id}.json`),file=JSON.parse(readFileSync(path,'utf8'));file.tag='0'.repeat(32);writeFileSync(path,JSON.stringify(file));
    assert.throws(()=>restarted!.open('authorization',id,hash),/^Error: BACKGROUND_BACKUP_UNAVAILABLE$/);
  }finally{vault?.dispose();restarted?.dispose();rmSync(root,{recursive:true,force:true});}
});
test('background vault rejects unsafe key files and immutable single-job leases survive a fresh process',()=>{
  const root=directory();let vault:BackgroundVault|undefined;
  try{vault=new BackgroundVault(root);vault.reserve(hash);assert.throws(()=>new BackgroundVault(root).reserve(hash),/RECONCILIATION_REQUIRED/);chmodSync(resolve(root,'key.json'),0o644);assert.throws(()=>new BackgroundVault(root),/PRIVATE_FILE_INVALID/);}
  finally{vault?.dispose();rmSync(root,{recursive:true,force:true});}
  const parent=directory(),target=resolve(parent,'target'),link=resolve(parent,'link');const actual=new BackgroundVault(target);actual.dispose();symlinkSync(target,link);
  try{assert.throws(()=>new BackgroundVault(link),/PRIVATE_PATH_INVALID/);}finally{rmSync(parent,{recursive:true,force:true});}
});
async function fixture(){
  const f=await purchaseEvidenceFixture({background:true});f.setChoice('SUPPORTED');
  const scope=BackgroundScopeSchema.parse({version:1,mode:'single-report-background',chainId:'10143',deployment:f.deployment,taskId:f.task().policy.taskId,datasetHash:f.task().policy.datasetHash,quoteId:f.entry.quote.quoteId,buyer:f.buyer.address,seller:f.seller.address,payee:f.seller.address,maxTotalUnits:'10',maxOrders:1,expiresAt:'5000',backup:'server-local-aes256gcm'}),memory={schemaVersion:1,kind:'memory',...f.task()};
  const root=directory(),vault=new BackgroundVault(root),stages:string[]=[];let ready=0,payments=0,fulfillments=0,badProof=false,paymentStatus:'CONFIRMED'|'ATTENTION'='CONFIRMED';
  const ports:BackgroundPorts={flow:f.flow,assertDelegationReady:async()=>{ready++;},payment:(_p,backup)=>({run:async()=>{assert.equal(backup(),true);payments++;return {status:paymentStatus};}} as unknown as AutomaticPayment),fulfillment:(input,dataset)=>({run:async(_confirmed:boolean,_active:()=>void,progress:(stage:string)=>void)=>{
    fulfillments++;progress('COMPLETE');if(badProof)return {status:'CONFIRMED',payout:{hash:readTestHash(44)}};
    const p=AuthorizationPayloadSchema.parse(input),r=reportDelivery(p,[...dataset]),hash=readTestHash(44),block={number:'100',hash:readTestHash(11)},e=p.intent;
    const order={...f.snapshot('ALLOCATED_PAID'),orderId:e.orderId,contextHash:p.grant.contextHash,datasetHash:e.datasetHash,serviceTermsHash:e.serviceTermsHash,evidenceHash:r.evidenceHash,deliveryDeadline:e.deliveryDeadline,settlementDeadline:e.settlementDeadline,price:e.price,bond:e.bond,credits:{buyer:'0',payee:'0'},withdrawn:{buyer:'0',payee:e.price},accounting:{locked:'0',outstanding:'0',balance:'0'}};
    const record={...withdrawalAnchor({payload:p,beneficiary:e.payee},'ALLOCATED_PAID'),attempt:'1',retryOf:null,status:'CONFIRMED',hash,receiptBlock:block};
    const receipt={status:'CONFIRMED',hash,beneficiary:e.payee,transferredAmount:e.price,beneficiaryBalance:e.price,order,receiptBlock:block,finality:'finalized',canExecute:false};
    return {status:'CONFIRMED',orderId:e.orderId,payout:{status:'CONFIRMED',result:{record,receipt,canExecute:false}}};
  }} as unknown as CompleteOrderAutomation)};
  const activation={scopeHash:backgroundScopeHash(scope),localPlaintextProcessingApproved:true,walletDelegationApproved:true},run=new BackgroundProcurement(scope,vault,ports,f.clock);
  return {...f,scope,memory,vault,root,ports,activation,run,stages,progress:(s:string)=>stages.push(s),countsBackground:()=>({ready,payments,fulfillments}),badProof:()=>{badProof=true;},unknownPayment:()=>{paymentStatus='ATTENTION';},cleanup:()=>{vault.dispose();rmSync(root,{recursive:true,force:true});}};
}
test('scope, initial trust and real delegation readiness are required before models, device access or signing',async()=>{
  const f=await fixture();try{
    assert.throws(()=>BackgroundScopeSchema.parse({...f.scope,maxTotalUnits:'11'}));
    assert.throws(()=>assertBackgroundTask(f.scope,{...f.memory,taskInput:{...f.memory.taskInput,buyer:readTestAddress(999)}},1000n),/TASK_SCOPE_REJECTED/);
    await assert.rejects(f.run.run(f.memory,{...f.activation,walletDelegationApproved:false}),/INITIAL_SETUP_APPROVAL_REQUIRED/);
    f.ports.assertDelegationReady=async()=>{throw Error('BACKGROUND_DELEGATION_REQUIRED');};await assert.rejects(f.run.run(f.memory,f.activation),/DELEGATION_REQUIRED/);
    assert.deepEqual(f.counts(),{planner:0,jev:0,signatures:0});assert.equal(readdirSync(f.root).some(v=>v==='single-job.json'),false);
  }finally{f.cleanup();}
});
test('headless original pipeline seals and reads back both backups and completes only after verified payout',async()=>{
  const f=await fixture();try{
    const result=await f.run.run(f.memory,f.activation,f.progress);assert.equal(result.status,'CONFIRMED');assert.deepEqual(f.counts(),{planner:1,jev:1,signatures:1});assert.deepEqual(f.countsBackground(),{ready:2,payments:1,fulfillments:1});
    assert.equal(f.stages.includes('DEVICE'),false);assert.equal(f.stages.at(-1),'COMPLETE');assert.equal(f.stages.filter(s=>s==='COMPLETE').length,1);assert.ok(f.stages.indexOf('BACKUP_AUTHORIZATION')<f.stages.indexOf('PAYOUT_RETURNED'));
    const original=f.vault.open('authorization',f.flow.signedAuthorization!.payload.intent.orderId.slice(2),f.activation.scopeHash) as {payload:unknown;dataset:number[]};assert.deepEqual(original.payload,f.flow.signedAuthorization!.payload);assert.deepEqual(original.dataset,f.dataset);
    await assert.rejects(f.run.run(f.memory,f.activation),/RECONCILIATION_REQUIRED/);
    await assert.rejects(new BackgroundProcurement(f.scope,new BackgroundVault(f.root),f.ports,f.clock).run(f.memory,f.activation),/RECONCILIATION_REQUIRED/);assert.equal(f.counts().signatures,1);
  }finally{f.cleanup();}
});
test('JEV abstention and unknown payment stop without new signing, fulfillment or a second task lease',async()=>{
  for(const variant of ['ABSTAIN','UNKNOWN'] as const){const f=await fixture();try{
    if(variant==='ABSTAIN')f.setChoice('INSUFFICIENT');else f.unknownPayment();
    const result=await f.run.run(f.memory,f.activation,f.progress);assert.equal(result.status,'ATTENTION');assert.equal(f.counts().signatures,variant==='ABSTAIN'?0:1);assert.equal(f.countsBackground().fulfillments,0);
    await assert.rejects(f.run.run(f.memory,f.activation),/RECONCILIATION_REQUIRED/);assert.equal(f.stages.includes('COMPLETE'),false);
  }finally{f.cleanup();}}
});
test('a hash or progress event cannot claim payout and backup failure occurs before money',async()=>{
  const f=await fixture();try{f.badProof();await assert.rejects(f.run.run(f.memory,f.activation,f.progress));assert.equal(f.stages.includes('COMPLETE'),false);assert.equal(f.stages.at(-1),'ATTENTION');}finally{f.cleanup();}
  const failed=await fixture();try{failed.vault.save=()=>{throw Error('BACKGROUND_BACKUP_UNAVAILABLE');};await assert.rejects(failed.run.run(failed.memory,failed.activation),/BACKUP_UNAVAILABLE/);assert.equal(failed.countsBackground().payments,0);assert.equal(failed.counts().signatures,0);}finally{failed.cleanup();}
});
test('policy blueprints deny native transfers, expire at the provider and GET-only checks reject missing or broader delegation',async()=>{
  const f=await fixture();try{
    for(const role of ['buyer','seller'] as const){const policy=backgroundActorPolicy(f.scope,role);assert.ok(policy.rules.every(r=>r.action==='ALLOW'&&r.conditions.some(c=>(c as {field_source?:string}).field_source==='system')));
      for(const rule of policy.rules)for(const input of rule.conditions){const c=input as {field_source?:string;field?:string;abi?:{type:string;name:string;inputs:{name:string}[]}[]};if(c.field_source==='ethereum_calldata'&&c.field!=='function_name'){const [name,param]=c.field!.split('.');assert.ok(c.abi?.some(f=>f.type==='function'&&f.name===name&&f.inputs.some(v=>v.name===param)),'policy argument must resolve to a real ABI function and argument');}}
      for(const rule of policy.rules.filter(r=>r.method==='eth_sendTransaction'))assert.ok(rule.conditions.some(c=>JSON.stringify(c).includes('"field":"value","operator":"eq","value":"0"')));
      const authority={role,walletId:`wallet-${role}`,signerId:`signer-${role}`,policyId:`policy-${role}`};
      const wallet={id:authority.walletId,address:f.scope[role],chain_type:'ethereum',archived_at:null,additional_signers:[{signer_id:authority.signerId,override_policy_ids:[authority.policyId]}]};
      const port={wallet:async()=>wallet,policy:async()=>({id:authority.policyId,...policy})};
      const inspected=await inspectBackgroundAuthority(f.scope,authority,port,1000n);assert.equal(inspected.canExecute,false);assert.equal(inspected.keyPossessionVerified,false);
      await assert.rejects(inspectBackgroundAuthority(f.scope,authority,{...port,wallet:async()=>({...wallet,additional_signers:[]})},1000n),/DELEGATION_REQUIRED/);
      await assert.rejects(inspectBackgroundAuthority(f.scope,authority,{...port,policy:async()=>({id:authority.policyId,...policy,rules:[...policy.rules,{method:'*',action:'ALLOW',conditions:[]}]})},1000n),/POLICY_MISMATCH/);
    }
  }finally{f.cleanup();}
});
test('server actor signs only the scoped original Grant, verifies actual signatures and never asks for email or a device',async()=>{
  const f=await fixture(),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),privateKey='wallet-auth:'+pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64');
  const config={role:'buyer' as const,walletId:'local-buyer',signerId:'local-signer',policyId:'local-policy',subject:'did:privy:local-buyer',authorizationPrivateKey:privateKey},policy=backgroundActorPolicy(f.scope,'buyer');
  let signs=0,wrong=false,broaderQuorum=false;
  const wallet={id:config.walletId,address:f.scope.buyer,owner_id:config.subject,chain_type:'ethereum',archived_at:null,additional_signers:[{signer_id:config.signerId,override_policy_ids:[config.policyId]}]};
  const client={wallets:()=>({get:async()=>wallet,ethereum:()=>({signTypedData:async(_id:string,request:{params:{typed_data:unknown}})=>{signs++;const t=request.params.typed_data as {domain:unknown;types:unknown;primary_type:string;message:unknown};return {signature:await (wrong?f.seller:f.buyer).signTypedData({domain:t.domain,types:t.types,primaryType:t.primary_type,message:t.message} as never)};}})}),policies:()=>({get:async()=>({id:config.policyId,...policy})}),keyQuorums:()=>({get:async()=>({authorization_threshold:1,authorization_keys:[{public_key:publicKey}],user_ids:broaderQuorum?['unapproved-user']:[],key_quorum_ids:[]})})} as unknown as PrivyClient;
  let originalResponse:unknown;
  const {ownerSignature:_old,...unsigned}=f.payload,port=createBackgroundActor(client,f.scope,config,()=>unsigned,async()=>'local-opaque-token',f.clock,async original=>{originalResponse=original;});
  try{
    await port.initialize();await assert.rejects(port.sendCode('user@example.invalid'),/EMAIL_NOT_USED/);await assert.rejects(port.login('user@example.invalid','123456'),/EMAIL_NOT_USED/);
    await assert.rejects(port.signGrant!({...unsigned.grant,amount:'11'}),/GRANT_CHANGED/);assert.equal(signs,0);
    const result=await port.signGrant!(unsigned.grant);assert.match(result,/^0x[a-f0-9]{130}$/i);assert.equal(signs,1);assert.deepEqual(originalResponse,f.payload);
    broaderQuorum=true;await assert.rejects(port.signGrant!(unsigned.grant),/SIGNER_KEY_MISMATCH/);assert.equal(signs,1);broaderQuorum=false;
    wrong=true;await assert.rejects(port.signGrant!(unsigned.grant),/SIGNATURE_OUTCOME_UNKNOWN/);assert.equal(signs,2);
    await port.logout();await assert.rejects(port.token(),/SESSION_CHANGED/);
  }finally{await port.logout();f.cleanup();}
});
