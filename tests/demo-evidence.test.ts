import test from 'node:test';
import assert from 'node:assert/strict';
import {demoArguments,negativeDemoEvidence,negativeContractChecks,expectedBlockedExit} from '../scripts/demo-evidence.js';
function fixture(){const startedAt='2026-10-02T00:00:00.000Z',endedAt='2026-10-02T00:01:00.000Z';return {startedAt,endedAt,exits:[0,0],contracts:{status:'PASS',scope:'LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES',exitCode:0,startedAt,endedAt,tests:{passed:68,failed:0,skipped:0}},contractLog:negativeContractChecks.map(n=>`[PASS] ${n}()`).join('\n')+'\n68 tests passed, 0 failed, 0 skipped',unitLog:'# Subtest: unknown, contradictory, low-confidence and failed JEV cannot sign executable receipts\n# Subtest: new review refuses unsalted evidence and altered salt before JEV or receipt signing\n# Subtest: hard failures reject before JEV\n# Subtest: reviewer scope rejects changed domain authority model rule decision expiry and broader remote policies before signing\n# pass 16\n# fail 0\n# cancelled 0\n# skipped 0\n'};}
test('demo arguments require explicit local scope and reject arbitrary or repeated options',()=>{
  for(const kind of ['happy','negative']){assert.deepEqual(demoArguments([kind]),{kind,local:false});assert.deepEqual(demoArguments([kind,'--monad-local']),{kind,local:true});}
  for(const args of [[],['unknown'],['happy','--public'],['negative','--monad-local','--monad-local'],['happy','--local'],['happy','--monad-local','--tx']])assert.throws(()=>demoArguments(args),/ARGUMENT_INVALID/);
});
test('happy wrapper distinguishes expected external BLOCKED from timeout spawn error or termination',()=>{
  assert.equal(expectedBlockedExit({exitCode:1,commandError:false,signal:null}),true);
  for(const result of [{exitCode:1,commandError:true,signal:null},{exitCode:1,commandError:false,signal:'SIGTERM' as const},{exitCode:0,commandError:false,signal:null},{exitCode:null,commandError:false,signal:null}])assert.equal(expectedBlockedExit(result),false);
});
test('negative demo evidence requires actual complete successful logs and every named guard without duplicates',()=>{
  const x=fixture();assert.equal(negativeDemoEvidence(x),true);
  for(const change of [{unitLog:x.unitLog.replace('# pass 16','# pass 15')},{unitLog:x.unitLog.replace('new review refuses unsalted evidence and altered salt before JEV or receipt signing','unrelated test')},{exits:[0,null]},{exits:[0]},{unitLog:x.unitLog.replace('# fail 0','# fail 1')},{unitLog:x.unitLog.replace('# skipped 0','# skipped 1')},{contractLog:x.contractLog.replace('[PASS] testChangedPayee()','[SKIP] testChangedPayee()')},{contractLog:x.contractLog+'\n[PASS] testChangedPayee()'},{contractLog:x.contractLog+'\n[FAIL: bad] unknown()'},{contractLog:x.contractLog.replace('68 tests passed','67 tests passed')}])assert.equal(negativeDemoEvidence({...x,...change}),false);
});
test('negative demo rejects stale future or public-scope substituted metadata and incomplete model-review tests',()=>{
  for(const change of [{contracts:{...fixture().contracts,scope:'PUBLIC_MONAD'}},{contracts:{...fixture().contracts,startedAt:'2026-10-01T00:00:00.000Z'}},{contracts:{...fixture().contracts,endedAt:'2026-10-03T00:00:00.000Z'}},{contracts:{...fixture().contracts,tests:{passed:68,failed:1,skipped:0}}},{contracts:{...fixture().contracts,tests:{passed:67,failed:0,skipped:0}}},{unitLog:fixture().unitLog.replace('reviewer scope rejects','irrelevant test rejects')}])assert.equal(negativeDemoEvidence({...fixture(),...change}),false);
});
