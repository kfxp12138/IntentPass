import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicClient,custom,decodeFunctionData,keccak256,parseAbi,type Address,type Hex} from 'viem';
import {inspectCleanverseEligibility} from '../packages/protocol/src/cleanverse-inspection.js';
import {cleanverseInspectionPort} from '../packages/protocol/src/cleanverse-inspection-port.js';
import {CleanverseInspectionInputSchema,CleanverseInspectionReportSchema,cleanverseInspectionIds,type CleanverseInspectionInput,type CleanverseInspectionPort} from '../packages/protocol/src/cleanverse-inspection-types.js';

// Every response, address, code and block below is an explicit local double.
// These tests neither contact a provider nor create official identity evidence.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const addressWord=(address:string)=>`0x${address.slice(2).padStart(64,'0')}` as Hex;
const abi=parseAbi([
  'function policy() view returns(address)',
  'function isRegistered(address) view returns(bool)',
  'function complianceVerify(address,address) view returns(bool)',
  'function canTransfer(address,address,address,uint256) view returns(bool)',
]);
function fixture(){
  const input:CleanverseInspectionInput={config:{chainId:'10143',asset:a(1),validator:a(2),policy:a(3),pool:a(4)},request:{from:a(5),to:a(4),amount:'1000001'}};
  const calls:Parameters<CleanverseInspectionPort['call']>[0][]=[],codes:{address:Address;block:bigint}[]=[],blocks:(bigint|undefined)[]=[];
  const replies:(Hex|undefined|Error)[]=[addressWord(input.config.policy),h(1),h(1),h(1),h(1)];
  let chains=0;
  const port:CleanverseInspectionPort={blockTag:'finalized',chainId:async()=>{chains++;return 10143;},
    block:async number=>{blocks.push(number);return {number:number??23n,hash:h(23),timestamp:123n};},
    code:async(address,block)=>{codes.push({address,block});return '0x6000';},
    call:async request=>{const index=calls.length;calls.push({...request});const result=replies[index];if(result instanceof Error)throw result;return result;}};
  return {input,port,replies,calls,codes,blocks,chains:()=>chains};
}
const inspect=(f:ReturnType<typeof fixture>)=>inspectCleanverseEligibility(f.input,f.port);

test('Cleanverse inspection reads five fixed selectors and exact original transfer arguments at one finalized block',async()=>{
  const f=fixture(),report=await inspect(f);
  assert.equal(report.status,'COMPLETE');assert.equal(report.eligibility,'ALLOWED');assert.equal(report.policyLinked,true);assert.equal(report.snapshotVerified,true);
  assert.deepEqual(report.block,{number:'23',hash:h(23),timestamp:'123',finality:'finalized'});
  assert.deepEqual(report.observations.map(value=>value.id),cleanverseInspectionIds);
  assert.deepEqual(f.calls.map(call=>({to:call.to,block:call.blockNumber,...decodeFunctionData({abi,data:call.data})})),[
    {to:a(1),block:23n,functionName:'policy',args:undefined},
    {to:a(2),block:23n,functionName:'isRegistered',args:[a(4)]},
    {to:a(2),block:23n,functionName:'complianceVerify',args:[a(4),a(5)]},
    {to:a(2),block:23n,functionName:'complianceVerify',args:[a(4),a(4)]},
    {to:a(3),block:23n,functionName:'canTransfer',args:[a(1),a(5),a(4),1000001n]},
  ]);
  for(let index=0;index<f.calls.length;index++)assert.equal(report.observations[index].calldataHash,keccak256(f.calls[index].data));
  assert.deepEqual(f.codes,[{address:a(1),block:23n},{address:a(2),block:23n},{address:a(3),block:23n}]);
  assert.deepEqual(report.dependencies.map(value=>value.codeHash),Array(3).fill(keccak256('0x6000')));
  assert.deepEqual(f.blocks,[undefined,23n]);assert.equal(f.chains(),2);
});

