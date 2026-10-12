import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync,chmodSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DeploymentAttemptStore,DeploymentAttemptInputSchema,type DeploymentAttemptInput} from '../packages/storage/src/deployment-attempt-store.js';

const hash=(value:number)=>'0x'+value.toString(16).padStart(64,'0');
const address=(value:number)=>'0x'+value.toString(16).padStart(40,'0');
function input():DeploymentAttemptInput{return {planId:hash(1),sourceCommit:'a'.repeat(40),chainId:'10143',deployer:address(15),initCodeHash:hash(2),nonce:'0x0',gas:'0x100000',maxFeePerGas:'0x100',maxPriorityFeePerGas:'0x10'};}
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'intentpass-deployment-journal-')),path=join(directory,'deployment.db'),stores:DeploymentAttemptStore[]=[];
  t.after(()=>{for(const store of stores)store.close();rmSync(directory,{recursive:true,force:true});});
  const open=()=>{const store=new DeploymentAttemptStore(path);stores.push(store);return store;};
  return {directory,path,open};
}
async function compete(path:string,metadata:DeploymentAttemptInput){
  const moduleUrl=new URL('../packages/storage/src/deployment-attempt-store.ts',import.meta.url).href;
  const code=`import {readFileSync} from 'node:fs';
    import {DeploymentAttemptStore} from ${JSON.stringify(moduleUrl)};
    const {path,input}=JSON.parse(readFileSync(0,'utf8'));
    const store=new DeploymentAttemptStore(path);
    try{const record=store.reserve(input);process.stdout.write(JSON.stringify({created:true,record}));}
    catch(error){process.stdout.write(JSON.stringify({created:false,code:error.message}));}
    finally{store.close();}`;
  const child=spawn(process.execPath,['--experimental-sqlite','--import','tsx','--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdin.end(JSON.stringify({path,input:metadata}));
  const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
  try{return await new Promise<{created:boolean;code?:string;record?:Record<string,unknown>}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{if(code!==0||signal)return reject(new Error('LOCAL_DEPLOYMENT_WORKER_FAILED: '+stderr));try{resolve(JSON.parse(stdout));}catch(error){reject(error);}});});}finally{clearTimeout(timeout);}
}

