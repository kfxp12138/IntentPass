import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,keccak256,parseAbi,type Hex} from 'viem';
import {AuthorizationPayloadSchema} from '../packages/capsule/src/format.js';
import {compileGrant,contextHash,preparationHash,receiptTypedData,grantTypedData} from '../packages/protocol/src/index.js';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';
import {fundingCalldata} from '../packages/protocol/src/funding.js';
import {inspectDay4SubmitRejections} from '../packages/protocol/src/day4-submit-rejections.js';
import {Day4SubmitRejectionProofSchema,day4SubmitExpectedReverts,type Day4SubmitRejectionPort,type Day4SubmitRejectionRequest} from '../packages/protocol/src/day4-submit-rejection-types.js';
import {day4SubmitRejectionFixture,type Day4SubmitRejectionFixture} from './support/day4-submit-rejection-fixture.js';
import {readTestAddress as a,readTestHash as h} from './support/original-authorization.js';

// Every artifact, role signature and provider response here is synthetic local
// test material. Successful tests are never real D4 or official CVI evidence.
const qualificationAbi=parseAbi(['function policy() view returns(address)','function isRegistered(address) view returns(bool)',
  'function complianceVerify(address,address) view returns(bool)','function canTransfer(address,address,address,uint256) view returns(bool)']);
const zeroSignature='0x'+'00'.repeat(65);
const boolWord=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as Hex;
const privateMarker=['api','key_'].join('')+'Q'.repeat(64);
const signNegative=async(f:Day4SubmitRejectionFixture,patch:{bond?:string;deadline?:string})=>{
  const previous=f.request.ineligibleAuthorization!,intent={...previous.intent,...(patch.bond?{bond:patch.bond}:{})};
  const {signature:_signature,...oldReceipt}=previous.receipt,rawReceipt={...oldReceipt,contextHash:contextHash(intent)};
  const receipt={...rawReceipt,signature:await f.original.reviewer.signTypedData(receiptTypedData(rawReceipt,{chainId:f.original.deployment.chainId,arbiter:f.original.deployment.arbiter}))};
  const grant=await compileGrant({policy:previous.policy,intent,quote:previous.quote,receipt,deployment:f.original.deployment,
    authenticatedOwner:f.otherBuyer.address,executor:f.original.deployment.executor,nonce:previous.grant.nonce,deadline:patch.deadline??previous.grant.deadline,now:0n});
  f.request.ineligibleAuthorization=AuthorizationPayloadSchema.parse({...previous,intent,receipt,grant,
    ownerSignature:await f.otherBuyer.signTypedData(grantTypedData(grant)),preparationHash:preparationHash(contextHash(intent),intent.committeeHash)});
};

test('fixed original control and exact three rejections bind one historical block with no financial or official acceptance',async()=>{
  const f=await day4SubmitRejectionFixture(),proof=await f.run();
  assert.equal(proof.status,'COMPLETE');assert.deepEqual(proof.observations.map(value=>[value.id,value.status]),
    [['ALLOWED_SUBMIT','VERIFIED'],['OWNER_SIGNATURE_TAMPER','VERIFIED'],['RECEIPT_CONTEXT_TAMPER','VERIFIED'],['INELIGIBLE_SUBMIT','VERIFIED']]);
  assert.deepEqual(proof.selectedBlock,{number:'30',hash:h(30),timestamp:'1300'});assert.equal(proof.finalizedTip.number,'40');
  assert.equal(proof.creations.finalizedAnchor.number,'30');assert.equal(proof.officialIntegrationVerified,false);
  assert.equal(proof.financialAcceptanceStatus,'BLOCKED');assert.equal(proof.canExecute,false);assert.equal(proof.transactionsSent,0);assert.equal(proof.signaturesRequested,0);
  assert.equal(proof.observations[3].qualification?.falseChecks.includes('FROM_COMPLIANCE'),true);
  assert.equal(f.calls.submits.length,4);assert.ok(f.calls.submits.every(call=>call.blockNumber===30n&&call.gas===5_000_000n&&call.value===0n
    &&call.from===f.config.executor&&call.to===f.config.pool));
  assert.equal(f.calls.queries.length,10);assert.ok(f.calls.queries.every(call=>call.blockNumber===30n));
  assert.ok(f.calls.code.every(call=>call.number===30n));assert.ok(f.calls.getters.every(call=>call.number===30n));
  for(const number of [20n,21n,30n])assert.ok(f.calls.blocks.filter(value=>value===number).length>=2);
  assert.equal(f.calls.blocks[0],undefined);assert.ok(f.calls.blocks.includes(40n));
  assert.equal(proof.observations[0].call?.calldataHash,keccak256(fundingCalldata(f.request.allowedAuthorization)));
  assert.equal(Day4SubmitRejectionProofSchema.safeParse(proof).success,true);assert.ok(Object.isFrozen(proof.observations[0].qualification?.input.request));
  const published=JSON.stringify(proof);for(const text of [f.request.allowedAuthorization.ownerSignature,f.request.allowedAuthorization.receipt.signature,
    f.calls.submits[0].data,'LOCAL PRIVATE TASK','LOCAL PRIVATE EVIDENCE'])assert.equal(published.includes(text),false);
});