test('all true observations do not claim D4 acceptance official provenance signatures or transferred funds and the report is frozen',async()=>{
  const f=fixture(),report=await inspect(f);
  assert.equal(report.scope,'FINALIZED_CONFIGURED_CLEANVERSE_INTERFACE_QUERIES_ONLY');assert.equal(report.officialIntegrationVerified,false);
  assert.equal(report.canExecute,false);assert.equal(report.signaturesRequested,0);assert.equal(report.transactionsSent,0);
  assert.equal('D4'in report,false);assert.notEqual(report.status,'PASS');assert.equal(report.falseChecks.length,0);
  assert.ok(Object.isFrozen(report)&&Object.isFrozen(report.input)&&Object.isFrozen(report.input.request)&&Object.isFrozen(report.observations));
  assert.throws(()=>{report.input.request.amount='999';},TypeError);
  assert.deepEqual(CleanverseInspectionReportSchema.parse(report),report);
});

test('strict inspection inputs reject other chains missing pool direction zero roles extra calldata and invalid uint amounts before reads',async()=>{
  const base=fixture().input;
  const invalid=[{...base,config:{...base.config,chainId:'31337'}},{...base,config:{...base.config,validator:a(0)}},
    {...base,request:{...base.request,to:a(6)}},{...base,request:{...base.request,from:a(0)}},
    {...base,data:'0x1234'},{...base,config:{...base.config,extra:'synthetic-private-field'}},
    ...['0','01','-1','1.5','0x1',String(2n**256n)].map(amount=>({...base,request:{...base.request,amount}}))];
  for(const input of invalid){const f=fixture();await assert.rejects(inspectCleanverseEligibility(input,f.port),/^Error: CLEANVERSE_INSPECTION_INPUT_INVALID$/);assert.equal(f.chains(),0);assert.deepEqual(f.calls,[]);}
});

test('maximum uint256 amount and the reverse pool direction retain exact calldata without numeric rounding',async()=>{
  const f=fixture();f.input.request={from:a(4),to:a(5),amount:String(2n**256n-1n)};
  const report=await inspect(f),decoded=decodeFunctionData({abi,data:f.calls[4].data});
  assert.equal(report.status,'COMPLETE');assert.deepEqual(decoded.args,[a(1),a(4),a(5),2n**256n-1n]);
});

test('caller input mutation during an asynchronous read cannot replace targets subjects pool or amount',async()=>{
  const f=fixture(),original=structuredClone(f.input);let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});const chain=f.port.chainId;let count=0;
  f.port.chainId=async()=>{if(++count===1)await wait;return chain();};
  const pending=inspect(f);f.input.config.asset=a(11);f.input.config.validator=a(12);f.input.config.policy=a(13);f.input.config.pool=a(14);
  f.input.request.from=a(15);f.input.request.to=a(14);f.input.request.amount='999';release();
  const report=await pending;assert.equal(report.status,'COMPLETE');assert.deepEqual(report.input,original);
  assert.deepEqual(decodeFunctionData({abi,data:f.calls[4].data}).args,[a(1),a(5),a(4),1000001n]);
  assert.deepEqual(f.calls.map(value=>value.to),[a(1),a(2),a(2),a(2),a(3)]);
});

test('pool registration false is its own denial category and never relabeled as a person identity failure',async()=>{
  const f=fixture();f.replies[1]=h(0);const report=await inspect(f);
  assert.equal(report.status,'COMPLETE');assert.equal(report.eligibility,'DENIED');assert.deepEqual(report.falseChecks,['POOL_REGISTERED']);
  assert.equal(report.observations[2].value,true);assert.equal(report.observations[3].value,true);assert.equal(report.issues.length,0);
  assert.equal('identityDenied'in report,false);assert.equal(report.officialIntegrationVerified,false);
});

test('all canonical false results preserve separate registration from to and transfer categories in fixed order',async()=>{
  const f=fixture();f.replies.splice(1,4,h(0),h(0),h(0),h(0));const report=await inspect(f);
  assert.equal(report.status,'COMPLETE');assert.equal(report.eligibility,'DENIED');assert.deepEqual(report.falseChecks,cleanverseInspectionIds.slice(1));
});