test('private durable reservation records exact fixed metadata and survives unknown send restart without release',t=>{
  const f=fixture(t);let store=f.open();assert.equal(store.get(hash(1)),null);
  const metadata=input(),reserved=store.reserve(metadata);assert.equal(reserved.status,'RESERVED');assert.equal(reserved.transactionHash,null);assert.equal(reserved.contractAddress,null);assert.match(reserved.attemptId,/^[a-f0-9-]{36}$/);assert.equal(reserved.createdAt,reserved.updatedAt);
  for(const [key,value] of Object.entries(metadata))assert.equal(reserved[key as keyof typeof reserved],value);
  for(const path of [f.path,f.path+'-wal',f.path+'-shm'].filter(existsSync))assert.equal(statSync(path).mode&0o777,0o600);
  reserved.nonce='0x99';assert.equal(store.get(metadata.planId)?.nonce,'0x0');store.close();store=f.open();assert.equal(store.get(metadata.planId)?.status,'RESERVED');assert.equal(store.get(metadata.planId)?.attemptId,reserved.attemptId);
  assert.throws(()=>store.reserve(metadata),/DEPLOYMENT_ATTEMPT_EXISTS/);assert.throws(()=>store.reserve({...metadata,nonce:'0x1'}),/DEPLOYMENT_ATTEMPT_EXISTS/);
});
test('one reserved attempt binds one transaction hash and submitted restart cannot bind another hash',t=>{
  const f=fixture(t);let store=f.open();const reserved=store.reserve(input()),submitted=store.recordHash(reserved.planId,reserved.attemptId,hash(3));
  assert.equal(submitted.status,'SUBMITTED');assert.equal(submitted.transactionHash,hash(3));assert.equal(submitted.contractAddress,null);assert.deepEqual(store.recordHash(reserved.planId,reserved.attemptId,hash(3)),submitted);
  store.close();store=f.open();assert.deepEqual(store.get(reserved.planId),submitted);
  assert.throws(()=>store.recordHash(reserved.planId,reserved.attemptId,hash(4)),/DEPLOYMENT_RECORD_CONFLICT/);assert.throws(()=>store.recordHash(reserved.planId,randomUUID(),hash(3)),/DEPLOYMENT_RECORD_CONFLICT/);assert.deepEqual(store.get(reserved.planId),submitted);
});
test('confirmed and reverted states never reverse downgrade release nonce or change their original hash and address',t=>{
  const f=fixture(t);
  for(const state of ['CONFIRMED','REVERTED'] as const){let store=f.open();const metadata={...input(),planId:hash(state==='CONFIRMED'?10:11),nonce:state==='CONFIRMED'?'0xa':'0xb'},reserved=store.reserve(metadata);
    assert.throws(()=>store.markConfirmed(reserved.planId,reserved.attemptId,hash(3),address(3)),/DEPLOYMENT_RECORD_CONFLICT/);assert.throws(()=>store.markReverted(reserved.planId,reserved.attemptId,hash(3)),/DEPLOYMENT_RECORD_CONFLICT/);
    store.recordHash(reserved.planId,reserved.attemptId,hash(3));const terminal=state==='CONFIRMED'?store.markConfirmed(reserved.planId,reserved.attemptId,hash(3),address(3)):store.markReverted(reserved.planId,reserved.attemptId,hash(3));store.close();store=f.open();
    assert.deepEqual(store.get(reserved.planId),terminal);assert.deepEqual(store.recordHash(reserved.planId,reserved.attemptId,hash(3)),terminal);
    if(state==='CONFIRMED'){assert.deepEqual(store.markConfirmed(reserved.planId,reserved.attemptId,hash(3),address(3)),terminal);assert.throws(()=>store.markConfirmed(reserved.planId,reserved.attemptId,hash(3),address(4)),/DEPLOYMENT_RECORD_CONFLICT/);assert.throws(()=>store.markReverted(reserved.planId,reserved.attemptId,hash(3)),/DEPLOYMENT_RECORD_CONFLICT/);}
    else{assert.deepEqual(store.markReverted(reserved.planId,reserved.attemptId,hash(3)),terminal);assert.throws(()=>store.markConfirmed(reserved.planId,reserved.attemptId,hash(3),address(3)),/DEPLOYMENT_RECORD_CONFLICT/);}
    assert.throws(()=>store.markConfirmed(reserved.planId,reserved.attemptId,hash(4),address(3)),/DEPLOYMENT_RECORD_CONFLICT/);assert.throws(()=>store.markReverted(reserved.planId,reserved.attemptId,hash(4)),/DEPLOYMENT_RECORD_CONFLICT/);
    assert.throws(()=>store.reserve(metadata),/DEPLOYMENT_ATTEMPT_EXISTS/);assert.throws(()=>store.reserve({...metadata,planId:hash(state==='CONFIRMED'?12:13)}),/DEPLOYMENT_NONCE_ALREADY_RESERVED/);assert.deepEqual(store.get(reserved.planId),terminal);
  }
});
test('canonical address hash and commit comparisons prevent case changes bypassing plan or wallet nonce reservations',t=>{
  const f=fixture(t),store=f.open(),metadata={...input(),planId:hash(171),initCodeHash:hash(172),sourceCommit:'A'.repeat(40),deployer:'0x'+'A'.repeat(40)},record=store.reserve(metadata);
  assert.equal(record.sourceCommit,'a'.repeat(40));assert.equal(record.deployer,'0x'+'a'.repeat(40));assert.equal(store.get('0x'+metadata.planId.slice(2).toUpperCase())?.attemptId,record.attemptId);
  assert.throws(()=>store.reserve({...metadata,planId:'0x'+metadata.planId.slice(2).toUpperCase()}),/DEPLOYMENT_ATTEMPT_EXISTS/);assert.throws(()=>store.reserve({...metadata,planId:hash(173),deployer:record.deployer}),/DEPLOYMENT_NONCE_ALREADY_RESERVED/);
  store.recordHash(record.planId,record.attemptId,hash(174));assert.equal(store.recordHash(record.planId,record.attemptId,'0x'+hash(174).slice(2).toUpperCase()).transactionHash,hash(174));
  assert.ok(store.reserve({...metadata,planId:hash(175),nonce:'0x1'}));assert.ok(store.reserve({...metadata,planId:hash(176),deployer:address(2)}));
});
test('distinct SQLite processes competing for one plan can reserve exactly once',async t=>{
  const f=fixture(t),store=f.open(),metadata=input(),reports=await Promise.all(Array.from({length:5},()=>compete(f.path,metadata)));
  assert.equal(reports.filter(report=>report.created).length,1);assert.ok(reports.filter(report=>!report.created).every(report=>report.code==='DEPLOYMENT_ATTEMPT_EXISTS'));assert.equal(store.get(metadata.planId)?.status,'RESERVED');
  assert.equal(store.get(metadata.planId)?.attemptId,reports.find(report=>report.created)?.record?.attemptId);
});
test('distinct SQLite processes cannot reserve the same wallet nonce under different plans',async t=>{
  const f=fixture(t),store=f.open(),base=input(),metadata=Array.from({length:5},(_,index)=>({...base,planId:hash(20+index),deployer:index%2?'0x'+base.deployer.slice(2).toUpperCase():base.deployer}));
  const reports=await Promise.all(metadata.map(record=>compete(f.path,record)));assert.equal(reports.filter(report=>report.created).length,1);assert.ok(reports.filter(report=>!report.created).every(report=>report.code==='DEPLOYMENT_NONCE_ALREADY_RESERVED'));assert.equal(metadata.filter(record=>store.get(record.planId)!==null).length,1);
});
test('strict metadata rejects unknown keys missing fields invalid identities and noncanonical nonce or gas fees before reserving',t=>{
  const f=fixture(t),store=f.open(),base=input();
  const invalid:unknown[]=[{...base,extra:true},{...base,[Symbol('extra')]:true},{...base,status:'SUBMITTED'},{...base,chainId:'143'},{...base,deployer:address(0)},{...base,planId:'0x1234'},{...base,initCodeHash:'invalid'},{...base,sourceCommit:'a'.repeat(39)},null,[],Object.assign(Object.create({inherited:true}),base)];
  for(const nonce of ['0','1','0x','0x00','0x01','0xA','0X1','0x-1','0x1.0','0x'+'1'.repeat(65)]){invalid.push({...base,nonce});assert.equal(DeploymentAttemptInputSchema.safeParse({...base,nonce}).success,false);}
  for(const field of ['gas','maxFeePerGas','maxPriorityFeePerGas'] as const){for(const value of ['0x01','0xA','0x'+'1'.repeat(65)])invalid.push({...base,[field]:value});const missing={...base} as Partial<DeploymentAttemptInput>;delete missing[field];invalid.push(missing);}
  invalid.push({...base,gas:'0x0'},{...base,maxFeePerGas:'0x0'},{...base,maxPriorityFeePerGas:'0x101'});
  for(const value of invalid){assert.throws(()=>store.reserve(value as DeploymentAttemptInput),/DEPLOYMENT_METADATA_INVALID/);assert.equal(store.get(base.planId),null);}
  assert.ok(store.reserve({...base,maxPriorityFeePerGas:'0x0',nonce:'0x'+'f'.repeat(64)}));
});
test('failed updates and invalid update metadata preserve every previously reserved approved field',t=>{
  const f=fixture(t),store=f.open(),reserved=store.reserve(input());
  assert.throws(()=>store.recordHash(hash(99),reserved.attemptId,hash(3)),/DEPLOYMENT_ATTEMPT_REQUIRED/);
  for(const [planId,attemptId,transactionHash] of [['not a hash',reserved.attemptId,hash(3)],[reserved.planId,'not an attempt',hash(3)],[reserved.planId,reserved.attemptId,'not a hash']])assert.throws(()=>store.recordHash(planId,attemptId,transactionHash),/DEPLOYMENT_METADATA_INVALID/);
  assert.deepEqual(store.get(reserved.planId),reserved);store.recordHash(reserved.planId,reserved.attemptId,hash(3));const before=store.get(reserved.planId);
  assert.throws(()=>store.markConfirmed(reserved.planId,reserved.attemptId,hash(3),address(0)),/DEPLOYMENT_METADATA_INVALID/);assert.throws(()=>store.markConfirmed(reserved.planId,randomUUID(),hash(3),address(3)),/DEPLOYMENT_RECORD_CONFLICT/);assert.deepEqual(store.get(reserved.planId),before);
});
test('private journal configuration rejects relative non-db public directory and symlink files and unsafe sidecars',t=>{
  const f=fixture(t);assert.throws(()=>new DeploymentAttemptStore('relative.db'),/DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID/);assert.throws(()=>new DeploymentAttemptStore(join(f.directory,'metadata.json')),/DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID/);assert.throws(()=>new DeploymentAttemptStore(join(f.directory,'absent','metadata.db')),/DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID/);
  const publicDb=join(f.directory,'public.db');writeFileSync(publicDb,'');chmodSync(publicDb,0o644);assert.throws(()=>new DeploymentAttemptStore(publicDb),/DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID/);
  const link=join(f.directory,'linked.db');symlinkSync(publicDb,link);assert.throws(()=>new DeploymentAttemptStore(link),/DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID/);
  const existing=join(f.directory,'sidecar.db');writeFileSync(existing,'',{mode:0o600});symlinkSync(join(f.directory,'missing-private-target'),existing+'-wal');assert.throws(()=>new DeploymentAttemptStore(existing),/DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID/);assert.equal(existsSync(join(f.directory,'missing-private-target')),false);
  const publicSidecar=join(f.directory,'public-sidecar.db');writeFileSync(publicSidecar,'',{mode:0o600});writeFileSync(publicSidecar+'-wal','',{mode:0o644});assert.throws(()=>new DeploymentAttemptStore(publicSidecar),/DEPLOYMENT_ATTEMPT_CONFIGURATION_INVALID/);
});
test('corrupt or inconsistent stored records cannot be reset overwritten or release an occupied wallet nonce',t=>{
  const f=fixture(t),store=f.open(),reserved=store.reserve(input()),db=new DatabaseSync(f.path);
  const invalid=[{...reserved,extra:'not accepted'},{...reserved,status:'SUBMITTED'}, {...reserved,planId:hash(99)},{...reserved,nonce:'0x1'},{...reserved,maxPriorityFeePerGas:'0x101'}];
  try{for(const value of invalid){db.prepare('UPDATE deployment_attempts SET record_json=? WHERE plan_id=?').run(JSON.stringify(value),reserved.planId);assert.throws(()=>store.get(reserved.planId),/DEPLOYMENT_RECORD_INVALID/);assert.throws(()=>store.reserve(input()),/DEPLOYMENT_RECORD_INVALID/);assert.throws(()=>store.reserve({...input(),planId:hash(100)}),/DEPLOYMENT_NONCE_ALREADY_RESERVED/);}}finally{db.close();}
});
