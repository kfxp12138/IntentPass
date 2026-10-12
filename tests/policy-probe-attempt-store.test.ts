import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,statSync,writeFileSync,chmodSync,symlinkSync,mkdirSync,existsSync,linkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {encodeFunctionData,type Hex} from 'viem';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';
import {Day4PolicyProbeAttemptSchema,day4PolicyProbeKey,type Day4PolicyProbeCall} from '../packages/protocol/src/day4-policy-probe-types.js';
import {PolicyProbeAttemptStore} from '../packages/storage/src/policy-probe-attempt-store.js';

// Synthetic original-order metadata and response bytes only; no provider calls.
const h=(value:number)=>`0x${value.toString(16).padStart(64,'0')}` as Hex;
const a=(value:number)=>`0x${value.toString(16).padStart(40,'0')}`;
function call():Day4PolicyProbeCall{
  const orderId=h(1);return {chainId:'10143',walletId:'synthetic-wallet',policyId:'synthetic-policy',signerId:'synthetic-signer',executor:a(1),arbiter:a(2),orderId,contextHash:h(3),
    block:{number:'100',hash:h(100),timestamp:'200'},data:encodeFunctionData({abi:escrowAbi,functionName:'orders',args:[orderId]}),value:'0',gas:'5000000'};
}
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(realpathSync('/private/tmp'),'intentpass-policy-probe-test-')),path=join(directory,'capture.db'),stores:PolicyProbeAttemptStore[]=[];
  t.after(()=>{for(const store of stores)store.close();rmSync(directory,{recursive:true,force:true});});
  const open=()=>{const store=new PolicyProbeAttemptStore(path);stores.push(store);return store;};return {directory,path,open};
}
async function compete(path:string,input:Day4PolicyProbeCall){
  const moduleUrl=new URL('../packages/storage/src/policy-probe-attempt-store.ts',import.meta.url).href;
  const code=`import {readFileSync} from 'node:fs';import {PolicyProbeAttemptStore} from ${JSON.stringify(moduleUrl)};
    const {path,call}=JSON.parse(readFileSync(0,'utf8'));let store;
    try{store=new PolicyProbeAttemptStore(path);const record=store.reserve(call);process.stdout.write(JSON.stringify({created:true,record}));}
    catch(error){process.stdout.write(JSON.stringify({created:false,code:error.message}));}finally{store?.close();}`;
  const child=spawn(process.execPath,['--experimental-sqlite','--import',import.meta.resolve('tsx'),'--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdin.end(JSON.stringify({path,call:input}));
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  try{return await new Promise<{created:boolean;code?:string;record?:{attemptId:string}}>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>{if(code!==0||signal)return no(new Error('LOCAL_CAPTURE_WORKER_FAILED '+stderr));try{yes(JSON.parse(stdout));}catch(error){no(error);}});});}finally{clearTimeout(timer);}
}