test('owner and receipt mutations change only the fixed intended field, retaining executor order amount and all other signed bytes',async()=>{
  const f=await day4SubmitRejectionFixture();await f.run();
  const [baseline,owner,receipt]=f.calls.submits.slice(0,3).map(call=>decodeFunctionData({abi:escrowAbi,data:call.data}));
  assert.equal(baseline.functionName,'submit');assert.equal(owner.functionName,'submit');assert.equal(receipt.functionName,'submit');
  if(baseline.functionName!=='submit'||owner.functionName!=='submit'||receipt.functionName!=='submit')throw Error('SYNTHETIC_EXPECTED_SUBMIT');
  assert.deepEqual(owner.args,baseline.args.map((arg,index)=>index===4?zeroSignature:arg));
  assert.deepEqual(receipt.args,baseline.args.map((arg,index)=>index===1?{...baseline.args[1],contextHash:'0x'+(BigInt(baseline.args[1].contextHash)^1n).toString(16).padStart(64,'0')}:arg));
  assert.notEqual(keccak256(f.calls.submits[0].data),keccak256(f.calls.submits[1].data));assert.notEqual(keccak256(f.calls.submits[0].data),keccak256(f.calls.submits[2].data));
});

test('qualification queries preserve exact asset validator pool buyer amount selectors and fixed selected height',async()=>{
  const f=await day4SubmitRejectionFixture();await f.run();
  for(const [index,buyer] of [f.original.buyer.address,f.otherBuyer.address].entries()){
    const group=f.calls.queries.slice(index*5,index*5+5),decoded=group.map(call=>decodeFunctionData({abi:qualificationAbi,data:call.data}));
    assert.deepEqual(decoded.map(value=>value.functionName),['policy','isRegistered','complianceVerify','complianceVerify','canTransfer']);
    assert.deepEqual(decoded.map(value=>value.args),[undefined,[f.config.pool],[f.config.pool,buyer],[f.config.pool,f.config.pool],
      [f.config.asset,buyer,f.config.pool,15n]]);
    assert.deepEqual(group.map(value=>value.to.toLowerCase()),[f.config.asset,f.config.validator,f.config.validator,f.config.validator,f.config.policy].map(value=>value.toLowerCase()));
  }
});

test('strict input and block quantities reject added gas calldata bad range and malformed address before provider access',async()=>{
  const f=await day4SubmitRejectionFixture();let count=0;f.port.chainId=async()=>{count++;return 10143;};
  for(const input of [{...f.request,gas:'1'},{...f.request,data:'0x'},{...f.request,blockNumber:'-1'},{...f.request,blockNumber:'030'},
    {...f.request,blockNumber:String(2n**256n)},{...f.request,allowedAuthorization:null}])
    await assert.rejects(inspectDay4SubmitRejections(input,f.config,f.artifacts,f.port),/DAY4_SUBMIT_INPUT_INVALID/);
  for(const config of [{...f.config,executor:'bad-address'},{...f.config,executor:a(0)},{...f.config,chainId:'143'},{...f.config,arbitrary:'0x'}])
    await assert.rejects(inspectDay4SubmitRejections(f.request,config,f.artifacts,f.port),/DAY4_SUBMIT_INPUT_INVALID/);
  assert.equal(count,0);assert.equal(f.calls.blocks.length,0);assert.equal(f.calls.submits.length,0);
});

