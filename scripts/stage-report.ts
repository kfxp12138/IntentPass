import {writeFileSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';

export function archiveStageReport(stage:string,startedAt:string){
  const path=`docs/${stage.toLowerCase().replace(/^d/, 'day')}-report.md`;
  if(existsSync(path)){
    const history=`artifacts/acceptance/history/${startedAt.replaceAll(':','-')}-${stage}`;
    mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/${stage.toLowerCase().replace(/^d/, 'day')}-report.md`);
  }
}

type StageReport={stage:string;route:string;status:string;commit:string|null;worktreeDirty:boolean;startedAt:string;endedAt:string;scope?:string;deterministicChecks:string;runs:{command:string;exitCode:number|null;evidence:string}[];acceptance:{id:string;status:string;reason?:string;scope?:string;evidence?:string}[];releaseReview?:{scope:string;status:string};manualReview?:{scope:string;status:string}};
/** Summarize actual verifier output; do not read configuration values or promote local checks. */
export function writeStageReport(report:StageReport){
  const cell=(value:unknown)=>String(value??'—').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
  const rows=(values:unknown[][])=>values.map(row=>`| ${row.map(cell).join(' | ')} |`).join('\n');
  const pending=report.acceptance.filter(item=>item.status!=='PASS').map(item=>`${item.id}=${item.status}`).join('、');
  const review=report.manualReview??report.releaseReview;
  const manual=review?`\n\n${report.stage}人工记录范围：${cell(review.scope)}；记录检查状态：${cell(review.status)}。固定断言及公共原文件字节完整性不证明操作员、实际提供方、公开访问、资金或物理设备来源；本阶段通过也不代表整个目标完成。`:'';
  writeFileSync(`docs/${report.stage.toLowerCase().replace(/^d/, 'day')}-report.md`,
    `# ${report.stage} 实际验收报告\n\n路线：${report.route}（PACT-inspired，非 IMAS/CDAS）。总体状态：${report.status}；本地确定性检查：${report.deterministicChecks}。\n\n源码基准：${report.commit??'未取得'}；运行前工作区有修改：${report.worktreeDirty}。开始：${report.startedAt}；结束：${report.endedAt}。\n\n| 实际命令 | 退出码 | 证据 |\n|---|---|---|\n${rows(report.runs.map(run=>[run.command,run.exitCode,run.evidence]))}\n\n| 验收 ID | 状态 | 范围或原因 | 证据 |\n|---|---|---|---|\n${rows(report.acceptance.map(item=>[item.id,item.status,item.reason??item.scope,item.evidence]))}\n\n完整机器记录：artifacts/acceptance/${report.stage.toLowerCase().replace(/^d/, 'day')}.json。原始日志和历史证据以该 JSON 的路径为准。本地测试、声明的链接和文件存在不能证明真实提供方、公开部署、实际到账或物理设备操作。${manual}\n\n本阶段仍未通过项：${pending||'无；仍须按上述证据范围核对，不推定其他阶段完成'}。具体缺口与原因在逐ID表和原JSON中，不能固定推定某项凭据始终缺失。秘密仅配置在本机服务端，不写公开报告。\n\n下一入口：补齐具体缺口后重新运行本阶段入口并保存真实证据；本报告不把尚缺的真实验收改成通过。\n`);
}