test('durable private reserve binds the fixed original call and exposes only the frozen public schema',t=>{
  const f=fixture(t),store=f.open(),input=call(),key=day4PolicyProbeKey(input);assert.equal(store.get(key),null);
  const record=store.reserve(input);assert.equal(record.key,key);assert.deepEqual(record.call,input);assert.equal(record.status,'RESERVED');assert.equal(record.rawResponseStored,false);assert.equal(record.httpStatus,null);assert.equal(record.transactionHash,null);assert.equal(record.transactionHashStored,false);assert.equal(Day4PolicyProbeAttemptSchema.safeParse(record).success,true);
  for(const path of [f.path,f.path+'-wal',f.path+'-shm'].filter(existsSync))assert.equal(statSync(path).mode&0o777,0o600);
  input.policyId='mutated-input';record.call.policyId='mutated-result';assert.equal(store.get(key)!.call.policyId,'synthetic-policy');
  store.close();assert.equal(f.open().get(key)!.attemptId,record.attemptId);
});
test('policy signer executor height context and address case cannot open the same wallet/order slot',t=>{
  const f=fixture(t),store=f.open(),input=call(),record=store.reserve(input);
  const changes=[{policyId:'another-policy'},{signerId:'another-signer'},{executor:a(10)},{contextHash:h(10)},{block:{number:'101',hash:h(101),timestamp:'201'}},{arbiter:'0x'+input.arbiter.slice(2).toUpperCase(),orderId:'0x'+input.orderId.slice(2).toUpperCase(),data:input.data.toUpperCase().replace('0X','0x')}];
  for(const change of changes){const next={...input,...change};assert.equal(day4PolicyProbeKey(next),record.key);assert.throws(()=>store.reserve(next),/POLICY_PROBE_ATTEMPT_EXISTS/);}
  assert.ok(store.reserve({...input,walletId:'another-wallet'}));
});
test('unknown result permanently preserves the reservation after process restart',t=>{
  const f=fixture(t),store=f.open(),input=call(),r=store.reserve(input),unknown=store.markUnknown(r.key,r.attemptId);
  assert.equal(unknown.status,'OUTCOME_UNKNOWN');assert.deepEqual(store.markUnknown(r.key,r.attemptId),unknown);store.close();const restarted=f.open();assert.deepEqual(restarted.get(r.key),unknown);assert.throws(()=>restarted.reserve({...input,policyId:'later-policy'}),/ATTEMPT_EXISTS/);
});
test('raw response and original response headers remain private bounded bytes with no body interpretation',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call()),body=Buffer.from([0,255,123,34,65]),headers=[['Content-Type','application/octet-stream'],['X-Trace','SYNTHETIC_PRIVATE_RESPONSE_VALUE']] as const;
  const captured=store.recordResponse(r.key,r.attemptId,403,body,headers);assert.equal(captured.status,'HTTP_CAPTURED');assert.equal(captured.rawResponseStored,true);assert.equal(captured.httpStatus,403);assert.equal(captured.transactionHash,null);
  const db=new DatabaseSync(f.path);try{const raw=db.prepare('SELECT body,headers FROM policy_probe_responses').get()!;assert.deepEqual(Buffer.from(raw.body as Uint8Array),body);assert.deepEqual(JSON.parse(String(raw.headers)),headers);}finally{db.close();}
  body.fill(42);const exposed=store.get(r.key)!;assert.equal(JSON.stringify(exposed).includes('SYNTHETIC_PRIVATE_RESPONSE_VALUE'),false);assert.deepEqual(Object.keys(exposed).sort(),['key','attemptId','call','createdAt','updatedAt','status','httpStatus','rawResponseStored','transactionHash','transactionHashStored'].sort());
});
test('identical response is idempotent while every changed response field is permanently rejected',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call()),body=Buffer.from('SYNTHETIC_ORIGINAL_HTTP_BODY'),headers=[['x-trace','original']] as const;
  const captured=store.recordResponse(r.key,r.attemptId,400,body,headers);assert.deepEqual(store.recordResponse(r.key,r.attemptId,400,body,headers),captured);
  for(const [status,bytes,pairs] of [[401,body,headers],[400,Buffer.from('different'),headers],[400,body,[['x-trace','changed']]]] as const)assert.throws(()=>store.recordResponse(r.key,r.attemptId,status,bytes,pairs),/RESPONSE_CONFLICT/);
  const unknown=store.markUnknown(r.key,r.attemptId);assert.equal(unknown.rawResponseStored,true);assert.equal(unknown.httpStatus,400);assert.deepEqual(store.recordResponse(r.key,r.attemptId,400,body,headers),unknown);
  store.close();assert.deepEqual(f.open().get(r.key),unknown);
});
test('empty and exact-limit responses work, oversized or malformed response input never writes',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call());
  const invalid:Array<[number,Uint8Array,readonly (readonly [string,string])[]]>=[[99,Buffer.alloc(0),[]],[600,Buffer.alloc(0),[]],[200,Buffer.alloc(65537),[]],[200,Buffer.alloc(0),[['bad name','x']]],[200,Buffer.alloc(0),[['x','line\r\nbreak']]],[200,Buffer.alloc(0),[['x','x'.repeat(8192)]]]];
  for(const [status,body,headers] of invalid){assert.throws(()=>store.recordResponse(r.key,r.attemptId,status,body,headers),/RESPONSE_INVALID/);assert.deepEqual(store.get(r.key),r);}
  const captured=store.recordResponse(r.key,r.attemptId,200,Buffer.alloc(65536),[['x','x'.repeat(8182)]]);assert.equal(captured.rawResponseStored,true);
  const next=store.reserve({...call(),walletId:'empty-wallet'});assert.equal(store.recordResponse(next.key,next.attemptId,204,Buffer.alloc(0),[]).httpStatus,204);
});
test('a real unexpected hash can be persisted before any response or after unknown capture failure',t=>{
  const f=fixture(t),store=f.open();
  for(const state of ['RESERVED','OUTCOME_UNKNOWN'] as const){const r=store.reserve({...call(),walletId:state});if(state==='OUTCOME_UNKNOWN')store.markUnknown(r.key,r.attemptId);
    assert.throws(()=>store.recordResponse(r.key,r.attemptId,200,Buffer.alloc(65537),[]),/RESPONSE_INVALID/);
    const observed=store.recordUnexpectedHash(r.key,r.attemptId,h(9));assert.equal(observed.status,'UNEXPECTED_BROADCAST');assert.equal(observed.transactionHash,h(9));assert.equal(observed.transactionHashStored,true);assert.equal(observed.rawResponseStored,false);assert.equal(observed.httpStatus,null);
    assert.deepEqual(store.markUnknown(r.key,r.attemptId),observed);assert.deepEqual(store.recordUnexpectedHash(r.key,r.attemptId,h(9)),observed);assert.throws(()=>store.recordUnexpectedHash(r.key,r.attemptId,h(10)),/HASH_CONFLICT/);
    const late=store.recordResponse(r.key,r.attemptId,200,Buffer.from('late original response'),[]);assert.equal(late.status,'UNEXPECTED_BROADCAST');assert.equal(late.transactionHash,h(9));assert.equal(late.transactionHashStored,true);assert.equal(late.rawResponseStored,true);
  }
});
test('captured response then unexpected hash stays original across close restart and unknown updates',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call()),body=Buffer.from('original captured bytes');store.recordResponse(r.key,r.attemptId,200,body,[]);
  const hash=store.recordUnexpectedHash(r.key,r.attemptId,h(11));assert.equal(hash.httpStatus,200);assert.equal(hash.rawResponseStored,true);store.close();const restarted=f.open();assert.deepEqual(restarted.get(r.key),hash);assert.deepEqual(restarted.markUnknown(r.key,r.attemptId),hash);assert.deepEqual(restarted.recordResponse(r.key,r.attemptId,200,body,[]),hash);assert.throws(()=>restarted.reserve(call()),/ATTEMPT_EXISTS/);
});
test('wrong attempt unknown key and malformed metadata cannot modify or unlock the original slot',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call());
  for(const operation of [()=>store.markUnknown(r.key,randomUUID()),()=>store.recordResponse(r.key,randomUUID(),400,Buffer.from('not stored'),[]),()=>store.recordUnexpectedHash(r.key,randomUUID(),h(2))])assert.throws(operation,/ATTEMPT_CONFLICT/);
  assert.throws(()=>store.markUnknown(h(99),r.attemptId),/ATTEMPT_REQUIRED/);assert.throws(()=>store.recordUnexpectedHash(r.key,r.attemptId,'invalid'),/METADATA_INVALID/);
  for(const input of [{...call(),extra:'request-header-must-not-be-stored'},{...call(),[Symbol('extra')]:true},{...call(),value:'1'},{...call(),gas:'1'},{...call(),data:'0x1234'},null,Object.assign(Object.create({inherited:true}),call())])assert.throws(()=>store.reserve(input as Day4PolicyProbeCall),/METADATA_INVALID/);
  assert.deepEqual(store.get(r.key),r);store.close();store.close();assert.throws(()=>store.get(r.key),/JOURNAL_CLOSED/);assert.throws(()=>store.reserve(call()),/JOURNAL_CLOSED/);
});
test('independent processes reserve a wallet/order only once despite changed policy signer or height',async t=>{
  const f=fixture(t),store=f.open(),input=call(),reports=await Promise.all(Array.from({length:4},(_,i)=>compete(f.path,{...input,policyId:'policy-'+i,signerId:'signer-'+i,block:{number:String(100+i),hash:h(100+i),timestamp:String(200+i)}})));
  assert.equal(reports.filter(row=>row.created).length,1);assert.ok(reports.filter(row=>!row.created).every(row=>row.code==='POLICY_PROBE_ATTEMPT_EXISTS'));assert.equal(store.get(day4PolicyProbeKey(input))!.attemptId,reports.find(row=>row.created)!.record!.attemptId);
});
test('independent fresh constructors initialize one separate journal and reserve once',async t=>{
  const f=fixture(t),reports=await Promise.all(Array.from({length:4},()=>compete(f.path,call())));
  assert.equal(reports.filter(row=>row.created).length,1);assert.ok(reports.filter(row=>!row.created).every(row=>row.code==='POLICY_PROBE_ATTEMPT_EXISTS'),JSON.stringify(reports));
  assert.equal(f.open().get(day4PolicyProbeKey(call()))!.attemptId,reports.find(row=>row.created)!.record!.attemptId);
});
test('fresh inspection stays in one read snapshot when another process commits initialization between metadata queries',t=>{
  const f=fixture(t);writeFileSync(f.path,'',{mode:0o600});const seed=new DatabaseSync(f.path);seed.exec('PRAGMA journal_mode=WAL;');
  const originalPrepare=DatabaseSync.prototype.prepare,moduleUrl=new URL('../packages/storage/src/policy-probe-attempt-store.ts',import.meta.url).href;
  let interleaved=false,createdAttempt:string|undefined;
  const code=`import {readFileSync} from 'node:fs';import {PolicyProbeAttemptStore} from ${JSON.stringify(moduleUrl)};
    const {path,call}=JSON.parse(readFileSync(0,'utf8'));const store=new PolicyProbeAttemptStore(path);
    try{process.stdout.write(JSON.stringify(store.reserve(call)));}finally{store.close();}`;
  DatabaseSync.prototype.prepare=function(sql){
    const statement=originalPrepare.call(this,sql);
    if(!interleaved&&sql==="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"){
      const all=statement.all.bind(statement);
      statement.all=()=>{
        const rows=all();assert.equal(rows.length,0);interleaved=true;
        const child=spawnSync(process.execPath,['--experimental-sqlite','--import',import.meta.resolve('tsx'),'--input-type=module','-e',code],
          {encoding:'utf8',input:JSON.stringify({path:f.path,call:call()}),timeout:20000});
        assert.equal(child.status,0,child.stderr);createdAttempt=JSON.parse(child.stdout).attemptId;return rows;
      };
    }
    return statement;
  };
  try{
    const store=f.open();assert.equal(interleaved,true);assert.equal(store.get(day4PolicyProbeKey(call()))!.attemptId,createdAttempt);
    assert.throws(()=>store.reserve(call()),/POLICY_PROBE_ATTEMPT_EXISTS/);
  }finally{DatabaseSync.prototype.prepare=originalPrepare;seed.close();}
});
test('temporary WAL conversion contention retries only the local SQLite busy and restores the original timeout',t=>{
  const f=fixture(t);writeFileSync(f.path,'',{mode:0o600});const locker=new DatabaseSync(f.path);
  locker.exec('BEGIN;');locker.prepare('SELECT name FROM sqlite_master').all();
  const originalExec=DatabaseSync.prototype.exec;let attempts=0,restoredTimeout:number|undefined,observed:{code?:string;errcode?:number}|undefined;
  DatabaseSync.prototype.exec=function(sql){
    if(sql==='PRAGMA journal_mode=WAL;'&&++attempts===1){
      try{return originalExec.call(this,sql);}catch(error){
        observed=error as typeof observed;originalExec.call(locker,'COMMIT;');throw error;
      }
    }
    const result=originalExec.call(this,sql);if(sql==='PRAGMA busy_timeout=5000;')restoredTimeout=Number(this.prepare('PRAGMA busy_timeout').get()!.timeout);return result;
  };
  try{
    const store=f.open();assert.equal(observed?.code,'ERR_SQLITE_ERROR');assert.equal(observed?.errcode,5);assert.equal(attempts,2);assert.equal(restoredTimeout,5000);
    const inspected=new DatabaseSync(f.path);try{assert.equal(inspected.prepare('PRAGMA journal_mode').get()!.journal_mode,'wal');}finally{inspected.close();}
    const record=store.reserve(call());assert.equal(store.get(record.key)!.attemptId,record.attemptId);assert.throws(()=>store.reserve(call()),/ATTEMPT_EXISTS/);
  }finally{DatabaseSync.prototype.exec=originalExec;locker.close();}
});
test('non-busy WAL errors are never retried and repeated busy cannot outlive the fixed conversion deadline',t=>{
  const f=fixture(t),originalExec=DatabaseSync.prototype.exec;
  for(const code of [26,5]){
    let attempts=0,restored=false,clockCalls=0;
    const clock=code===5?t.mock.method(performance,'now',()=>clockCalls++===0?0:5001):undefined;
    DatabaseSync.prototype.exec=function(sql){
      if(sql==='PRAGMA journal_mode=WAL;'){attempts++;throw Object.assign(new Error('SYNTHETIC_SQLITE_FAILURE'),{code:'ERR_SQLITE_ERROR',errcode:code});}
      if(sql==='PRAGMA busy_timeout=5000;')restored=true;
      return originalExec.call(this,sql);
    };
    try{assert.throws(()=>new PolicyProbeAttemptStore(join(f.directory,'rejected-'+code+'.db')),/CONFIGURATION_INVALID/);assert.equal(attempts,1);assert.equal(restored,true);}
    finally{DatabaseSync.prototype.exec=originalExec;clock?.mock.restore();}
  }
});
test('private configuration rejects repository paths aliases any symlink parent and unsafe DB or sidecars',t=>{
  const f=fixture(t),repo=resolve('.');
  for(const path of ['relative.db',join(f.directory,'not-json.txt'),join(repo,'probe-private.db'),join(repo,'../intentpass/probe-private.db'),join(f.directory,'absent','probe.db')])assert.throws(()=>new PolicyProbeAttemptStore(path),/CONFIGURATION_INVALID/);
  for(const path of [f.directory+'/./capture.db',f.directory+'//capture.db',f.directory+'/../'+f.directory.split('/').at(-1)+'/capture.db','/tmp/'+f.directory.split('/').at(-1)+'/capture.db'])assert.throws(()=>new PolicyProbeAttemptStore(path),/CONFIGURATION_INVALID/);
  assert.equal(existsSync(join(repo,'probe-private.db')),false);
  const publicPath=join(f.directory,'public.db');writeFileSync(publicPath,'',{mode:0o644});assert.throws(()=>new PolicyProbeAttemptStore(publicPath),/CONFIGURATION_INVALID/);
  const link=join(f.directory,'linked.db');symlinkSync(publicPath,link);assert.throws(()=>new PolicyProbeAttemptStore(link),/CONFIGURATION_INVALID/);
  const privateDirectory=join(f.directory,'actual');mkdirSync(privateDirectory);const parent=join(f.directory,'alias');symlinkSync(privateDirectory,parent);assert.throws(()=>new PolicyProbeAttemptStore(join(parent,'capture.db')),/CONFIGURATION_INVALID/);assert.equal(existsSync(join(privateDirectory,'capture.db')),false);
  const repository=join(f.directory,'other-repo');mkdirSync(repository);mkdirSync(join(repository,'.git'));assert.throws(()=>new PolicyProbeAttemptStore(join(repository,'capture.db')),/CONFIGURATION_INVALID/);
  for(const suffix of ['-wal','-shm']){const path=join(f.directory,`sidecar-${suffix}.db`);writeFileSync(path,'',{mode:0o600});symlinkSync(join(f.directory,'missing-private-target'),path+suffix);assert.throws(()=>new PolicyProbeAttemptStore(path),/CONFIGURATION_INVALID/);}
  const hard=join(f.directory,'hard.db');chmodSync(publicPath,0o600);linkSync(publicPath,hard);assert.throws(()=>new PolicyProbeAttemptStore(hard),/CONFIGURATION_INVALID/);
});
test('another owner or unsafe existing sidecars are rejected before any attempt read',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call()),originalGetuid=process.getuid;
  try{if(originalGetuid){process.getuid=()=>originalGetuid()+1;assert.throws(()=>store.get(r.key),/CONFIGURATION_INVALID/);assert.throws(()=>new PolicyProbeAttemptStore(f.path),/CONFIGURATION_INVALID/);}}
  finally{process.getuid=originalGetuid;}
  const wal=f.path+'-wal';chmodSync(wal,0o644);assert.throws(()=>store.markUnknown(r.key,r.attemptId),/CONFIGURATION_INVALID/);chmodSync(wal,0o600);assert.equal(store.get(r.key)!.status,'RESERVED');
});
test('private identity or permissions drift and unrelated or malformed SQLite fail closed',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call());chmodSync(f.path,0o644);assert.throws(()=>store.get(r.key),/CONFIGURATION_INVALID/);chmodSync(f.path,0o600);
  assert.equal(store.get(r.key)!.status,'RESERVED');
  const unrelated=join(f.directory,'other-journal.db'),db=new DatabaseSync(unrelated);db.exec('CREATE TABLE unrelated (x TEXT)');db.close();chmodSync(unrelated,0o600);assert.throws(()=>new PolicyProbeAttemptStore(unrelated),/CONFIGURATION_INVALID/);
  const unchanged=new DatabaseSync(unrelated);try{
    assert.equal(unchanged.prepare('PRAGMA journal_mode').get()!.journal_mode,'delete');
    assert.equal(unchanged.prepare('PRAGMA application_id').get()!.application_id,0);assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version,0);
    assert.deepEqual(unchanged.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name),['unrelated']);
  }finally{unchanged.close();}
  const malformed=join(f.directory,'malformed.db');writeFileSync(malformed,'not a SQLite journal',{mode:0o600});assert.throws(()=>new PolicyProbeAttemptStore(malformed),/CONFIGURATION_INVALID/);
});
test('tampered private response bytes status headers or public binding cannot overwrite or reopen a slot',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call()),body=Buffer.from('untampered original body');store.recordResponse(r.key,r.attemptId,403,body,[['x-trace','original']]);const original=store.get(r.key)!;
  const db=new DatabaseSync(f.path);try{
    for(const patch of [{rawResponseStored:false},{call:{...original.call,policyId:'tampered-policy'}},{attemptId:randomUUID()},{transactionHash:h(9),transactionHashStored:true,status:'UNEXPECTED_BROADCAST'},{untrustedRaw:'must never be exposed'}]){
      db.prepare('UPDATE policy_probe_attempts SET record_json=? WHERE key=?').run(JSON.stringify({...original,...patch}),r.key);assert.throws(()=>store.get(r.key),/RECORD_INVALID/);assert.throws(()=>store.reserve(call()),/RECORD_INVALID/);db.prepare('UPDATE policy_probe_attempts SET record_json=? WHERE key=?').run(JSON.stringify(original),r.key);
    }
    for(const sql of ["UPDATE policy_probe_responses SET body=x'00'","UPDATE policy_probe_responses SET headers='[]'","UPDATE policy_probe_responses SET http_status=200"]){
      db.exec(sql);assert.throws(()=>store.get(r.key),/RECORD_INVALID/);assert.throws(()=>store.recordResponse(r.key,r.attemptId,403,body,[['x-trace','original']]),/RECORD_INVALID/);db.prepare('UPDATE policy_probe_responses SET body=?,headers=?,http_status=403').run(body,JSON.stringify([['x-trace','original']]));
    }
    assert.deepEqual(store.get(r.key),original);db.exec('PRAGMA user_version=2');assert.throws(()=>store.get(r.key),/RECORD_INVALID/);assert.throws(()=>store.reserve(call()),/RECORD_INVALID/);
  }finally{db.close();}
});
test('failed metadata writes roll back response or hash inserts while leaving the durable slot locked',t=>{
  const f=fixture(t),store=f.open(),r=store.reserve(call()),db=new DatabaseSync(f.path);
  try{
    db.exec("CREATE TRIGGER reject_public_update BEFORE UPDATE ON policy_probe_attempts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_LOCAL_WRITE_FAILURE'); END;");
    assert.throws(()=>store.recordResponse(r.key,r.attemptId,403,Buffer.from('original body'),[]),/^Error: POLICY_PROBE_JOURNAL_WRITE_FAILED$/);
    assert.throws(()=>store.recordUnexpectedHash(r.key,r.attemptId,h(21)),/^Error: POLICY_PROBE_JOURNAL_WRITE_FAILED$/);
    assert.deepEqual(store.get(r.key),r);assert.equal(db.prepare('SELECT count(*) AS n FROM policy_probe_responses').get()!.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM policy_probe_hashes').get()!.n,0);assert.throws(()=>store.reserve(call()),/ATTEMPT_EXISTS/);
    db.exec('DROP TRIGGER reject_public_update');const hash=store.recordUnexpectedHash(r.key,r.attemptId,h(21));assert.equal(hash.transactionHashStored,true);assert.equal(hash.transactionHash,h(21));
    const captured=store.recordResponse(r.key,r.attemptId,403,Buffer.from('original body'),[]);assert.equal(captured.status,'UNEXPECTED_BROADCAST');assert.equal(captured.rawResponseStored,true);
  }finally{db.close();}
});
test('deleted public attempt metadata cannot conceal the original private response or hash and reopen the slot',t=>{
  const f=fixture(t),store=f.open(),db=new DatabaseSync(f.path);
  try{
    for(const kind of ['response','hash'] as const){
      const input={...call(),walletId:'deleted-'+kind},r=store.reserve(input);
      if(kind==='response')store.recordResponse(r.key,r.attemptId,403,Buffer.from('original preserved body'),[]);
      else store.recordUnexpectedHash(r.key,r.attemptId,h(22));
      db.prepare('DELETE FROM policy_probe_attempts WHERE key=?').run(r.key);
      assert.throws(()=>store.get(r.key),/RECORD_INVALID/);
      assert.throws(()=>store.reserve({...input,policyId:'changed-after-tamper'}),/RECORD_INVALID/);
    }
  }finally{db.close();}
});
