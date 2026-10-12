import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData,keccak256,parseAbi,type Address} from 'viem';
import {Day4SubmitRejectionProofSchema} from '../packages/protocol/src/day4-submit-rejection-types.js';
import {day4SubmitRejectionFixture} from './support/day4-submit-rejection-fixture.js';

// Synthetic original signatures and RPC doubles only; tests do not prove D4.
test('public proof rejects reused submit hashes and same original order or context for identity controls',async()=>{
  const f=await day4SubmitRejectionFixture(),proof=await f.run();
  assert.equal(proof.status,'COMPLETE');assert.equal(Day4SubmitRejectionProofSchema.safeParse(proof).success,true);
  for(const mode of ['mutations','order','context']){
    const altered=structuredClone(proof);
    if(mode==='mutations')altered.observations[2].call!.calldataHash=altered.observations[1].call!.calldataHash;
    else if(mode==='order')altered.observations[3].call!.orderId=altered.observations[0].call!.orderId;
    else altered.observations[3].call!.contextHash=altered.observations[0].call!.contextHash;
    assert.equal(Day4SubmitRejectionProofSchema.safeParse(altered).success,false,mode);
  }
});
test('public proof refuses identity qualification for the control buyer even after query hashes are recomputed',async()=>{
  const proof=structuredClone(await (await day4SubmitRejectionFixture()).run());
  const baseline=proof.observations[0].qualification!,identity=proof.observations[3].qualification!;
  identity.input.request.from=baseline.input.request.from;
  const {config:c,request:r}=identity.input;
  const abi=parseAbi(['function complianceVerify(address,address) view returns(bool)','function canTransfer(address,address,address,uint256) view returns(bool)']);
  identity.observations[2].calldataHash=keccak256(encodeFunctionData({abi,functionName:'complianceVerify',args:[c.pool as Address,r.from as Address]}));
  identity.observations[4].calldataHash=keccak256(encodeFunctionData({abi,functionName:'canTransfer',args:[c.asset as Address,r.from as Address,r.to as Address,BigInt(r.amount)]}));
  assert.equal(Day4SubmitRejectionProofSchema.safeParse(proof).success,false);
});
test('public proof independently binds each eligibility query hash and amount to the fixed input',async()=>{
  const original=await (await day4SubmitRejectionFixture()).run();
  for(const index of [0,1,2,3,4]){
    const proof=structuredClone(original);proof.observations[3].qualification!.observations[index].calldataHash='0x'+'aa'.repeat(32);
    assert.equal(Day4SubmitRejectionProofSchema.safeParse(proof).success,false,String(index));
  }
  const altered=structuredClone(original);altered.observations[3].qualification!.input.request.amount='999';
  assert.equal(Day4SubmitRejectionProofSchema.safeParse(altered).success,false);
});
test('malformed fixed observation arrays fail parsing without throwing during public proof refinements',async()=>{
  const original=await (await day4SubmitRejectionFixture()).run();
  for(const length of [0,4,6]){
    const proof=structuredClone(original),observations=proof.observations[0].qualification!.observations;
    observations.length=length;
    if(length===6)observations[5]=structuredClone(observations[0]);
    assert.doesNotThrow(()=>assert.equal(Day4SubmitRejectionProofSchema.safeParse(proof).success,false));
  }
});
