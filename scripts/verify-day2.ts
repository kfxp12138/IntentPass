import {refreshAcceptanceIndex} from './acceptance-index.js';
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';
import {commandExit,completeUnitRun} from './verification-outcome.js';
const base='artifacts/acceptance',startedAt=new Date().toISOString();mkdirSync(base,{recursive:true});
if(existsSync(`${base}/day2.json`)){
  const dir=`${base}/history/${startedAt.replaceAll(':','-')}-D2`;mkdirSync(dir,{recursive:true});
  for(const file of readdirSync(base))if(file==='day2.json'||file.startsWith('day2-')&&file.endsWith('.log'))copyFileSync(`${base}/${file}`,`${dir}/${file}`);
}
const runs=['typecheck','build','test:unit','test:contract:monad'].map(command=>{const start=new Date().toISOString(),result=spawnSync('pnpm',['run',command],{encoding:'utf8',timeout:60000}),evidence=`${base}/day2-${command.replaceAll(':','-')}.log`;writeFileSync(evidence,(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:''));return {command:`pnpm run ${command}`,startedAt:start,endedAt:new Date().toISOString(),exitCode:commandExit(result),evidence};});
const unit=readFileSync(`${base}/day2-test-unit.log`,'utf8'),localOK=runs.every(r=>r.exitCode===0)&&completeUnitRun(unit,86)&&['authenticated HTTP SDK connects signed catalog','browser rejects changed original policy','browser rejects inconsistent PASS','task change or candidate reset','review policy loader rejects blocked or tampered results','purchase SDK validates response'].every(name=>unit.includes(`# Subtest: ${name}`));
const covered=(name:string)=>localOK&&unit.includes(`# Subtest: ${name}`);
const items=[
  {id:'D2-01',status:'BLOCKED',reason:'Chat-compatible planner, fixed intent assembly and fabricated citation rejection are locally tested; no real planner response is available.'},
  {id:'D2-02',status:'BLOCKED',reason:'No real pinned-model missing-license JEV result; local insufficiency control is tested.'},
  {id:'D2-03',status:'BLOCKED',reason:'Ephemeral local signed receipt verifies; real JEV, reviewed confidence calibration and user wallet Grant pending.'},
  {id:'D2-04',status:'BLOCKED',reason:'Local semantic/hard-rule refusal tested; real JEV contradiction and adversarial fixtures pending.'},
  {id:'D2-05',status:covered('unknown, contradictory, low-confidence and failed JEV cannot sign executable receipts')?'PASS':'FAIL',reason:'Local fault injection only: timeout/provider error, missing/malformed results, changed model and low confidence pause without signing.'},
  {id:'D2-06',status:covered('changing the intent payee invalidates its already signed Grant context')&&readFileSync(`${base}/day2-test-contract-monad.log`,'utf8').includes('[PASS] testNonceCannotFundOtherOrder(')?'PASS':'FAIL',reason:'Real ephemeral Grant signatures reject payee-context, amount and chain mutation; native Monad nonce/replay tests pass. This is local cryptographic/contract coverage, not user wallet integration.'},
  {id:'D2-07',status:covered('all 27 semantic combinations obey necessary-condition rules')?'PASS':'FAIL',reason:'All necessary-condition three-state combinations and malformed results checked.'},
];
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
const report={stage:'D2',status:localOK?'BLOCKED':'FAIL',settlementRoute:'context-vote-escrow',scope:'LOCAL_PROVIDER_TEST_DOUBLES_ONLY',commit:revision,worktreeDirty:!!spawnSync('git',['status','--porcelain'],{encoding:'utf8'}).stdout.trim(),environment:{node:process.version,platform:process.platform},startedAt,endedAt:new Date().toISOString(),runs,items,realJevResponses:[],realTransactionHashes:[],requiredActions:['Configure real pinned JEV/planner model access in local secrets.','Run the frozen 12 dev/24 holdout inputs and freeze confidence rules using real judgments.','Verify authenticated UI and implement user-controlled Privy Grant signing.']};
writeFileSync(`${base}/day2.json`,JSON.stringify(report,null,2)+'\n');
writeFileSync('docs/day2-report.md',`# D2 审查服务验收\n\n状态：${report.status}。路线：context-vote-escrow，PACT-inspired，非 IMAS/CDAS。范围：本地供应商测试夹具，不代表真实 JEV/Agent 验收。\n\n基准 commit ${revision}；有未提交修改 ${report.worktreeDirty}；${startedAt} 至 ${report.endedAt}。\n\n| 命令 | 退出码 |\n|---|---|\n${runs.map(r=>`| ${r.command} | ${r.exitCode} |`).join('\n')}\n\n| ID | 状态 | 原因 |\n|---|---|---|\n${items.map(i=>`| ${i.id} | ${i.status} | ${i.reason} |`).join('\n')}\n\n新能力：任务/证据 EIP-712 摘要；严格报价与固定部署/预算/Owner 校验；单次固定版本三问题 JEV 适配；概率分布校验；低确定性及故障暂停；限定期限 PASS 回执签名后再验签；认证并限长的 HTTP 审查入口。新增签名目录、候选/审查 SDK 与页面控制器，本机 HTTP 使用明确模型替身验证。生产配置可接真实 planner；审查需有效冻结规则/开发报告，且仅启用无签名语义结果，不开放资金。\n\n完整证据：artifacts/acceptance/day2.json。生产缺口仍包括真实 planner 调用、冻结样例的实际模型判断、冻结 confidence 规则、真实页面走查和真实钱包签授权。下一入口 apps/web/src/services 与 packages/adapters。\n`);
refreshAcceptanceIndex();
console.log(`D2 ${report.status}; local checks ${localOK?'PASS':'FAIL'}; no real provider evidence.`);process.exitCode=1;
