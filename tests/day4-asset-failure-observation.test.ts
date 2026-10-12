import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {encodeAbiParameters,encodeFunctionData,getContractAddress,keccak256,parseAbi,parseAbiParameters,toHex,type Address,type Hex} from 'viem';
import {Day4AssetFailureProofSchema,type Day4AssetFailureProof} from '../packages/protocol/src/day4-asset-failure-types.js';
import {day4AssetFailureObservation} from '../scripts/day4-asset-failure-observation.js';

const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const block=(number:number,timestamp=number*10)=>({number:String(number),hash:h(number),timestamp:String(timestamp)});
// Explicit synthetic source/artifact/proof doubles. No compiler, chain, wallet,
// provider or live acceptance record is used to claim a successful integration.
function fixture(){
  const source={sourceCommit:'a'.repeat(40),bindings:[{path:'scripts/local-fixture.ts',bytes:10,sha256:'b'.repeat(64)}]};
  const expected={startedAt:'2026-10-03T01:00:00.000Z',endedAt:'2026-10-03T01:01:00.000Z',source,exitCode:1};
  const report={schemaVersion:1,scope:'LIVE_FIXED_PUBLIC_MONAD_ASSET_FAILURES_NOT_D4_EXTERNAL_ACCEPTANCE',
    startedAt:'2026-10-03T01:00:10.000Z',endedAt:'2026-10-03T01:00:20.000Z',sourceCommit:source.sourceCommit,
    sourceStable:true,sourceObservation:{before:structuredClone(source),after:structuredClone(source)},worktreeDirty:true,
    status:'BLOCKED',reason:'DAY4_ASSET_FAILURE_CONFIGURATION_MISSING',artifactBindings:[] as unknown[],financialAcceptanceStatus:'BLOCKED',
    officialIntegrationVerified:false,canPassD4:false,canExecute:false,signaturesRequested:0,transactionsSent:0,
    publicRpcInspectionAttempted:false,traceCallsAttempted:0,exitCode:1,inspection:undefined as Day4AssetFailureProof|undefined};
  return {source,expected,report};
}
function fullFixture(){
  const f=fixture(),files=new Map<string,Buffer>();
  const artifacts:Record<'gate'|'escrow',{hash:Hex;binding:unknown}>={} as Record<'gate'|'escrow',{hash:Hex;binding:unknown}>;
  for(const role of ['gate','escrow'] as const){
    const name=role==='gate'?'CleanverseEligibility':'ContextVoteEscrow',path=`contracts/out/${name}.sol/${name}.json`,sourcePath=`contracts/src/${name}.sol`;
    const sourceBytes=Buffer.from('// synthetic '+role+' source'),sourceHash=keccak256(toHex(sourceBytes));files.set(sourcePath,sourceBytes);
    const settings={evmVersion:'cancun',viaIR:true,optimizer:{enabled:true,runs:200},compilationTarget:{[`src/${name}.sol`]:name}};
    const bytecode=role==='gate'?'0x6001':'0x6002',compiler={version:'0.8.28+commit.7893614a'};
    const bytes=Buffer.from(JSON.stringify({bytecode:{object:bytecode},metadata:{compiler,settings,sources:{[`src/${name}.sol`]:{keccak256:sourceHash}}}}));files.set(path,bytes);
    artifacts[role]={hash:keccak256(bytecode),binding:{path,bytes:bytes.length,sha256:sha(bytes),compiler,settings,
      sources:[{path:sourcePath,bytes:sourceBytes.length,sha256:sha(sourceBytes),keccak256:sourceHash}]}};
  }
  const config={chainId:'10143',deployer:a(10),asset:a(20),validator:a(30),policy:a(40),gate:getContractAddress({from:a(10),nonce:2n}),
    pool:getContractAddress({from:a(10),nonce:3n}),reviewer:a(50),committee:[a(60),a(61),a(62)],gateNonce:'2',executor:a(70)};
  const {executor,...creationConfig}=config;
  const creation=(number:number,timestamp?:number)=>({schemaVersion:1,
    scope:'FINALIZED_ORIGINAL_GATE_AND_ESCROW_CREATIONS_CONFIGURED_SOURCE_NOT_OFFICIAL_PROVENANCE',status:'CREATIONS_VERIFIED',config:creationConfig,
    finalizedAnchor:block(number,timestamp),gate:{hash:h(100),nonce:'2',address:config.gate,creationBytecodeHash:artifacts.gate.hash,
      initCodeHash:h(110),runtimeCodeHash:h(120),receiptBlock:block(20),transactionIndex:0},escrow:{hash:h(101),nonce:'3',address:config.pool,
      creationBytecodeHash:artifacts.escrow.hash,initCodeHash:h(111),runtimeCodeHash:h(121),receiptBlock:block(21),transactionIndex:0},
    configuredCreationPairVerified:true,officialIntegrationVerified:false,financialAcceptanceStatus:'BLOCKED',canExecute:false,signaturesRequested:0,transactionsSent:0,limits:[]});
  const transaction=(hash:number,number:number,from=executor,timestamp?:number)=>({hash:h(hash),from,to:config.pool,calldataHash:h(hash+100),gas:'500000',gasUsed:'100000',nonce:hash,
    block:block(number,timestamp),transactionIndex:0});
  const observation=(id:'SETTLEMENT'|'REFUND'|'WITHDRAWAL',index:number)=>{
    const withdrawal=id==='WITHDRAWAL',failureNumber=id==='SETTLEMENT'?50:id==='REFUND'?60:70,timestamp=id==='REFUND'?4000:failureNumber*10;
    const order={chainId:config.chainId,arbiter:config.pool,asset:config.asset,orderId:h(index),contextHash:h(index+200),buyer:a(80),seller:a(81),payee:a(81),
      price:'10',bond:'5',deliveryDeadline:'2000',settlementDeadline:'3000',datasetHash:h(300),serviceTermsHash:h(301),evidenceHash:id==='REFUND'?h(0):h(302),voteMask:id==='REFUND'?0:3,
      state:id==='SETTLEMENT'?'CERTIFIED':withdrawal?'ALLOCATED_PAID':'FUNDED',credits:{buyer:withdrawal?'5':'0',payee:withdrawal?'10':'0'},
      withdrawn:{buyer:'0',payee:'0'},accounting:{locked:withdrawal?'0':'15',outstanding:withdrawal?'15':'0',balance:'15'},block:block(failureNumber,timestamp)};
    const callAbi=parseAbi(['function settle(bytes32)','function timeout(bytes32)','function withdraw(bytes32)']);
    const data=encodeFunctionData({abi:callAbi,functionName:id==='SETTLEMENT'?'settle':id==='REFUND'?'timeout':'withdraw',args:[order.orderId]});
    const revert=(withdrawal?'0x5274afe7'+encodeAbiParameters(parseAbiParameters('address'),[config.asset]).slice(2):'0x349cf84c') as Hex;
    const trace={fingerprint:h(index+400),rootOutputHash:keccak256(revert),rootGas:'500000',rootGasUsed:'100000',directCalls:withdrawal?4:1,
      condition:withdrawal?'TRANSFER_FALSE':'QUALIFICATION_FALSE',beneficiary:order.buyer,amount:id==='REFUND'?'15':'5',
      qualificationRejectAt:withdrawal?null:'POOL_REGISTERED',creditWritesReached:withdrawal,
      balances:withdrawal?{poolBefore:'15',beneficiaryBefore:'0',poolAfter:null,beneficiaryAfter:null}:null};
    return {id,status:'VERIFIED',reason:'EXACT_ORIGINAL_FAILURE_PATH',funding:transaction(600+index,30),
      failure:{...transaction(700+index,failureNumber,withdrawal?order.buyer:executor,timestamp),calldataHash:keccak256(data)},
      allocation:withdrawal?{...transaction(800+index,40),calldataHash:keccak256(encodeFunctionData({abi:callAbi,functionName:'settle',args:[order.orderId]}))}:null,order,trace,transactionEffectsUncommitted:true,
      ledgerScope:'FAILURE_HEIGHT_BLOCK_END_NOT_TRANSACTION_PRESTATE_OR_BALANCE_DELTA'};
  };
  const proof=Day4AssetFailureProofSchema.parse({schemaVersion:1,
    scope:'FINALIZED_ORIGINAL_FAILURE_TRACES_AND_BLOCK_END_LEDGER_NOT_OFFICIAL_ASSET_PROVENANCE_OR_FULL_D4',status:'COMPLETE',config,finalizedAnchor:block(90,5000),
    creations:[creation(30),creation(40),creation(50),creation(60,4000),creation(70)],
    observations:[observation('SETTLEMENT',1),observation('REFUND',2),observation('WITHDRAWAL',3)],
    officialIntegrationVerified:false,financialAcceptanceStatus:'BLOCKED',canExecute:false,signaturesRequested:0,transactionsSent:0,limits:['Synthetic local proof only.']});
  f.report.status='COMPLETE';f.report.reason='DAY4_ASSET_FAILURE_FIXED_OBSERVATIONS';f.report.inspection=proof;
  f.report.publicRpcInspectionAttempted=true;f.report.traceCallsAttempted=3;f.report.exitCode=0;f.expected.exitCode=0;
  f.report.artifactBindings=[artifacts.gate.binding,artifacts.escrow.binding];
  const reads:string[]=[],reader=(path:string)=>{reads.push(path);const value=files.get(path);if(!value)throw Error('Synthetic reader forbids unknown path');return value;};
  return {...f,proof,files,reader,reads};
}

