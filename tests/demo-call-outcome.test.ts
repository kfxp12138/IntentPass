import test from 'node:test';
import assert from 'node:assert/strict';
import {toFunctionSelector} from 'viem';
import {classifyDemoCall,type ExpectedDemoCall} from '../scripts/demo-call-outcome.js';
test('live negative calls require the exact expected contract revert and never accept generic RPC errors or unexpected success',()=>{
  for(const expected of ['InvalidSignature()','ContextMismatch()','WrongExecutor()','AlreadyConsumed()','InvalidState()','NoCredit()'] as ExpectedDemoCall[]){
    assert.equal(classifyDemoCall(expected,{status:'REVERT',revertData:toFunctionSelector(expected),rpcCode:3}),'PASS');
    assert.equal(classifyDemoCall(expected,{status:'UNAVAILABLE',reason:'RPC_UNAVAILABLE'}),'BLOCKED');
    assert.equal(classifyDemoCall(expected,{status:'UNAVAILABLE',reason:'REVERT_BYTES_UNAVAILABLE'}),'BLOCKED');
    assert.equal(classifyDemoCall(expected,{status:'SUCCESS',returnData:'0x'}),'FAIL');
    assert.equal(classifyDemoCall(expected,{status:'REVERT',revertData:toFunctionSelector('Expired()'),rpcCode:3}),'FAIL');
  }
  assert.equal(classifyDemoCall('SUCCESS',{status:'SUCCESS',returnData:'0x'}),'PASS');
  assert.equal(classifyDemoCall('SUCCESS',{status:'REVERT',revertData:toFunctionSelector('Expired()'),rpcCode:3}),'FAIL');
});
