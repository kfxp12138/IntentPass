import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {DemoChainFlowReportSchema,demoChainFlowObservation,readDemoChainFlowObservation,demoFlowConfigurationNames} from '../scripts/demo-chain-flow-observation.js';
import {inspectDay4ChainFlow} from '../packages/protocol/src/day4-chain-flow.js';
import {type ReleaseSourceSnapshot} from '../scripts/release-source.js';
import {day4OriginsFixture} from './support/day4-origins-fixture.js';
import {readTestAddress as address,readTestHash as hash} from './support/original-authorization.js';

/** Every source, account, signature, receipt and read attempt in these tests is
 * an explicit local synthetic double. No .env, RPC, provider, compiler, wallet,
 * actual deployment or real acceptance is used. Only the fixture's generic
 * flow port is executed; its historical creation and Privy ports are unused. */
const invocationId='8b0abf3d-7ce2-45c3-a3ea-3e558f41c8dc';
const anotherInvocation='87be9ce3-a65c-4f4d-a53a-4d76a15db712';
const startedAt='2026-10-03T10:00:10.000Z',endedAt='2026-10-03T10:00:20.000Z';
const sourceBytes=Buffer.from('LOCAL_SYNTHETIC_PUBLIC_SOURCE\n');
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const source:ReleaseSourceSnapshot={sourceCommit:'a'.repeat(40),bindings:[{path:'scripts/synthetic-demo-flow.ts',bytes:sourceBytes.length,sha256:digest(sourceBytes)}]};
type Input=Record<string,unknown>;
function expected(exitCode:number|null=1){return {invocationId,startedAt:'2026-10-03T10:00:00.000Z',endedAt:'2026-10-03T10:01:00.000Z',source:structuredClone(source),exitCode};}
function blocked():Input{return {schemaVersion:2,invocationId,assetMode:'demo-erc20',scope:'READ_ONLY_DEMO_ORIGINAL_CHAIN_FLOW_NOT_FULL_D4_ACCEPTANCE',
  startedAt,endedAt,source:structuredClone(source),sourceStable:true,worktreeDirty:true,status:'BLOCKED',reason:'DEMO_CHAIN_FLOW_CONFIGURATION_MISSING',
  missing:['ASSET_ADDRESS'],deployment:null,requestIdentity:null,inspection:null,publicRpcInspectionAttempted:false,privateInputReadAttempted:false,exitCode:1,
  financialAcceptanceStatus:'BLOCKED',canPassD4:false,canExecute:false,identityVerification:false,officialIntegrationVerified:false,
  privyOriginVerified:false,deploymentCreationVerified:false,signaturesRequested:0,transactionsSent:0,limits:['LOCAL_SYNTHETIC_CONFIGURED_EFFECTS_ONLY']};}
const verifiedTemplate=(async()=>{
  const fixture=await day4OriginsFixture(),proof=await inspectDay4ChainFlow(fixture.request.flow,fixture.config.flow,fixture.ports.flow);
  assert.equal(fixture.control.providerCalled,false,'The local fixture must not execute its Privy port');
  const record=DemoChainFlowReportSchema.parse({...blocked(),status:'CHAIN_FLOW_VERIFIED',reason:'DEMO_CONFIGURED_ORIGINAL_PAID_CHAIN_EFFECTS_VERIFIED',
    missing:[],deployment:fixture.config.flow,requestIdentity:{orderId:fixture.request.flow.payload.intent.orderId,
      contextHash:fixture.request.flow.payload.grant.contextHash,transactions:fixture.request.flow.transactions},inspection:proof,
    publicRpcInspectionAttempted:true,privateInputReadAttempted:true,exitCode:0});
  return record;
})();
async function verified():Promise<Input>{return structuredClone(await verifiedTemplate) as Input;}
function set(input:Input,path:readonly string[],value:unknown){let current=input;for(const part of path.slice(0,-1))current=current[part] as Input;current[path.at(-1)!]=value;}
function observation(input:unknown,exitCode:number|null=1){return demoChainFlowObservation(input,expected(exitCode));}

