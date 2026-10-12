import test from 'node:test';
import assert from 'node:assert/strict';
import {completeReleaseUnitRun} from '../scripts/release-local-outcome.js';
const summary='# tests 100\n# pass 100\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('release local gate accepts a complete run and rejects skips failures incomplete or conflicting summaries',()=>{
  assert.equal(completeReleaseUnitRun(summary).pass,100);
  for(const output of [summary.replace('# skipped 0','# skipped 1'),summary.replace('# fail 0','# fail 1'),summary.replace('# cancelled 0','# cancelled 1'),summary.replace('# todo 0','# todo 1'),summary.replace('# pass 100','# pass 99'),summary.replace('# tests 100\n',''),summary+summary,'not ok 1 - original failure\n'+summary])assert.throws(()=>completeReleaseUnitRun(output));
});