test('bad original allowed role signatures are rejected before any RPC; a changed buyer cannot become an identity denial',async()=>{
  const f=await day4SubmitRejectionFixture();f.request.allowedAuthorization.ownerSignature=zeroSignature;
  await assert.rejects(f.run(),/DAY4_SUBMIT_ALLOWED_AUTHORIZATION_INVALID/);assert.equal(f.calls.blocks.length,0);
  const negative=await day4SubmitRejectionFixture();negative.request.ineligibleAuthorization!.intent.buyer=a(91);
  const proof=await negative.run();assert.equal(proof.status,'FAIL');assert.equal(proof.observations[3].status,'FAIL');
  assert.equal(proof.observations[3].reason,'INELIGIBLE_AUTHORIZATION_INVALID');assert.equal(negative.calls.submits.length,3);
});

test('wrong live finalized tag and chain are rejected before creation or submit reads',async()=>{
  const f=await day4SubmitRejectionFixture();f.port.blockTag='latest' as 'finalized';await assert.rejects(f.run(),/DAY4_SUBMIT_FINALIZED_PORT_REQUIRED/);assert.equal(f.calls.blocks.length,0);
  for(const chain of [143,'10143',NaN]){const g=await day4SubmitRejectionFixture();g.controls.chain=chain as number;
    await assert.rejects(g.run(),/DAY4_SUBMIT_CHAIN_MISMATCH/);assert.equal(g.calls.blocks.length,0);assert.equal(g.calls.submits.length,0);}
});

test('future selected block is unavailable and never permits code or submit calls',async()=>{
  const f=await day4SubmitRejectionFixture();f.request.blockNumber='41';await assert.rejects(f.run(),/DAY4_SUBMIT_BLOCK_NOT_FINALIZED/);
  assert.deepEqual(f.calls.blocks,[undefined]);assert.equal(f.calls.code.length,0);assert.equal(f.calls.submits.length,0);
});

test('unavailable anchor is distinct from malformed block number hash or timestamp',async()=>{
  for(const raw of [null,undefined,{number:null,hash:null,timestamp:1300n}]){
    const f=await day4SubmitRejectionFixture();f.port.block=async()=>raw as Awaited<ReturnType<Day4SubmitRejectionPort['block']>>;
    await assert.rejects(f.run(),/DAY4_SUBMIT_BLOCK_UNAVAILABLE/);assert.equal(f.calls.submits.length,0);
  }
  for(const patch of [{number:-1n},{number:2n**256n},{number:40},{hash:'0x30'},{timestamp:-1n},{timestamp:2n**256n},{timestamp:'1300'},{hash:null}]){
    const f=await day4SubmitRejectionFixture(),normal=f.port.block;f.port.block=async number=>({...await normal(number),...patch}) as Awaited<ReturnType<Day4SubmitRejectionPort['block']>>;
    await assert.rejects(f.run(),/DAY4_SUBMIT_BLOCK_INVALID/);assert.equal(f.calls.submits.length,0);
  }
});

test('original creation pending missing code or altered calldata is never a successful negative control',async()=>{
  const pending=await day4SubmitRejectionFixture();pending.port.receipt=async()=>null;await assert.rejects(pending.run(),/DAY4_SUBMIT_CREATIONS_PENDING/);assert.equal(pending.calls.submits.length,0);
  const missing=await day4SubmitRejectionFixture();missing.port.code=async()=>undefined;await assert.rejects(missing.run(),/DAY4_SUBMIT_CREATIONS_CODE_MISSING/);
  const bad=await day4SubmitRejectionFixture();bad.transactions.gate.input=(bad.transactions.gate.input+'00') as Hex;
  await assert.rejects(bad.run(),/DAY4_SUBMIT_CREATIONS_TRANSACTION_INVALID/);assert.equal(bad.calls.submits.length,0);
});