test('synthetic current missing demo asset is BLOCKED without reading inputs or requesting external work',()=>{
  const report=blocked();assert.equal(DemoChainFlowReportSchema.safeParse(report).success,true);
  assert.deepEqual(observation(report),{status:'BLOCKED',publicRpcInspectionAttempted:false,canPassD4:false});
  assert.ok(demoFlowConfigurationNames.includes('ASSET_ADDRESS'));
  assert.ok(!demoFlowConfigurationNames.some(name=>/CVA|CVI|VALIDATOR|POLICY/.test(name)));
  for(const missing of [[],['CVA_ADDRESS'],['PRIVY_APP_SECRET']])assert.equal(observation({...report,missing}).status,'FAIL');
  for(const patch of [{publicRpcInspectionAttempted:true},{privateInputReadAttempted:true},{deployment:{}},{requestIdentity:{}},{exitCode:0}])
    assert.equal(observation({...report,...patch}).status,'FAIL');
});

test('synthetic original paid flow is consumed only as read-only demo subevidence, never D4 acceptance',async()=>{
  const report=await verified(),proof=(report.inspection as Awaited<ReturnType<typeof inspectDay4ChainFlow>>);
  assert.deepEqual(observation(report,0),{status:'CHAIN_FLOW_VERIFIED',publicRpcInspectionAttempted:true,canPassD4:false});
  assert.equal(proof.scope,'FINALIZED_CONFIGURED_ORIGINAL_PAID_CHAIN_FLOW_NOT_OFFICIAL_OR_PROVIDER_PROVENANCE');
  assert.equal(proof.deploymentCreationVerified,false);assert.equal(proof.privyOriginVerified,false);assert.equal(proof.financialAcceptanceStatus,'BLOCKED');
  assert.equal(proof.finalOrder.state,'ALLOCATED_PAID');assert.equal(proof.transactions.funding.amount,'15');assert.equal(proof.transactions.withdrawal.amount,'10');
  assert.equal(proof.balanceObservations.funding.scope,'WHOLE_BLOCK_ENDPOINT_BALANCES_NOT_TRANSACTION_LEVEL_DELTAS');
});

const successfulMutations:[string,readonly string[],unknown][]=[
  ['legacy schema version',['schemaVersion'],1],
  ['legacy outer scope',['scope'],'READ_ONLY_ORIGINAL_CHAIN_FLOW_NOT_D4_EXTERNAL_ACCEPTANCE'],
  ['legacy mode',['assetMode'],'cleanverse'],
  ['legacy CVA configuration field',['CVA_ADDRESS'],address(999)],
  ['different invocation',['invocationId'],anotherInvocation],
  ['malformed invocation',['invocationId'],'not-a-uuid'],
  ['missing original flow proof',['inspection'],null],
  ['asserted proof without original effects',['inspection'],{status:'CHAIN_FLOW_VERIFIED'}],
  ['substituted asset',['deployment','asset'],address(999)],
  ['substituted escrow',['deployment','arbiter'],address(999)],
  ['substituted executor',['deployment','executor'],address(999)],
  ['different original order',['requestIdentity','orderId'],hash(999)],
  ['different original context',['requestIdentity','contextHash'],hash(999)],
  ['different funding hash',['requestIdentity','transactions','funding'],hash(991)],
  ['different allocation hash',['requestIdentity','transactions','allocation'],hash(992)],
  ['different withdrawal hash',['requestIdentity','transactions','withdrawal'],hash(993)],
  ['no deployment configuration',['deployment'],null],
  ['no original request identity',['requestIdentity'],null],
  ['asserted effect without RPC inspection',['publicRpcInspectionAttempted'],false],
  ['asserted effect without original private input',['privateInputReadAttempted'],false],
  ['successful effect with missing configuration',['missing'],['ASSET_ADDRESS']],
  ['nonzero successful inspector exit',['exitCode'],1],
  ['financial PASS promotion',['financialAcceptanceStatus'],'PASS'],
  ['D4 PASS capability',['canPassD4'],true],
  ['execution capability',['canExecute'],true],
  ['identity claim',['identityVerification'],true],
  ['official integration claim',['officialIntegrationVerified'],true],
  ['Privy origin claim',['privyOriginVerified'],true],
  ['deployment creation claim',['deploymentCreationVerified'],true],
  ['signature request',['signaturesRequested'],1],
  ['transaction send',['transactionsSent'],1],
  ['inner provider provenance claim',['inspection','privyOriginVerified'],true],
  ['inner invalid final ledger',['inspection','finalOrder','withdrawn','payee'],'9'],
  ['inner outstanding paid beneficiary credit',['inspection','finalOrder','credits','payee'],'1'],
  ['inner buyer allocation mismatch',['inspection','finalOrder','credits','buyer'],'4'],
  ['inner outstanding ledger smaller than order credits',['inspection','finalOrder','accounting','outstanding'],'4'],
  ['inner insolvent aggregate ledger',['inspection','finalOrder','accounting','balance'],'4'],
];
for(const [name,path,value] of successfulMutations)test(`synthetic observer rejects ${name}`,async()=>{
  const report=await verified();set(report,path,value);assert.equal(observation(report,0).status,'FAIL');
});

