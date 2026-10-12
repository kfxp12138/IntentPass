import {refreshAcceptanceIndex} from './acceptance-index.js';
import {commandExit,completeUnitRun} from './verification-outcome.js';
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';
import {z} from 'zod';
import {digest} from '../packages/protocol/src/schemas.js';
import {settlementRoute} from '../packages/protocol/src/route.js';
const startedAt=new Date().toISOString(),directory='artifacts/acceptance';
mkdirSync(directory,{recursive:true});
if(existsSync(`${directory}/day3.json`)) {
  const history=`${directory}/history/${startedAt.replaceAll(':','-')}-D3`;mkdirSync(history,{recursive:true});
  for(const name of readdirSync(directory))if(name==='day3.json'||name==='local-escrow-demo.json'||name.startsWith('day3-')&&name.endsWith('.log'))copyFileSync(`${directory}/${name}`,`${history}/${name}`);
}
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const runs:{command:string;startedAt:string;endedAt:string;exitCode:number|null;signal:NodeJS.Signals|null;evidence:string}[]=[];
for(const command of ['typecheck','build','test:unit','test:contract','abi:check','demo:local','test:contract:monad','demo:monad-local']) {
  const start=new Date().toISOString(),r=spawnSync('pnpm',['run',command],{encoding:'utf8',timeout:180000});
  const evidence=`${directory}/day3-${command.replaceAll(':','-')}.log`;
  writeFileSync(evidence,(r.stdout??'')+(r.stderr??'')+(r.error?'\n'+r.error.message:''));
  runs.push({command:`pnpm run ${command}`,startedAt:start,endedAt:new Date().toISOString(),exitCode:commandExit(r),signal:r.signal,evidence});
  console.log(`${command}: exit ${commandExit(r)}`);
}
const pass=(name:string)=>runs.find(r=>r.command===`pnpm run ${name}`)?.exitCode===0;
const log=(name:string)=>readFileSync(runs.find(r=>r.command===`pnpm run ${name}`)!.evidence,'utf8');
const contract=log('test:contract'),unit=log('test:unit');
const foundry=(...names:string[])=>pass('test:contract')&&names.every(name=>contract.includes(`[PASS] ${name}(`));
const unitOK=pass('test:unit')&&completeUnitRun(unit,43);
const node=(...names:string[])=>unitOK&&names.every(name=>unit.includes(`# Subtest: ${name}`));
const demoSchema=z.object({scope:z.literal('LOCAL_EVM_TEST_DOUBLES_ONLY_NOT_MONAD_OR_CVA'),status:z.literal('PASS'),timestamp:z.string(),orderId:digest,
  firstOrderBalances:z.object({buyerBefore:z.literal('1000'),buyerAfter:z.literal('990'),sellerAfter:z.literal('10'),escrowAfter:z.literal('0')}),
  finalBalances:z.object({buyer:z.literal('980'),seller:z.literal('20'),escrow:z.literal('0')}),
  orders:z.array(z.object({state:z.enum(['ALLOCATED_PAID','ALLOCATED_REFUND']),credits:z.object({buyer:z.literal('0'),payee:z.literal('0')}),accounting:z.object({locked:z.literal('0'),outstanding:z.literal('0'),balance:z.literal('0')})})).length(3),
  worker:z.object({restart:z.literal('CONFIRMED'),lostResponse:z.literal('RECONCILED'),lostResponseSends:z.literal(1)}),
  transactions:z.array(z.object({step:z.string(),hash:digest,block:z.string(),status:z.enum(['success','reverted'])})),
});
let demo:z.infer<typeof demoSchema>|undefined;
if(pass('demo:local'))try {
  demo=demoSchema.parse(JSON.parse(readFileSync(`${directory}/local-escrow-demo.json`,'utf8')));
  if(Date.parse(demo.timestamp)<Date.parse(startedAt))demo=undefined;
}catch{/* Invalid/stale output is a failure, never use the previous successful fixture. */}
let nativeDemo:z.infer<typeof demoSchema>|undefined;
if(pass('demo:monad-local'))try {
  const raw=JSON.parse(readFileSync(`${directory}/local-monad-demo.json`,'utf8'));
  if(raw.scope!=='LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES_NOT_PUBLIC_MONAD_OR_CVA')throw new Error('SCOPE');
  nativeDemo=demoSchema.parse({...raw,scope:'LOCAL_EVM_TEST_DOUBLES_ONLY_NOT_MONAD_OR_CVA'});
  if(Date.parse(nativeDemo.timestamp)<Date.parse(startedAt))nativeDemo=undefined;
}catch{}
const nativeOK=pass('test:contract:monad')&&!!nativeDemo&&nativeDemo.orders[0].state==='ALLOCATED_PAID'&&nativeDemo.orders[1].state==='ALLOCATED_REFUND'&&nativeDemo.orders[2].state==='ALLOCATED_PAID';
const demoOK=!!demo&&demo.orders[0].state==='ALLOCATED_PAID'&&demo.orders[1].state==='ALLOCATED_REFUND'&&demo.orders[2].state==='ALLOCATED_PAID';
const item=(id:string,condition:boolean,evidence:string[],reason:string)=>({id,applicable:true,status:condition?'PASS':'FAIL',evidence,reason});
const contractEvidence=[`${directory}/day3-test-contract.log`],demoEvidence=[`${directory}/day3-demo-local.log`,`${directory}/local-escrow-demo.json`],workerEvidence=[`${directory}/day3-test-unit.log`];
const items=[
  item('D3-01',demoOK&&foundry('testNormalFundsAndWithdrawals','testFuzzNormalConservation'),[...demoEvidence,...contractEvidence],'Exact P+B funding, B/P credits, actual withdrawals and accounting checked on local EVM.'),
  item('D3-02',foundry('testMissingOwnerSignature','testMissingReceiptSignature','testRejectNonPassReceipt','testLegacyCalldataCannotFund'),contractEvidence,'Missing authorizations/PASS and nonexistent old funding entry all reject.'),
  item('D3-03',foundry('testChangedPayee','testChangedAsset','testChangedPrice','testChangedCommittee','testChangedEvidence'),contractEvidence,'Previously signed order cannot be reused after changing protected fields.'),
  item('D3-04',demoOK&&!!demo?.transactions.some(t=>t.step==='submit:concurrent-replay-rejected'&&t.status==='reverted')&&foundry('testReplayRejected','testNonceCannotFundOtherOrder')&&node('independent Node processes atomically compete for one SQLite lease'),[...demoEvidence,...contractEvidence,...workerEvidence],'Two actual queued same-authorization transactions yield one funding and one reverted receipt; independent worker processes claim one lease.'),
  item('D3-05',foundry('testOneVoteCannotSettle','testDifferentEvidenceRejected'),contractEvidence,'One vote or mixed evidence cannot certify/settle.'),
  item('D3-06',demoOK&&foundry('testCertifiedTimeoutCompensation','testRefundWithoutDelivery','testRefundWithoutThreshold','testTerminalStateCannotAllocateTwice','testFalseTransferRetainsCredit','testRevertTransferRetainsCredit','testFeeOnWithdrawRejectedWithoutLosingCredit','testFuzzRefundConservation','testFuzzCompensationConservation')&&node('send timeout creates UNKNOWN and reconciliation uses terminal chain state without another send'),[...demoEvidence,...contractEvidence,...workerEvidence],'All three mutually exclusive allocations conserve funds; transfer failure retains credits; ambiguous send/restart does not rebroadcast.'),
  {id:'D3-07',applicable:false,status:'NOT_STARTED',evidence:['docs/decisions.md#adr-008'],reason:'Owner approved PACT-inspired route; Full PACT opening/setup is outside this selected implementation and is not claimed.'},
  item('D3-08',pass('build')&&pass('abi:check')&&foundry('testVoteFromOtherDomainRejected','testDuplicateMemberRejected','testInvalidCommitteeIndexRejected','testDifferentEvidenceRejected','testDuplicateCommitteeConstructorRejected')&&readFileSync('README.md','utf8').includes('非 IMAS/CDAS')&&readFileSync('apps/web/src/main.ts','utf8').includes('非 IMAS/CDAS'),[...contractEvidence,`${directory}/day3-abi-check.log`,'README.md','apps/web/src/main.ts'],'Wrong signature domain/index/evidence and duplicate committee are rejected; UI/README explicitly identify PACT-inspired, not IMAS/CDAS.'),
];
const status=unitOK&&nativeOK&&runs.every(r=>r.exitCode===0)&&items.filter(i=>i.applicable).every(i=>i.status==='PASS')?'PASS':'FAIL';
const report={stage:'D3',settlementRoute,status,scope:'LOCAL_EVM_TEST_DOUBLES_ONLY',commit:revision.status===0?revision.stdout.trim():null,worktreeDirty:working.status!==0||!!working.stdout.trim(),environment:{node:process.version,platform:process.platform,chainId:'31337',rpc:'ephemeral local Anvil',monadNativeExecutionVerified:nativeOK},startedAt,endedAt:new Date().toISOString(),runs,items,localTransactionHashes:demo?.transactions.map(t=>({step:t.step,hash:t.hash,status:t.status}))??[],monadTransactionHashes:[],requiredActions:['Complete real planner/JEV and Privy authentication/policy integration.','Obtain official Cleanverse ABI, CVI/CVA and custody eligibility.','Deploy and test a funded wallet on public Monad; native local execution is separately verified.','Complete HTTPS and real same-Passkey cross-device recovery.']};
writeFileSync(`${directory}/day3.json`,JSON.stringify(report,null,2)+'\n');
writeFileSync('docs/day3-report.md',`# D3 本地结算验收\n\n路线：${settlementRoute}（PACT-inspired，非 IMAS/CDAS）。本次状态：${status}。范围为本地标准 EVM、Monad 原生执行及 TEST_DOUBLE 资产/资格 gate，不代表公开 Monad 部署或真实 bounty 接入通过。D1/D2 的真实外部接入仍未通过。\n\n基准 commit：${report.commit}；工作区有修改：${report.worktreeDirty}。开始：${startedAt}；结束：${report.endedAt}。\n\n| 命令 | 退出码 | 证据 |\n|---|---|---|\n${runs.map(r=>`| ${r.command} | ${r.exitCode} | ${r.evidence} |`).join('\n')}\n\n| ID | 适用 | 结果 | 验证内容 |\n|---|---|---|---|\n${items.map(i=>`| ${i.id} | ${i.applicable} | ${i.status} | ${i.reason} |`).join('\n')}\n\n真实本地能力：合约资金闭环、报告复算、跨语言签名、两个同授权链上提交的成功/拒绝回执、SQLite 跨进程竞争、重启对账、交易结果未知时停止重发、worker 超时退款。应收与提现分别读取，数据库状态不替代链上资金状态。\n\n生产缺口：认证/订单 HTTP/Privy 受限发送已编码并本地测试，真实环境验收待完成；Cleanverse 官方适配、Monad 部署、JEV/planner、Mera/跨设备操作与公开产品交付。localTransactionHashes 均来自临时本地链，不能在 Monad 浏览器复核。\n\n完整证据在 artifacts/acceptance/day3.json；实际交易及余额在 local-escrow-demo.json 与 local-monad-demo.json；Monad 原生合约结果在 monad-contract.json。\n`);
refreshAcceptanceIndex();
console.log(`D3 ${status} (LOCAL_EVM_TEST_DOUBLES_ONLY); evidence: ${directory}/day3.json`);process.exitCode=status==='PASS'?0:1;
