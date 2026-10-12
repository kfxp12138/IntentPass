import test from 'node:test';
import assert from 'node:assert/strict';
import {day4LocalEvidence} from '../scripts/day4-evidence.js';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a='0x'+'1'.repeat(40),start='2026-10-02T00:00:00.000Z',end='2026-10-02T00:01:00.000Z';
function fixture(){return {startedAt:start,endedAt:end,exits:[0,0,0,0,0,0],minimumTests:272,unit:'# pass 272\n# fail 0\n# cancelled 0\n# skipped 0\n',contracts:{scope:'LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES',status:'PASS',startedAt:start,endedAt:end,exitCode:0,tests:{passed:68,failed:0,skipped:0}},demo:{scope:'LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES_NOT_PUBLIC_MONAD_OR_CVA',status:'PASS',timestamp:end,orderId:h(44),finalBalances:{buyer:'980',seller:'20',escrow:'0'},transactions:Array.from({length:28},(_,i)=>({step:i===0?'deploy:ContextVoteEscrow':i===1?'submit:concurrent-replay-rejected':'local-test-step',hash:h(i+1),block:String(i+1),status:i===1?'reverted':'success'})),worker:{restart:'CONFIRMED',lostResponse:'RECONCILED',lostResponseSends:1},funding:{sends:2},orders:['ALLOCATED_PAID','ALLOCATED_REFUND','ALLOCATED_PAID'].map(state=>({chainId:'31337',arbiter:a,state,accounting:{balance:'0',outstanding:'0',locked:'0'}}))},creationProof:{status:'CONFIRMED',scope:'LOCAL_TEST_DEPLOYMENT_CREATION_PROOF',chainId:'31337',hash:h(1),contractAddress:a,officialIntegrationVerified:false,transactionsSent:0}};}
test('D4 prerequisites require successful complete commands and fresh native artifacts with exact local scope',()=>{
  assert.equal(day4LocalEvidence(fixture()),true);
  for(const change of [{exits:[0,0,0,0,0,null]},{exits:[0,0,0,0,0,1]},{exits:[0]},{unit:'# pass 272\n'},{startedAt:'2026-10-02T00:00:01.000Z'}])assert.equal(day4LocalEvidence({...fixture(),...change}),false);
  const x=fixture();x.demo.scope='PUBLIC_MONAD';assert.equal(day4LocalEvidence(x),false);
});
test('D4 prerequisites reject stale native demo changed balances duplicate transactions and missing deployment binding',()=>{
  for(const mutate of [(x:ReturnType<typeof fixture>)=>{x.demo.timestamp='2026-10-01T23:59:59.000Z';},(x:ReturnType<typeof fixture>)=>{x.demo.finalBalances.escrow='15';},(x:ReturnType<typeof fixture>)=>{x.demo.transactions[1].hash=x.demo.transactions[0].hash;},(x:ReturnType<typeof fixture>)=>{x.creationProof.hash=h(99);},(x:ReturnType<typeof fixture>)=>{x.demo.orders[0].arbiter='0x'+'2'.repeat(40);}]){const x=fixture();mutate(x);assert.equal(day4LocalEvidence(x),false);}
});
test('D4 prerequisites reject duplicate sends remaining credits missing refund branch and claimed official integration',()=>{
  for(const mutate of [(x:ReturnType<typeof fixture>)=>{x.demo.worker.lostResponseSends=2;},(x:ReturnType<typeof fixture>)=>{x.demo.orders[0].accounting.outstanding='10';},(x:ReturnType<typeof fixture>)=>{x.demo.orders[1].state='ALLOCATED_PAID';},(x:ReturnType<typeof fixture>)=>{x.creationProof.officialIntegrationVerified=true;},(x:ReturnType<typeof fixture>)=>{x.contracts.tests.failed=1;},(x:ReturnType<typeof fixture>)=>{x.contracts.tests.passed=67;}]){const x=fixture();mutate(x);assert.equal(day4LocalEvidence(x),false);}
});