test('baseline unavailable revert or qualification denial blocks all three negative calls rather than independently passing them',async()=>{
  for(const outcome of [{status:'UNAVAILABLE',reason:'RPC_UNAVAILABLE'},{status:'REVERT',revertData:day4SubmitExpectedReverts.INELIGIBLE_SUBMIT,rpcCode:3}]){
    const f=await day4SubmitRejectionFixture();f.controls.submitHook=()=>outcome;const proof=await f.run();assert.equal(proof.status,'BLOCKED');
    assert.equal(f.calls.submits.length,1);assert.ok(proof.observations.slice(1).every(value=>value.reason==='BASELINE_UNAVAILABLE'&&value.outcome==='NOT_ATTEMPTED'));
    assert.equal(proof.observations[0].revertData,null);
  }
  const f=await day4SubmitRejectionFixture();f.controls.allowedCompliant=false;const proof=await f.run();assert.equal(proof.status,'BLOCKED');
  assert.equal(proof.observations[0].reason,'QUALIFICATION_NOT_ALLOWED');assert.equal(f.calls.submits.length,0);
});

test('dependency absence before eligibility queries remains unavailable with no submit while malformed code fails',async()=>{
  for(const code of [undefined,'0x','0xzz'] as const){const f=await day4SubmitRejectionFixture(),normal=f.port.code;
    f.port.code=async(target,number)=>target.toLowerCase()===f.config.validator.toLowerCase()?code:normal(target,number);
    const proof=await f.run();assert.equal(proof.status,code==='0xzz'?'FAIL':'BLOCKED');assert.equal(proof.observations[0].reason,'QUALIFICATION_UNAVAILABLE');
    assert.equal(f.calls.queries.length,0);assert.equal(f.calls.submits.length,0);}
});

test('partial false qualification with unavailable query is not a genuine isolated ineligible control',async()=>{
  const f=await day4SubmitRejectionFixture(),normal=f.port.query;f.port.query=async input=>{
    const decoded=decodeFunctionData({abi:qualificationAbi,data:input.data});
    return decoded.functionName==='canTransfer'&&decoded.args[1].toLowerCase()===f.otherBuyer.address.toLowerCase()?undefined:normal(input);
  };
  const proof=await f.run();assert.equal(proof.status,'BLOCKED');assert.equal(proof.observations[3].reason,'QUALIFICATION_UNAVAILABLE');
  assert.equal(proof.observations[3].qualification?.eligibility,'UNAVAILABLE');assert.deepEqual(proof.observations[3].qualification?.falseChecks,['FROM_COMPLIANCE']);
  assert.equal(f.calls.submits.length,3);
});

test('noncanonical bool high address bits or wrong policy cannot establish valid Cleanverse interfaces',async()=>{
  for(const mode of ['bool','address','policy'] as const){const f=await day4SubmitRejectionFixture(),normal=f.port.query;
    f.port.query=async input=>{const decoded=decodeFunctionData({abi:qualificationAbi,data:input.data});
      if(mode==='bool'&&decoded.functionName==='isRegistered')return boolWord(2);
      if(mode==='address'&&decoded.functionName==='policy')return ('0x'+'1'.padStart(24,'0')+f.config.policy.slice(2)) as Hex;
      if(mode==='policy'&&decoded.functionName==='policy')return ('0x'+a(99).slice(2).padStart(64,'0')) as Hex;
      return normal(input);};
    const proof=await f.run();assert.equal(proof.status,'FAIL');assert.equal(proof.observations[0].reason,'QUALIFICATION_UNAVAILABLE');assert.equal(f.calls.submits.length,0);
  }
});

