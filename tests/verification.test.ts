import test from 'node:test';
import assert from 'node:assert/strict';
import {commandExit,completeUnitRun} from '../scripts/verification-outcome.js';
test('verification rejects spawn error even when wrapper status is zero',()=>{
  assert.equal(commandExit({status:0,error:new Error('ETIMEDOUT')}),1);assert.equal(commandExit({status:null,error:new Error('ENOENT')}),1);
  assert.equal(commandExit({status:1}),1);assert.equal(commandExit({status:0}),0);
});
test('verification rejects incomplete TAP, failed/cancelled/skipped cases and low pass count',()=>{
  const output='# pass 43\n# fail 0\n# cancelled 0\n# skipped 0\n';assert.equal(completeUnitRun(output,43),true);
  for(const value of ['# Subtest: expected check\n',output.replace('pass 43','pass 42'),output.replace('fail 0','fail 1'),output.replace('cancelled 0','cancelled 1'),output.replace('skipped 0','skipped 1'),`not ok 1 - failure\n${output}`])assert.equal(completeUnitRun(value,43),false);
});
