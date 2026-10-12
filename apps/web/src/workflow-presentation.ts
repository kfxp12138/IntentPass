import {reportSchema} from '../../../packages/protocol/src/report.js';
import {escapeHtml,icon,transactionLink} from './presentation.js';
import {reportMetrics} from './showcase.js';

export interface WorkflowJobView{id:string;workflow:string;status:string;step:number;stepCount:number;}
const states:Record<string,[string,string]>={QUEUED:['Queued',''],RUNNING:['Running',''],WAITING:['Waiting','amber'],RECONCILING:['Reconciling','amber'],SUCCEEDED:['Completed','success'],FAILED:['Failed','amber'],ATTENTION:['Needs attention','amber'],CANCELLED:['Cancelled','']};
const legacyNames:Record<string,string>={'原报告后台采购与结算':'Original report procurement','自动报告':'Local report','本机报告验证':'Local report check','自动采购与结算':'Automated procurement','SDK 自动采购与结算':'SDK procurement'};
export function workflowCard(job:WorkflowJobView){
  const [label,tone]=states[job.status]??['Unverified','amber'];
  const total=Number.isSafeInteger(job.stepCount)&&job.stepCount>0?job.stepCount:0;
  const completed=Number.isSafeInteger(job.step)&&job.step>=0&&job.step<=total?job.step:0;
  return `<div><div class="workflow-title"><h3>${escapeHtml(Object.hasOwn(legacyNames,job.workflow)?legacyNames[job.workflow]:job.workflow)}</h3><span class="pill ${tone}">${label}</span></div><span class="workflow-id">Task ${escapeHtml(job.id)}</span><div class="workflow-progress"><progress max="${total||1}" value="${completed}" aria-label="Completed workflow steps"></progress><small>${completed} / ${total} steps</small></div><p>${job.status==='RECONCILING'?'Checking the original operation; its dispatch record is retained.':job.status==='SUCCEEDED'?'Workflow completed. Check the result and transaction proof for actual settlement.':'Progress follows the worker’s recorded steps.'}</p></div>`;
}
export function workflowOutputPresentation(outputs:unknown){
  if(!outputs||typeof outputs!=='object'||Array.isArray(outputs))return '<h3>Task output</h3><p>No result is available yet. Open the original record for details.</p>';
  const data=outputs as Record<string,unknown>,report=reportSchema.safeParse(data.report),procurement=data.procurement;
  if(report.success)return `<h3>Report result</h3><p>Worker output · Local computation does not make a payment</p>${reportMetrics(report.data)}`;
  if(procurement&&typeof procurement==='object'&&!Array.isArray(procurement)){
    const result=procurement as Record<string,unknown>;
    if(result.status==='CONFIRMED'&&typeof result.orderId==='string'&&/^0x[0-9a-fA-F]{64}$/.test(result.orderId)&&typeof result.payoutHash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(result.payoutHash))return `<h3>${icon('check')} Original procurement verified</h3><p>Original order ${escapeHtml(result.orderId)}</p>${transactionLink(result.payoutHash,'View original withdrawal')}<p>From this task’s saved confirmation record. Read the chain for current balances.</p>`;
  }
  return '<h3>Task output</h3><p>The original output is retained. Open it for details; no verified payment result is available yet.</p>';
}