test('pool or custody false and policy-only false are separate from a genuinely ineligible buyer',async()=>{
  const pool=await day4SubmitRejectionFixture();pool.controls.poolRegistered=false;assert.equal((await pool.run()).observations[0].reason,'QUALIFICATION_NOT_ALLOWED');assert.equal(pool.calls.submits.length,0);
  for(const mode of ['pool','custody','policy'] as const){const f=await day4SubmitRejectionFixture(),normal=f.port.query;
    f.port.query=async input=>{const denied=f.calls.submits.length===3,decoded=decodeFunctionData({abi:qualificationAbi,data:input.data});
      if(denied&&mode==='pool'&&decoded.functionName==='isRegistered')return boolWord(0);
      if(denied&&mode==='custody'&&decoded.functionName==='complianceVerify'&&decoded.args[1].toLowerCase()===f.config.pool.toLowerCase())return boolWord(0);
      if(denied&&mode==='policy'&&decoded.functionName==='complianceVerify'&&decoded.args[1].toLowerCase()===f.otherBuyer.address.toLowerCase())return boolWord(1);
      if(denied&&mode==='policy'&&decoded.functionName==='canTransfer')return boolWord(0);
      return normal(input);};
    const proof=await f.run();assert.equal(proof.status,'BLOCKED');assert.equal(proof.observations[3].reason,'IDENTITY_DENIAL_NOT_ISOLATED');assert.equal(f.calls.submits.length,3);
  }
});

test('missing ineligible material stays blocked while invalid signature and legitimate mismatched business fail',async()=>{
  const missing=await day4SubmitRejectionFixture();missing.request.ineligibleAuthorization=null;const absent=await missing.run();
  assert.equal(absent.status,'BLOCKED');assert.equal(absent.observations[3].reason,'INELIGIBLE_AUTHORIZATION_MISSING');assert.equal(missing.calls.submits.length,3);
  const bad=await day4SubmitRejectionFixture();bad.request.ineligibleAuthorization!.ownerSignature=zeroSignature;const invalid=await bad.run();
  assert.equal(invalid.status,'FAIL');assert.equal(invalid.observations[3].reason,'INELIGIBLE_AUTHORIZATION_INVALID');assert.equal(bad.calls.submits.length,3);
  const mismatch=await day4SubmitRejectionFixture();await signNegative(mismatch,{bond:'4'});const changed=await mismatch.run();
  assert.equal(changed.status,'FAIL');assert.equal(changed.observations[3].reason,'INELIGIBLE_BUSINESS_MISMATCH');assert.equal(mismatch.calls.submits.length,3);
});

test('valid original role signatures expired at the selected height remain blocked distinctly from signature corruption',async()=>{
  const f=await day4SubmitRejectionFixture();await signNegative(f,{deadline:'1200'});const proof=await f.run();
  assert.equal(proof.status,'BLOCKED');assert.equal(proof.observations[3].reason,'INELIGIBLE_AUTHORIZATION_EXPIRED');assert.equal(proof.observations[3].status,'BLOCKED');
  assert.equal(f.calls.submits.length,3);assert.equal(proof.observations[3].qualification,null);
});

test('unexpected negative revert bytes are only hashed and exact expected selector must have no trailing arguments',async()=>{
  for(const bytes of ['0x',day4SubmitExpectedReverts.OWNER_SIGNATURE_TAMPER+'00','0xdeadbeef']){
    const f=await day4SubmitRejectionFixture();f.controls.submitHook=id=>id==='ALLOWED_SUBMIT'?{status:'SUCCESS',returnData:'0x'}:
      {status:'REVERT',revertData:id==='OWNER_SIGNATURE_TAMPER'?bytes:day4SubmitExpectedReverts[id],rpcCode:3};
    const proof=await f.run();assert.equal(proof.status,'FAIL');const observed=proof.observations[1];assert.equal(observed.reason,'UNEXPECTED_REVERT');
    assert.equal(observed.revertData,null);assert.equal(observed.revertDataHash,keccak256(bytes as Hex));assert.equal(observed.rpcCode,3);
  }
});