test('asset-failure consumer accepts current missing configuration only with zero read/trace/financial capabilities',()=>{
  const f=fixture();assert.deepEqual(day4AssetFailureObservation(f.report,f.expected),{status:'BLOCKED',publicRpcInspectionAttempted:false,traceCallsAttempted:0,observations:[]});
});
test('asset-failure consumer requires current invocation time window and exact child exit',()=>{
  for(const patch of [{startedAt:'2026-10-03T00:59:59.000Z'},{endedAt:'2026-10-03T01:02:00.000Z'},
    {endedAt:'2026-10-03T01:00:09.000Z'},{startedAt:'INVALID'},{exitCode:0}]){const f=fixture();assert.equal(day4AssetFailureObservation({...f.report,...patch},f.expected).status,'FAIL');}
  const f=fixture();for(const expected of [{...f.expected,exitCode:null},{...f.expected,endedAt:'INVALID'},
    {...f.expected,endedAt:'2026-10-03T00:00:00.000Z'}])assert.equal(day4AssetFailureObservation(f.report,expected).status,'FAIL');
});
test('asset-failure consumer requires full original source identity before and after the invocation',()=>{
  for(const mode of ['revision','before','after','missing','private','stable']){
    const f=fixture();if(mode==='revision')f.report.sourceCommit='c'.repeat(40);
    else if(mode==='before')f.report.sourceObservation.before.bindings[0].bytes++;
    else if(mode==='after')f.report.sourceObservation.after.bindings[0].sha256='c'.repeat(64);
    else if(mode==='missing')f.report.sourceObservation.after.bindings=[];
    else if(mode==='private')f.report.sourceObservation.before.bindings[0].path='.env';
    else f.report.sourceStable=false;
    assert.equal(day4AssetFailureObservation(f.report,f.expected).status,'FAIL',mode);
  }
});
test('asset-failure consumer rejects elevated financial official or signing/broadcast capabilities and altered scope',()=>{
  for(const patch of [{canPassD4:true},{canExecute:true},{officialIntegrationVerified:true},{transactionsSent:1},{signaturesRequested:1},
    {financialAcceptanceStatus:'PASS'},{scope:'OFFICIAL_D4_ACCEPTANCE'},{schemaVersion:2}]){
    const f=fixture();assert.equal(day4AssetFailureObservation({...f.report,...patch},f.expected).status,'FAIL');
  }
});
test('missing preflight cannot conceal inspection trace calls artifacts or an embedded proof',()=>{
  for(const patch of [{publicRpcInspectionAttempted:true},{traceCallsAttempted:1},{artifactBindings:[{}]},{inspection:{status:'BLOCKED'}},
    {status:'FAIL'},{status:'COMPLETE'},{reason:'UNRELATED_BLOCKER'}]){
    const f=fixture();assert.equal(day4AssetFailureObservation({...f.report,...patch},f.expected).status,'FAIL');
  }
});
test('asset-failure consumer accepts bounded diagnostic blockers but never arbitrary errors',()=>{
  for(const reason of ['DAY4_ASSET_FAILURE_READ_UNAVAILABLE','DAY4_ASSET_FAILURE_PENDING','DAY4_CREATIONS_CODE_MISSING',
    'DAY4_ASSET_FAILURE_BLOCK_NOT_FINALIZED','DAY4_CREATIONS_BLOCK_UNAVAILABLE','DEPLOYMENT_BUILD_UNAVAILABLE']){
    const f=fixture();assert.equal(day4AssetFailureObservation({...f.report,reason},f.expected).status,'BLOCKED',reason);
  }
  for(const reason of ['DAY4_ASSET_FAILURE_LEDGER_INVALID','DAY4_ASSET_FAILURE_AUTHORIZATION_INVALID','DAY4_ASSET_FAILURE_INPUT_INVALID','DAY4_ASSET_FAILURE_SOURCE_CHANGED']){
    const f=fixture();assert.equal(day4AssetFailureObservation({...f.report,reason},f.expected).status,'FAIL',reason);
  }
});
test('asset-failure consumer requires integer actual trace count zero to three consistent with an inspection attempt',()=>{
  for(const traceCallsAttempted of [-1,4,1.5,'1',NaN]){const f=fixture();assert.equal(day4AssetFailureObservation({...f.report,traceCallsAttempted},f.expected).status,'FAIL');}
});
test('bounded errors after live reads require complete current artifacts and preserve partial actual trace counts',()=>{
  for(const traceCallsAttempted of [0,1,2,3]){
    const f=fullFixture();f.report.inspection=undefined;f.report.status='BLOCKED';f.report.reason='DAY4_ASSET_FAILURE_READ_UNAVAILABLE';f.report.exitCode=1;f.expected.exitCode=1;f.report.traceCallsAttempted=traceCallsAttempted;
    assert.deepEqual(day4AssetFailureObservation(f.report,f.expected,f.reader),{status:'BLOCKED',publicRpcInspectionAttempted:true,traceCallsAttempted,observations:[]});
    for(const patch of [{artifactBindings:[]},{artifactBindings:undefined},{reason:'DEPLOYMENT_BUILD_UNAVAILABLE'}])
      assert.equal(day4AssetFailureObservation({...f.report,...patch},f.expected,f.reader).status,'FAIL');
  }
});
test('synthetic complete proof checks all original failure ids and every historical creation hash while keeping D4 blocked',()=>{
  const f=fullFixture();assert.deepEqual(day4AssetFailureObservation(f.report,f.expected,f.reader),{status:'COMPLETE',publicRpcInspectionAttempted:true,traceCallsAttempted:3,
    observations:[{id:'SETTLEMENT',status:'VERIFIED'},{id:'REFUND',status:'VERIFIED'},{id:'WITHDRAWAL',status:'VERIFIED'}]});
  assert.ok(f.reads.length>f.proof.creations.length*2);assert.equal(f.report.canPassD4,false);assert.equal(f.proof.financialAcceptanceStatus,'BLOCKED');
});
test('synthetic unavailable trace is a valid blocked diagnostic without discarding the other verified paths',()=>{
  const f=fullFixture();f.proof.observations[1].status='BLOCKED';f.proof.observations[1].reason='TRACE_UNAVAILABLE';f.proof.observations[1].trace=null;
  f.proof.status='BLOCKED';f.report.status='BLOCKED';f.report.exitCode=1;f.expected.exitCode=1;
  assert.deepEqual(day4AssetFailureObservation(f.report,f.expected,f.reader),{status:'BLOCKED',publicRpcInspectionAttempted:true,traceCallsAttempted:3,
    observations:[{id:'SETTLEMENT',status:'VERIFIED'},{id:'REFUND',status:'BLOCKED'},{id:'WITHDRAWAL',status:'VERIFIED'}]});
});
test('synthetic complete proof cannot substitute a trace count another exit or a mismatched outer status',()=>{
  for(const patch of [{traceCallsAttempted:0},{traceCallsAttempted:2},{publicRpcInspectionAttempted:false},{exitCode:1},{status:'BLOCKED'}]){
    const f=fullFixture();assert.equal(day4AssetFailureObservation({...f.report,...patch},f.expected,f.reader).status,'FAIL');
  }
  const f=fullFixture();assert.deepEqual(day4AssetFailureObservation({...f.report,inspection:{status:'COMPLETE'}},f.expected,f.reader),
    {status:'FAIL',publicRpcInspectionAttempted:true,traceCallsAttempted:3,observations:[]});
});
test('synthetic multi-height proof cannot inherit different artifact bytecode at any later anchor',()=>{
  for(const role of ['gate','escrow'] as const){const f=fullFixture();f.proof.creations.at(-1)![role].creationBytecodeHash=h(999);
    assert.equal(Day4AssetFailureProofSchema.safeParse(f.proof).success,false);assert.equal(day4AssetFailureObservation(f.report,f.expected,f.reader).status,'FAIL');}
});
test('synthetic artifact source bytes private paths incomplete bindings and reader failures fail closed',()=>{
  for(const mode of ['bytes','missing','private','throw']){
    const f=fullFixture();if(mode==='bytes')f.files.set('contracts/src/ContextVoteEscrow.sol',Buffer.from('Changed synthetic source'));
    else if(mode==='missing')f.report.artifactBindings.pop();
    else if(mode==='private')(f.report.artifactBindings[0] as {path:string}).path='/private/synthetic-secret.json';
    const reader=mode==='throw'?()=>{throw Error('Synthetic private reader error');}:f.reader;
    assert.equal(day4AssetFailureObservation(f.report,f.expected,reader).status,'FAIL',mode);
    if(mode==='private')assert.equal(f.reads.length,0);
  }
});
test('synthetic proof cannot hide duplicate failure ids false ledger guarantees or swapped historical anchors',()=>{
  for(const mode of ['duplicate','effects','height','order','credits']){
    const f=fullFixture();if(mode==='duplicate')f.proof.observations[1].id='SETTLEMENT';
    else if(mode==='effects')(f.proof.observations[0] as unknown as {transactionEffectsUncommitted:boolean}).transactionEffectsUncommitted=false;
    else if(mode==='height')f.proof.creations[0].finalizedAnchor.hash=h(999);
    else if(mode==='order')f.proof.observations[1].order.orderId=f.proof.observations[0].order.orderId;
    else f.proof.observations[2].order.withdrawn.buyer='5';
    assert.equal(day4AssetFailureObservation(f.report,f.expected,f.reader).status,'FAIL',mode);
  }
});
test('asset-failure live CLI has fixed bounded read-only transport and full transaction/receipt preservation',()=>{
  const text=readFileSync(new URL('../scripts/inspect-day4-asset-failures.ts',import.meta.url),'utf8');
  assert.match(text,/http\('https:\/\/testnet-rpc\.monad\.xyz'/);assert.match(text,/ccipRead:false/);assert.match(text,/batch:\{multicall:false\}/);
  assert.match(text,/batch:false,retryCount:0/);assert.match(text,/maxResponseBodySize:1_048_576/);assert.match(text,/redirect:'error'/);
  assert.match(text,/transaction:creations\.transaction as Day4AssetFailurePort\['transaction'\]/);assert.match(text,/receipt:creations\.receipt as Day4AssetFailurePort\['receipt'\]/);
  assert.match(text,/traceCallsAttempted\+\+/);assert.match(text,/stat\.nlink!==1/);assert.match(text,/stat\.mode&0o777/);assert.match(text,/stat\.uid!==process\.getuid\(\)/);
  assert.doesNotMatch(text,/createWalletClient|sendTransaction|signTransaction|stateOverride|process\.env\.RPC_URL/);
});
test('asset-failure CLI missing preflight performs no fetch or compilation and archives original report bytes',t=>{
  const directory=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-asset-failure-cli-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'package.json'),'{}\n');
  const git=(args:string[])=>{const result=spawnSync('git',args,{cwd:directory,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);};
  git(['init','-q']);git(['add','package.json']);git(['-c','user.name=Synthetic Local Test','-c','user.email=synthetic@example.invalid','commit','-qm','local fixture']);
  const guard=join(directory,'network-guard.mjs');writeFileSync(guard,"let calls=0;globalThis.fetch=async()=>{calls++;throw Error('SYNTHETIC_FETCH_FORBIDDEN');};process.on('exit',()=>process.stderr.write('SYNTHETIC_FETCH_COUNT='+calls+'\\n'));\n");
  const env={...process.env};for(const name of Object.keys(env))if(/^(?:D4_|CHAIN_ID$|DEPLOYER_ADDRESS$|CVA_|CVI_|ELIGIBILITY_|ARBITER_|REVIEWER_|COMMITTEE_|CLEANVERSE_|PRIVY_|TYPESAFE_|PLANNER_|NODE_OPTIONS$)/.test(name))delete env[name];
  const script=new URL('../scripts/inspect-day4-asset-failures.ts',import.meta.url),run=(extra:NodeJS.ProcessEnv={})=>spawnSync(process.execPath,['--experimental-sqlite','--import',import.meta.resolve('tsx'),'--import',guard,script.pathname],{cwd:directory,env:{...env,...extra},encoding:'utf8',timeout:30000,maxBuffer:1_000_000});
  const first=run();assert.equal(first.status,1,first.stderr);assert.match(first.stderr,/SYNTHETIC_FETCH_COUNT=0/);
  const path=join(directory,'artifacts/acceptance/day4-asset-failures.json'),original=readFileSync(path),report=JSON.parse(original.toString('utf8'));
  assert.equal(report.reason,'DAY4_ASSET_FAILURE_CONFIGURATION_MISSING');assert.equal(report.publicRpcInspectionAttempted,false);assert.equal(report.traceCallsAttempted,0);assert.deepEqual(report.artifactBindings,[]);assert.equal(report.inspection,undefined);assert.equal(report.canPassD4,false);
  assert.equal(day4AssetFailureObservation(report,{startedAt:report.startedAt,endedAt:report.endedAt,source:report.sourceObservation.before,exitCode:1}).status,'BLOCKED');
  const second=run();assert.equal(second.status,1,second.stderr);assert.match(second.stderr,/SYNTHETIC_FETCH_COUNT=0/);
  const history=join(directory,'artifacts/acceptance/history'),folders=readdirSync(history);assert.equal(folders.length,1);assert.deepEqual(readFileSync(join(history,folders[0],'day4-asset-failures.json')),original);
  // A synthetic configured secret equal to an otherwise public reason proves
  // the actual-value substring guard separately from generic key heuristics.
  const previous=readFileSync(path),syntheticKey='DAY4_ASSET_FAILURE_CONFIGURATION_MISSING',sensitive=run({TYPESAFE_API_KEY:syntheticKey});
  assert.equal(sensitive.status,1);assert.match(sensitive.stderr,/DAY4_ASSET_FAILURE_EVIDENCE_WRITE_UNAVAILABLE/);assert.match(sensitive.stderr,/SYNTHETIC_FETCH_COUNT=0/);
  assert.equal(sensitive.stdout.includes(syntheticKey),false);assert.equal(sensitive.stderr.includes(syntheticKey),false);assert.deepEqual(readFileSync(path),previous);assert.equal(readdirSync(history).length,1);
  assert.equal(readdirSync(directory).includes('contracts'),false);
});