test('a partial genuine false with a failed or unavailable query remains unavailable rather than a complete denial',async()=>{
  for(const failed of [undefined,new Error('synthetic offline read')]){
    const f=fixture();f.replies[2]=h(0);f.replies[3]=failed;const report=await inspect(f);
    assert.equal(report.status,'BLOCKED');assert.equal(report.eligibility,'UNAVAILABLE');assert.deepEqual(report.falseChecks,['FROM_COMPLIANCE']);
    assert.equal(report.observations[3].status,'UNAVAILABLE');assert.equal(report.observations[3].reason,'QUERY_UNAVAILABLE');
    assert.equal(report.observations[3].returnData,null);assert.equal(report.snapshotVerified,true);assert.equal(f.calls.length,5);
  }
});

test('canonical booleans reject two truncated odd nonhex and trailing return bytes without turning them into false',async()=>{
  for(const raw of [h(2),'0x','0x00','0x1',h(1)+'00','0x'+'g'.repeat(64)]){
    const f=fixture();f.replies[2]=raw as Hex;const report=await inspect(f);
    assert.equal(report.status,'FAIL',raw);assert.equal(report.eligibility,'UNAVAILABLE');assert.deepEqual(report.falseChecks,[]);
    assert.equal(report.observations[2].status,'NONCANONICAL');assert.equal(report.observations[2].value,null);
    assert.equal(report.observations[2].returnData,null);assert.equal(report.observations[2].reason,'QUERY_NONCANONICAL');
    assert.ok(report.issues.includes('QUERY_NONCANONICAL'));
  }
});

test('asset policy address words require exact length zero high bytes and nonzero address',async()=>{
  for(const raw of [h(0),'0x1'+addressWord(a(3)).slice(3),'0x'+a(3).slice(2),addressWord(a(3))+'00']){
    const f=fixture();f.replies[0]=raw as Hex;const report=await inspect(f);
    assert.equal(report.status,'FAIL');assert.equal(report.policyLinked,null);assert.equal(report.eligibility,'UNAVAILABLE');
    assert.equal(report.observations[0].status,'NONCANONICAL');assert.equal(report.observations[0].returnData,null);
  }
});

test('a canonical different policy is recorded but cannot authorize observations for the configured policy',async()=>{
  const f=fixture();f.replies[0]=addressWord(a(99));const report=await inspect(f);
  assert.equal(report.status,'FAIL');assert.equal(report.policyLinked,false);assert.equal(report.eligibility,'UNAVAILABLE');
  assert.equal(report.observations[0].status,'RETURNED');assert.equal(report.observations[0].value,a(99));assert.ok(report.issues.includes('ASSET_POLICY_MISMATCH'));
});

test('missing unavailable and noncanonical dependency code prevent all queries and failures take priority',async()=>{
  for(const raw of [undefined,'0x',new Error('synthetic offline dependency'),'0x0','0xzz']){
    const f=fixture();const original=f.port.code;f.port.code=async(address,block)=>{if(address===a(2)){if(raw instanceof Error)throw raw;return raw as Hex|undefined;}return original(address,block);};
    const report=await inspect(f),invalid=typeof raw==='string'&&raw!=='0x';
    assert.equal(report.status,invalid?'FAIL':'BLOCKED');assert.equal(report.eligibility,'UNAVAILABLE');assert.deepEqual(f.calls,[]);
    assert.ok(report.observations.every(value=>value.status==='NOT_ATTEMPTED'&&value.reason==='PREREQUISITE_UNAVAILABLE'));
    assert.equal(report.dependencies[1].codeHash,null);assert.equal(report.snapshotVerified,true);
  }
  const f=fixture();f.port.code=async address=>address===a(1)?undefined:address===a(2)?'0xzz' as Hex:'0x6000';
  const report=await inspect(f);assert.equal(report.status,'FAIL');assert.ok(report.issues.includes('DEPENDENCY_CODE_MISSING'));assert.ok(report.issues.includes('DEPENDENCY_CODE_NONCANONICAL'));
});

test('provider exception contents including a synthetic credential and authenticated URL never escape into the report',async()=>{
  const credential=['api','key_'].join('')+'Q'.repeat(40),url=['https://','synthetic-user',':','synthetic-password','@','provider.example/private'].join(''),marker=credential+' '+url;
  for(const method of ['chain','block','code','query','snapshot'] as const){
    const f=fixture(),error=new Error(marker);
    if(method==='chain')f.port.chainId=async()=>{throw error;};
    else if(method==='block')f.port.block=async()=>{throw error;};
    else if(method==='code')f.port.code=async()=>{throw error;};
    else if(method==='query')f.replies[2]=error;
    else{const original=f.port.block;f.port.block=async number=>{if(number!==undefined)throw error;return original(number);};}
    const report=await inspect(f),text=JSON.stringify(report);assert.equal(report.status,'BLOCKED');
    assert.ok(!text.includes(marker)&&!text.includes(credential)&&!text.includes(url));assert.equal(report.eligibility,'UNAVAILABLE');
  }
});

