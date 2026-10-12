import {MemoryPayloadSchema,TaskInputSchema} from '../../../packages/capsule/src/format.js';
import {TaskPolicySchema} from '../../../packages/protocol/src/schemas.js';
import {createReport} from '../../../packages/protocol/src/report.js';
import {readSalesBrief} from '../../../packages/protocol/src/sales-brief.js';
import {createEvidenceSalt} from '../../../packages/protocol/src/review-evidence.js';
import {keccak256,toHex} from 'viem';

export interface ConfirmedTask {
  policy:ReturnType<typeof TaskPolicySchema.parse>;
  taskInput:ReturnType<typeof TaskInputSchema.parse>;
  evidence:{schemaVersion:2;salt:string;taskText:string;documents:[]};
}
export interface TaskControlsPort {current:()=>unknown;locked:()=>boolean;confirm:(task:ConfirmedTask)=>void;}
export interface TaskSourceAdapter {read:()=>{dataset:number[];describe:(datasetHash:string)=>string}|undefined;lock:(value:boolean)=>void;}
const lockedMessage='An original permission is signed, pending or awaiting reconciliation. The task is read-only; continue in Evidence review or Orders.';
/** Render original RAM values without generating a new task, salt or permission. */
export function attachTaskControls(port:TaskControlsPort,source?:TaskSourceAdapter){
  const form=document.querySelector<HTMLFormElement>('#task-form')!,feedback=document.querySelector<HTMLElement>('#feedback')!,button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const names=['dataset','buyer','seller','asset','budget'] as const;
  const fields=Object.fromEntries(names.map(name=>[name,form.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[name="${name}"]`)!])) as Record<typeof names[number],HTMLInputElement|HTMLTextAreaElement>;
  const current=port.current(),memory=MemoryPayloadSchema.safeParse({schemaVersion:1,kind:'memory',...(current&&typeof current==='object'?current:{})});
  if(memory.success&&memory.data.taskInput&&createReport(memory.data.taskInput.dataset).datasetHash.toLowerCase()===memory.data.policy.datasetHash.toLowerCase()){
    const {taskInput,policy}=memory.data;fields.dataset.value=JSON.stringify(taskInput.dataset);fields.buyer.value=taskInput.buyer;fields.seller.value=taskInput.seller;fields.asset.value=policy.allowedAsset;fields.budget.value=policy.budget;
    feedback.textContent='This is your confirmed task. Changes require confirmation; navigation does not trigger a new review or permission.';
  }
  const lock=()=>{const value=port.locked();for(const field of Object.values(fields))field.disabled=value;source?.lock(value);button.disabled=value;if(value)feedback.textContent=lockedMessage;return value;};lock();
  form.addEventListener('submit',event=>{
    event.preventDefault();if(lock())return;
    try{
      const input=source?.read();
      const taskInput=TaskInputSchema.parse({dataset:input?.dataset??JSON.parse(fields.dataset.value),buyer:fields.buyer.value,seller:fields.seller.value});
      const datasetHash=createReport(taskInput.dataset).datasetHash;
      const taskText=input?.describe(datasetHash)??`Generate count, sum, min and max for dataset ${datasetHash}, with permission for commercial use.`;
      const latest=port.current(),original=MemoryPayloadSchema.safeParse({schemaVersion:1,kind:'memory',...(latest&&typeof latest==='object'?latest:{})});
      const previousSales=original.success&&original.data.taskInput&&readSalesBrief(original.data.evidence.taskText,original.data.taskInput.dataset);
      const sameDescription=(!input&&!previousSales)||original.success&&original.data.evidence.taskText===taskText;
      if(sameDescription&&original.success&&original.data.evidence.schemaVersion===2&&original.data.taskInput&&JSON.stringify(taskInput.dataset)===JSON.stringify(original.data.taskInput.dataset)&&taskInput.buyer.toLowerCase()===original.data.taskInput.buyer.toLowerCase()&&taskInput.seller.toLowerCase()===original.data.taskInput.seller.toLowerCase()&&fields.asset.value.toLowerCase()===original.data.policy.allowedAsset.toLowerCase()&&fields.budget.value===original.data.policy.budget){
        if(lock())return;feedback.textContent='The task is unchanged. Its original identifier and evidence are retained; no new review or permission was created.';return;
      }
      const policy=TaskPolicySchema.parse({schemaVersion:1,taskId:keccak256(toHex(crypto.randomUUID())),datasetHash:createReport(taskInput.dataset).datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:fields.budget.value,allowedAsset:fields.asset.value,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'});
      if(lock())return;
      port.confirm({policy,taskInput,evidence:{schemaVersion:2,salt:createEvidenceSalt(),taskText,documents:[]}});
      feedback.textContent='Task confirmed in page memory. Continue to Evidence review or Activity. No permission or payment has been sent.';
    }catch{feedback.textContent='Check the dataset, wallet addresses and budget in smallest units.';}
  });
}