test('nonempty successful control unexpected successful negative and non-code3 revert fail without pretending rejection',async()=>{
  const returnBytes=('0x'+'99'.repeat(40)) as Hex;
  const baseline=await day4SubmitRejectionFixture();baseline.controls.submitHook=()=>({status:'SUCCESS',returnData:returnBytes});const nonempty=await baseline.run();
  assert.equal(nonempty.status,'FAIL');assert.equal(nonempty.observations[0].reason,'NONEMPTY_RETURN');assert.equal(nonempty.observations[0].returnData,null);
  assert.equal(nonempty.observations[0].returnDataHash,keccak256(returnBytes));assert.equal(baseline.calls.submits.length,1);assert.equal(JSON.stringify(nonempty).includes(returnBytes),false);
  for(const result of [{status:'SUCCESS',returnData:'0x'},{status:'REVERT',revertData:day4SubmitExpectedReverts.OWNER_SIGNATURE_TAMPER,rpcCode:-32000},
    {status:'REVERT',revertData:day4SubmitExpectedReverts.OWNER_SIGNATURE_TAMPER,rpcCode:3,providerDetails:'ignored?'}]){
    const f=await day4SubmitRejectionFixture();f.controls.submitHook=id=>id==='ALLOWED_SUBMIT'?{status:'SUCCESS',returnData:'0x'}:
      id==='OWNER_SIGNATURE_TAMPER'?result:{status:'REVERT',revertData:day4SubmitExpectedReverts[id],rpcCode:3};
    const proof=await f.run();assert.equal(proof.status,'FAIL');assert.equal(proof.observations[1].reason,result.status==='SUCCESS'?'UNEXPECTED_SUCCESS':'RPC_RESULT_INVALID');
    assert.equal(proof.observations[1].revertData,null);
  }
});

test('RPC errors and missing exact revert bytes expose only fixed unavailable reasons, never provider original text',async()=>{
  const f=await day4SubmitRejectionFixture();f.controls.submitError=Error(privateMarker);const proof=await f.run();
  assert.equal(proof.status,'BLOCKED');assert.equal(proof.observations[0].reason,'RPC_UNAVAILABLE');assert.equal(JSON.stringify(proof).includes(privateMarker),false);
  const missing=await day4SubmitRejectionFixture();missing.controls.submitHook=id=>id==='ALLOWED_SUBMIT'?{status:'SUCCESS',returnData:'0x'}:
    id==='OWNER_SIGNATURE_TAMPER'?{status:'UNAVAILABLE',reason:'REVERT_BYTES_UNAVAILABLE'}:{status:'REVERT',revertData:day4SubmitExpectedReverts[id],rpcCode:3};
  assert.equal((await missing.run()).observations[1].reason,'REVERT_BYTES_UNAVAILABLE');
  const common=await day4SubmitRejectionFixture();common.port.block=async()=>{throw Error(privateMarker);};
  await assert.rejects(common.run(),(error:unknown)=>error instanceof Error&&error.message==='DAY4_SUBMIT_READ_UNAVAILABLE'&&!String(error).includes(privateMarker));
});

test('all selected original-tip and creation block fields are rechecked after calls, detecting number hash or timestamp drift',async()=>{
  for(const height of [20n,21n,30n,40n])for(const field of ['number','hash','timestamp'] as const){
    const f=await day4SubmitRejectionFixture();f.controls.blockHook=(number,raw)=>{
      if(f.calls.submits.length===4&&number===height)Object.assign(raw,field==='number'?{number:height+1n}:field==='hash'?{hash:h(99)}:{timestamp:9999n});};
    await assert.rejects(f.run(),/DAY4_SUBMIT_SNAPSHOT_CHANGED/,String(height)+' '+field);
  }
});

test('chain or finalized-tag drift after actual calls fails while natural finalized tip advancement preserves the original-height check',async()=>{
  for(const mode of ['chain','tag'] as const){const f=await day4SubmitRejectionFixture();f.controls.submitHook=id=>{
    if(id==='INELIGIBLE_SUBMIT'){if(mode==='chain')f.controls.chain=143;else f.port.blockTag='latest' as 'finalized';}
    return id==='ALLOWED_SUBMIT'?{status:'SUCCESS',returnData:'0x'}:{status:'REVERT',revertData:day4SubmitExpectedReverts[id],rpcCode:3};};
    await assert.rejects(f.run(),mode==='chain'?/DAY4_SUBMIT_CHAIN_MISMATCH/:/DAY4_SUBMIT_FINALIZED_PORT_REQUIRED/);}
  const f=await day4SubmitRejectionFixture();f.controls.submitHook=id=>{if(id==='INELIGIBLE_SUBMIT')f.controls.tip=41n;
    return id==='ALLOWED_SUBMIT'?{status:'SUCCESS',returnData:'0x'}:{status:'REVERT',revertData:day4SubmitExpectedReverts[id],rpcCode:3};};
  const proof=await f.run();assert.equal(proof.status,'COMPLETE');assert.equal(proof.finalizedTip.number,'40');assert.ok(f.calls.blocks.includes(40n));
});