test('runtime finalized tag and exact public chain are required before dependency or query reads',async()=>{
  const local=fixture();local.port.blockTag='latest' as 'finalized';const rejected=await inspect(local);
  assert.equal(rejected.status,'FAIL');assert.deepEqual(rejected.issues,['FINALIZED_PORT_REQUIRED']);assert.equal(local.chains(),0);
  for(const chain of [31337,143,NaN,'10143']){const f=fixture();f.port.chainId=async()=>chain as number;const report=await inspect(f);
    assert.equal(report.status,'FAIL');assert.deepEqual(report.issues,['CHAIN_MISMATCH']);assert.equal(report.block,null);assert.deepEqual(f.calls,[]);assert.deepEqual(f.codes,[]);}
});

test('finalized block fields are strictly bigint uint and digest with unavailable distinguished from malformed values',async()=>{
  for(const patch of [{number:-1n},{number:23 as unknown as bigint},{timestamp:-1n},{timestamp:'123' as unknown as bigint},
    {hash:'0x1234' as Hex},{number:2n**256n},{timestamp:2n**256n}]){
    const f=fixture();f.port.block=async()=>({number:23n,hash:h(23),timestamp:123n,...patch});const report=await inspect(f);
    assert.equal(report.status,'FAIL');assert.deepEqual(report.issues,['FINALIZED_BLOCK_INVALID']);assert.equal(report.block,null);assert.deepEqual(f.codes,[]);
  }
  for(const patch of [{number:null},{hash:null}]){const f=fixture();f.port.block=async()=>({number:23n,hash:h(23),timestamp:123n,...patch});const report=await inspect(f);
    assert.equal(report.status,'BLOCKED');assert.deepEqual(report.issues,['FINALIZED_BLOCK_UNAVAILABLE']);assert.equal(report.block,null);}
  const zero=fixture();zero.port.block=async()=>({number:0n,hash:h(23),timestamp:0n});assert.equal((await inspect(zero)).status,'COMPLETE');
});

test('ending chain block number hash timestamp or finalized tag drift invalidates otherwise canonical observations',async()=>{
  for(const change of ['chain','number','hash','timestamp','tag']){
    const f=fixture();if(change==='chain'){let count=0;f.port.chainId=async()=>++count===1?10143:143;}
    else if(change==='tag'){const original=f.port.call;f.port.call=async query=>{const result=await original(query);f.port.blockTag='latest' as 'finalized';return result;};}
    else{const original=f.port.block;f.port.block=async number=>{const value=await original(number);if(number===undefined)return value;return {...value,...(change==='number'?{number:24n}:change==='hash'?{hash:h(99)}:{timestamp:124n})};};}
    const report=await inspect(f);assert.equal(report.status,'FAIL',change);assert.equal(report.snapshotVerified,false);assert.equal(report.eligibility,'UNAVAILABLE');
    assert.ok(report.issues.includes(change==='tag'?'FINALIZED_PORT_REQUIRED':'SNAPSHOT_CHANGED'));
  }
});

test('snapshot unavailability cannot become a denial and a concurrent proven mismatch still takes failure priority',async()=>{
  const f=fixture();f.replies[1]=h(0);const original=f.port.block;f.port.block=async number=>number===undefined?original(number):Promise.reject(new Error('synthetic snapshot offline'));
  const blocked=await inspect(f);assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.snapshotVerified,false);assert.deepEqual(blocked.falseChecks,['POOL_REGISTERED']);assert.equal(blocked.eligibility,'UNAVAILABLE');
  let count=0;f.port.chainId=async()=>++count===1?10143:143;f.calls.length=0;
  const failed=await inspect(f);assert.equal(failed.status,'FAIL');assert.ok(failed.issues.includes('SNAPSHOT_UNAVAILABLE'));assert.ok(failed.issues.includes('SNAPSHOT_CHANGED'));
});