test('synthetic observer binds exact source HEAD, byte inventory and stable final capture',async()=>{
  const report=await verified();
  for(const [path,value] of [
    [['sourceStable'],false],[['source','sourceCommit'],'b'.repeat(40)],[['source','bindings'],[]],
    [['source','bindings'],[{...source.bindings[0],bytes:sourceBytes.length+1}]],
    [['source','bindings'],[{...source.bindings[0],sha256:'b'.repeat(64)}]],
    [['source','bindings'],[{...source.bindings[0],path:'scripts/another-public-source.ts'}]],
    [['source'],null],
  ] as [readonly string[],unknown][]){const changed=structuredClone(report);set(changed,path,value);assert.equal(observation(changed,0).status,'FAIL');}
  const after=expected(0);after.source.bindings[0].bytes++;assert.equal(demoChainFlowObservation(report,after).status,'FAIL');
  assert.equal(observation({...blocked(),sourceStable:false}).status,'FAIL');
});

test('synthetic observer rejects stale, future, reversed and malformed run times and actual exits',async()=>{
  const report=await verified();
  for(const patch of [{startedAt:'2026-10-03T09:59:59.999Z'},{endedAt:'2026-10-03T10:01:00.001Z'},
    {endedAt:'2026-10-03T10:00:09.999Z'},{startedAt:'INVALID'},{endedAt:'INVALID'}])assert.equal(observation({...report,...patch},0).status,'FAIL');
  for(const patch of [{startedAt:'INVALID'},{endedAt:'INVALID'},
    {startedAt:'2026-10-03T10:02:00.000Z',endedAt:'2026-10-03T10:01:00.000Z'},
    {invocationId:anotherInvocation},{exitCode:1},{exitCode:null}])assert.equal(demoChainFlowObservation(report,{...expected(0),...patch}).status,'FAIL');
  assert.equal(observation(blocked(),0).status,'FAIL');assert.equal(observation(blocked(),null).status,'FAIL');
  assert.equal(demoChainFlowObservation(report,{...expected(0),startedAt,endedAt}).status,'CHAIN_FLOW_VERIFIED');
});

test('synthetic genuine pending or unavailable reads remain BLOCKED and fixed failures remain FAIL',async()=>{
  const report=await verified();
  for(const reason of ['DEMO_CHAIN_FLOW_READ_UNAVAILABLE','DAY4_FLOW_READ_UNAVAILABLE','DAY4_FLOW_TRANSACTION_PENDING']){
    const unavailable={...report,status:'BLOCKED',reason,exitCode:1,inspection:null};
    assert.deepEqual(observation(unavailable),{status:'BLOCKED',publicRpcInspectionAttempted:true,canPassD4:false});
  }
  for(const reason of ['DAY4_FLOW_INPUT_INVALID','DAY4_FLOW_TRANSACTION_MISMATCH','DEMO_CHAIN_FLOW_SOURCE_CHANGED']){
    const failure={...report,status:'FAIL',reason,exitCode:1,inspection:null};
    assert.deepEqual(observation(failure),{status:'FAIL',publicRpcInspectionAttempted:true,canPassD4:false});
    assert.equal(observation({...failure,status:'BLOCKED'}).status,'FAIL');
  }
  assert.equal(observation({...report,status:'BLOCKED',reason:'DAY4_FLOW_TRANSACTION_PENDING',exitCode:1}).status,'FAIL');
});

