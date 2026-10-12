import {refreshAcceptanceIndex} from './acceptance-index.js';
import {settlementRoute} from '../packages/protocol/src/route.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
const day=Number(process.argv[2]);
if(!Number.isInteger(day)||day<1||day>7) throw new Error('Expected day 1–7');
if(day!==1) { console.error(JSON.stringify({day,status:'NOT_STARTED',reason:'Current stage is D1; later-stage acceptance not implemented.'}));process.exit(1); }
const startedAt=new Date().toISOString();
mkdirSync('artifacts/acceptance',{recursive:true});
if(existsSync('artifacts/acceptance/day1.json')) {
  const history=`artifacts/acceptance/history/${startedAt.replaceAll(':','-')}`;
  mkdirSync(history,{recursive:true});
  for(const name of readdirSync('artifacts/acceptance')) {
    if(name==='day1.json'||name.startsWith('day1-')&&name.endsWith('.log')) copyFileSync(`artifacts/acceptance/${name}`,`${history}/${name}`);
  }
}
const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
const worktree=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const runs: {command:string;startedAt:string;endedAt:string;exitCode:number|null;signal:NodeJS.Signals|null;evidence:string}[]=[];
for(const command of ['typecheck','build','test:unit','test:contract','demo:local','doctor']) {
  const start=new Date().toISOString();
  const result=spawnSync('pnpm',['run',command],{encoding:'utf8',timeout:180_000});
  const path=`artifacts/acceptance/day1-${command.replaceAll(':','-')}.log`;
  writeFileSync(path,(result.stdout??'')+(result.stderr??'')+(result.error ? '\n'+result.error.message : ''));
  runs.push({command:`pnpm run ${command}`,startedAt:start,endedAt:new Date().toISOString(),exitCode:result.status,signal:result.signal,evidence:path});
  console.log(`${command}: exit ${result.status}`);
}
const pass=(name:string)=>runs.find(r=>r.command===`pnpm run ${name}`)?.exitCode===0;
const items=[
  {id:'D1-01',status:pass('build')&&pass('test:unit')?'BLOCKED':'FAIL',reason:'Local build and HTTP smoke covered; public HTTPS deployment missing.'},
  {id:'D1-02',status:pass('typecheck')&&pass('test:contract')&&pass('demo:local')?'PASS':'FAIL',reason:'Approved context-vote-escrow: fixed vectors and TS-to-contract local transaction flow verified.'},
  {id:'D1-03',status:'BLOCKED',reason:'Real JEV and planner credentials/model configuration not supplied.'},
  {id:'D1-04',status:'BLOCKED',reason:'Privy app, wallet, actual policy and positive/negative transaction evidence missing.'},
  {id:'D1-05',status:'BLOCKED',reason:'Mera HTTPS rpId and two-device same-Passkey human smoke missing.',mode:'MANUAL'},
  {id:'D1-06',status:'BLOCKED',reason:'Official Cleanverse documentation access, ABI, identity, asset and custody eligibility missing.'},
  {id:'D1-07',status:'PASS',reason:'Owner authorized original Monad implementation without PACT source; see ADR-008.'},
];
const report={stage:'D1',worktreeDirty:worktree.status!==0||!!worktree.stdout.trim(),settlementRoute,commit:commit.status===0?commit.stdout.trim():null,environment:{node:process.version,platform:process.platform,publicUrl:null},startedAt,endedAt:new Date().toISOString(),status:items.some(i=>i.status==='FAIL')?'FAIL':'BLOCKED',runs,items,transactionHashes:[],requiredActions:['Provide server-only credentials via local environment file.','Provide official Cleanverse ABI/addresses and custody rules.','Configure HTTPS rpId and perform real same-Passkey device A/B test.']};
writeFileSync('artifacts/acceptance/day1.json',JSON.stringify(report,null,2)+'\n');
writeFileSync('docs/day1-report.md',`# D1 实际验收报告\n\n阶段：D1；状态：${report.status}；结算路线：${settlementRoute}（PACT-inspired，非 IMAS/CDAS）。\n\n开始：${startedAt}；结束：${report.endedAt}。\n当前代码基准 commit：${report.commit??'尚无提交'}；运行时工作区有修改：${report.worktreeDirty}。\n\n| 命令 | 退出码 | 证据 |\n|---|---|---|\n${runs.map(r=>`| ${r.command} | ${r.exitCode} | ${r.evidence} |`).join('\n')}\n\n| 验收 ID | 状态 | 未完成原因 |\n|---|---|---|\n${items.map(i=>`| ${i.id} | ${i.status} | ${i.reason} |`).join('\n')}\n\n真实能力：本地四页骨架、内存任务确认、严格 schema、策略/intent/报价/回执/Grant 哈希、独立签名域与 EOA 签名验证、TS/Solidity 编码向量、三态聚合、独立 health 客户端、原创托管、授权编译器、报告复算、本地资金演示。本地签名测试使用临时随机测试密钥，不是用户钱包或真实审查回执。\n\n尚不能：真实 planner/JEV 审核、真实用户钱包授权、公开网络资金动作、CVI/CVA、Passkey 跨设备恢复、生产部署。local-escrow-demo.json 只有本地 EVM 测试交易哈希，不是 Monad 交易。\n\n补充历史证据：day1-browser.json / day1-preview.png / day1-reproduction.json（仅上一代码版本本地骨架，不代表真实集成）。\n\n命令偏差：pnpm 11.25.0 有内置 doctor；本项目诊断使用 pnpm run doctor。既有验收输出自动归档于 artifacts/acceptance/history，不删除先前运行结果。\n\n下一入口：提供外部输入后先运行 pnpm run doctor；继续真实接入与 Monad 部署。不要将本报告视为 D1 通过。\n`);
refreshAcceptanceIndex();
console.log(`D1 ${report.status}; evidence: artifacts/acceptance/day1.json`);
process.exitCode=1;