test('provider-owned block objects and replaced methods cannot mutate the original frozen query or snapshot',async()=>{
  const f=fixture(),block={number:23n,hash:h(23),timestamp:123n};f.port.block=async number=>number===undefined?block:{number:23n,hash:h(23),timestamp:123n};
  const original=f.port.code;f.port.code=async(address,height)=>{block.number=99n;block.hash=h(99);block.timestamp=999n;f.port.call=async()=>addressWord(a(99));return original(address,height);};
  const report=await inspect(f);assert.equal(report.status,'COMPLETE');assert.equal(report.block!.number,'23');assert.equal(report.block!.hash,h(23));assert.equal(report.block!.timestamp,'123');assert.equal(f.calls.length,5);
});

test('viem inspection adapter uses only raw eth_call getCode and exact finalized block reads in an in-memory transport',async()=>{
  const f=fixture(),rpc:{method:string;params:readonly unknown[]|undefined}[]=[];
  const client=createPublicClient({transport:custom({request:async request=>{
    rpc.push({method:request.method,params:request.params as readonly unknown[]|undefined});
    if(request.method==='eth_chainId')return '0x'+(10143).toString(16);
    if(request.method==='eth_getBlockByNumber')return {number:'0x17',hash:h(23),timestamp:'0x7b',transactions:[],gasLimit:'0x1',gasUsed:'0x0',size:'0x1',difficulty:'0x0',totalDifficulty:'0x0'};
    if(request.method==='eth_getCode')return '0x6000';
    if(request.method==='eth_call'){
      const transaction=(request.params as unknown[])[0] as {to:Address;data:Hex},decoded=decodeFunctionData({abi,data:transaction.data});
      return decoded.functionName==='policy'?addressWord(f.input.config.policy):h(1);
    }
    throw Error('UNEXPECTED_LOCAL_READ_METHOD');
  }},{retryCount:0})});
  const port=cleanverseInspectionPort(client),report=await inspectCleanverseEligibility(f.input,port);
  assert.equal(report.status,'COMPLETE');assert.deepEqual(Object.keys(port),['blockTag','chainId','block','code','call']);assert.equal(Object.isFrozen(port),true);
  assert.equal(rpc.length,12);assert.equal(rpc.filter(value=>value.method==='eth_call').length,5);
  assert.deepEqual(rpc.filter(value=>value.method==='eth_getBlockByNumber').map(value=>value.params),[['finalized',false],['0x17',false]]);
  assert.deepEqual(rpc.filter(value=>value.method==='eth_getCode').map(value=>value.params),[[a(1),'0x17'],[a(2),'0x17'],[a(3),'0x17']]);
  for(const call of rpc.filter(value=>value.method==='eth_call')){assert.equal(call.params![1],'0x17');assert.deepEqual(Object.keys(call.params![0] as object).sort(),['data','to']);}
  assert.equal(rpc.some(value=>/send|sign|wallet|estimate/.test(value.method)),false);
});

test('inspection schemas safely reject malformed addresses truncated arrays and forged recorded observations without throwing or accepting contradictions',async()=>{
  const f=fixture();
  for(const address of ['not-an-address','0x','0x'+'g'.repeat(40)]){
    assert.doesNotThrow(()=>{assert.equal(CleanverseInspectionInputSchema.safeParse({...f.input,config:{...f.input.config,asset:address}}).success,false);});
  }
  const report=await inspect(f),malformed=[{...report,observations:[]},{...report,observations:report.observations.slice(0,4)},
    {...report,dependencies:[]},{...report,dependencies:report.dependencies.slice(0,2)},
    {...report,falseChecks:['POOL_REGISTERED']}];
  const valueMismatch=structuredClone(report);valueMismatch.observations[2].value=false;malformed.push(valueMismatch);
  const rawMismatch=structuredClone(report);rawMismatch.observations[2].returnData=h(2);malformed.push(rawMismatch);
  const replacedTarget=structuredClone(report);replacedTarget.observations[2].target=a(99);malformed.push(replacedTarget);
  for(const value of malformed)assert.doesNotThrow(()=>{assert.equal(CleanverseInspectionReportSchema.safeParse(value).success,false);});
});