test('input config artifact and method replacements after first await cannot change the fixed original queries or submit data',async()=>{
  const f=await day4SubmitRejectionFixture(),savedConfig=structuredClone(f.config),savedRequest=structuredClone(f.request),normal=f.port.chainId;
  let release!:()=>void;const pause=new Promise<void>(resolve=>{release=resolve;});let count=0;
  f.port.chainId=async()=>{if(++count===1)await pause;return normal();};const pending=f.run();
  f.request.blockNumber='31';f.request.allowedAuthorization.intent.orderId=h(777);f.request.allowedAuthorization.ownerSignature=zeroSignature;
  f.request.ineligibleAuthorization=null;f.config.executor=a(98);f.config.asset=a(99);f.config.committee.reverse();f.artifacts.gate.bytecode.object='0x60ff';
  for(const method of ['block','transaction','receipt','code','gateConfiguration','escrowConfiguration','query','submitCall'] as const)
    f.port[method]=async()=>{throw Error('REPLACED_SYNTHETIC_METHOD');};
  release();const proof=await pending;assert.equal(proof.status,'COMPLETE');assert.deepEqual(proof.config,savedConfig);assert.equal(proof.selectedBlock.number,'30');
  assert.equal(f.calls.submits[0].data,fundingCalldata(savedRequest.allowedAuthorization));assert.equal(f.calls.submits[0].from,savedConfig.executor);
  assert.equal(f.calls.submits[3].data,fundingCalldata(savedRequest.ineligibleAuthorization));
});

test('resolved mutable anchor and submit response objects are cloned before later awaits can alter their report evidence',async()=>{
  const f=await day4SubmitRejectionFixture(),normal=f.port.block,tip={number:40n,hash:h(40),timestamp:1400n};
  f.port.block=async number=>{if(number===undefined)return tip;tip.timestamp=9999n;return normal(number);};
  const first={status:'SUCCESS' as const,returnData:'0x' as Hex};
  f.controls.submitHook=id=>{if(id==='ALLOWED_SUBMIT')return first;first.returnData='0x99';return {status:'REVERT',revertData:day4SubmitExpectedReverts[id],rpcCode:3};};
  const proof=await f.run();assert.equal(proof.status,'COMPLETE');assert.equal(proof.finalizedTip.timestamp,'1400');assert.equal(proof.observations[0].returnData,'0x');
  assert.equal(proof.observations[0].returnDataHash,keccak256('0x'));
});

test('the fixed zero-value submit call object is immutable before entering a provider method',async()=>{
  const f=await day4SubmitRejectionFixture(),normal=f.port.submitCall;
  f.port.submitCall=async input=>{assert.equal(Object.isFrozen(input),true);assert.throws(()=>Object.assign(input,{value:1n,data:'0x',from:a(99),gas:1n}));return normal(input);};
  const proof=await f.run();assert.equal(proof.status,'COMPLETE');assert.ok(f.calls.submits.every(call=>call.value===0n&&call.gas===5_000_000n&&call.from===f.config.executor));
});

test('normalized proof cannot upgrade a failed control or alter public hashes eligibility block and fixed call bounds',async()=>{
  const f=await day4SubmitRejectionFixture(),original=await f.run();
  for(const mutate of [(proof:typeof original)=>{proof.observations[0].status='BLOCKED';proof.observations[0].reason='BASELINE_REVERTED';},
    (proof:typeof original)=>{proof.observations[1].revertDataHash=h(999);},
    (proof:typeof original)=>{proof.observations[3].qualification!.observations[2].value=true;},
    (proof:typeof original)=>{proof.observations[0].qualification!.block!.number='31';},
    (proof:typeof original)=>{proof.observations[1].call!.from=a(99);},
    (proof:typeof original)=>{proof.observations[2].call!.calldataHash=proof.observations[0].call!.calldataHash;}]){
    const proof=structuredClone(original);mutate(proof);assert.equal(Day4SubmitRejectionProofSchema.safeParse(proof).success,false);
  }
});