function files(t:test.TestContext){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'intentpass-demo-flow-observer-synthetic-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=`artifacts/acceptance/demo-chain-flow/${invocationId}.json`,absolute=join(root,path);
  mkdirSync(dirname(absolute),{recursive:true});
  const save=(bytes:string|Buffer)=>{writeFileSync(absolute,bytes);return bytes;};
  return {root,path,absolute,save,read:()=>readDemoChainFlowObservation(root,invocationId)};
}

test('synthetic reader hashes the exact parent UUID bytes, including whitespace, rather than declared bindings',t=>{
  const f=files(t),bytes=Buffer.from(' \n'+JSON.stringify({...blocked(),evidence:'/untrusted/report-selected.json',sha256:'b'.repeat(64)})+'\n');
  f.save(bytes);const first=f.read();
  assert.deepEqual(first.binding,{path:f.path,bytes:bytes.length,sha256:digest(bytes)});
  assert.equal((first.record as Input).evidence,'/untrusted/report-selected.json');
  assert.equal(observation(first.record).status,'FAIL','Strict report interpretation must reject undeclared path and hash fields');
  const changed=Buffer.from(JSON.stringify(blocked())+'\n\n');f.save(changed);const second=f.read();
  assert.deepEqual(second.binding,{path:f.path,bytes:changed.length,sha256:digest(changed)});
  assert.notEqual(second.binding.sha256,first.binding.sha256);assert.equal(observation(second.record).status,'BLOCKED');
});

test('synthetic reader never chooses a record-supplied invocation or path and UUID parsing rejects traversal',t=>{
  const f=files(t);f.save(JSON.stringify({...blocked(),invocationId:anotherInvocation}));
  const read=f.read();assert.equal(read.binding.path,f.path);assert.equal(observation(read.record).status,'FAIL');
  for(const id of ['../../outside','../'+invocationId,invocationId+'/../../outside',invocationId+'.json','',invocationId+'\0'])
    assert.throws(()=>readDemoChainFlowObservation(f.root,id));
  assert.throws(()=>readDemoChainFlowObservation(f.root,anotherInvocation));
});

test('synthetic reader refuses symlink files, intermediate directories and noncanonical roots',t=>{
  const f=files(t),target=join(f.root,'synthetic-target.json');writeFileSync(target,JSON.stringify(blocked()));
  symlinkSync(target,f.absolute);assert.throws(f.read);unlinkSync(f.absolute);
  const folder=dirname(f.absolute),realFolder=join(f.root,'synthetic-target-folder');mkdirSync(realFolder);writeFileSync(join(realFolder,invocationId+'.json'),JSON.stringify(blocked()));
  rmSync(folder,{recursive:true});symlinkSync(realFolder,folder);assert.throws(f.read);unlinkSync(folder);mkdirSync(folder);f.save(JSON.stringify(blocked()));
  const rootLink=join(f.root,'synthetic-root-link');symlinkSync(f.root,rootLink);
  assert.throws(()=>readDemoChainFlowObservation(rootLink,invocationId));
});

test('synthetic reader enforces the one MiB raw-byte limit before interpretation',t=>{
  const f=files(t),exact=Buffer.alloc(1_048_576,0x20);exact.write('{}');f.save(exact);
  assert.deepEqual(f.read().binding,{path:f.path,bytes:exact.length,sha256:digest(exact)});
  const oversized=Buffer.alloc(1_048_577,0x20);oversized.write('{}');f.save(oversized);assert.throws(f.read);
  f.save(Buffer.alloc(0));assert.throws(f.read);unlinkSync(f.absolute);mkdirSync(f.absolute);assert.throws(f.read);
});

test('synthetic reader refuses duplicate literal or decoded JSON keys and invalid UTF-8 bytes',t=>{
  const f=files(t);
  for(const bytes of ['{"schemaVersion":2,"schemaVersion":1}',
    '{"requestIdentity":{"orderId":"first","order\\u0049d":"second"}}',
    '{"a":1,"\\u0061":2}',Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xc3,0x28,0x22,0x7d]),'{} {}']){
    f.save(bytes);assert.throws(f.read);
  }
});
