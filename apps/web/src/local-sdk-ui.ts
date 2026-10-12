import {browserSession,type BrowserSession} from './browser-session.js';
import {LocalSdkReadResultSchema,LocalSdkWorkflowRequestSchema,LocalSdkWorkflowResultSchema} from '../../../packages/protocol/src/local-sdk-read.js';
import {digest} from '../../../packages/protocol/src/schemas.js';
import {verifiedCase} from './showcase.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
export const localSdkControls=`<div class="section-head"><h2>Check an order with the independent SDK</h2><span class="pill">Read only</span></div><p class="hint">Use the current session to run an independent local Node client. Its token stays in an in-memory pipe. This verifies the account and original order without model calls, signatures or payments.</p><label>Original order ID<input id="sdk-order-id" value="${verifiedCase.orderId}" autocomplete="off"></label><button id="check-local-sdk">Check original order</button><label>Workflow ID<input id="sdk-job-id" placeholder="Copy a task ID from Activity" autocomplete="off"></label><button id="check-local-workflow">Check workflow and receipt</button><p id="local-sdk-feedback" role="status" aria-live="polite"></p><pre id="local-sdk-result" hidden></pre><a id="sdk-view-order" class="text-link" href="#orders" hidden>Open the verified snapshot in Orders</a>`;
export function attachLocalSdkControls(session:BrowserSession=browserSession,onRead?:(order:OrderSnapshot)=>void){
  const button=document.querySelector<HTMLButtonElement>('#check-local-sdk')!,input=document.querySelector<HTMLInputElement>('#sdk-order-id')!,feedback=document.querySelector<HTMLElement>('#local-sdk-feedback')!,result=document.querySelector<HTMLElement>('#local-sdk-result')!,view=document.querySelector<HTMLAnchorElement>('#sdk-view-order')!,workflowButton=document.querySelector<HTMLButtonElement>('#check-local-workflow')!,jobInput=document.querySelector<HTMLInputElement>('#sdk-job-id')!;let busy=false,closed=false;
  const active=(generation:number)=>!closed&&feedback.isConnected&&session.generation===generation;
  const unsubscribe=session.onGenerationChange(()=>{if(feedback.isConnected){result.textContent='';result.hidden=true;view.hidden=true;feedback.textContent='';}});
  const run=(workflow=false)=>{if(busy||closed)return;void(async()=>{
    const generation=session.generation;busy=true;button.disabled=true;workflowButton.disabled=true;result.hidden=true;view.hidden=true;feedback.textContent='The independent SDK is checking your session and original order…';
    try{
      const orderId=digest.parse(input.value.trim()),token=await session.token();if(!active(generation))return;
      const request=workflow?LocalSdkWorkflowRequestSchema.parse({orderId,jobId:jobInput.value.trim()}):{orderId};
      const response=await fetch(workflow?'/api/local/sdk-workflow-read':'/api/local/sdk-order-read',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(request),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(55000)});
      if(!response.ok)throw Error('LOCAL_SDK_UNAVAILABLE');const value=(workflow?LocalSdkWorkflowResultSchema:LocalSdkReadResultSchema).parse(await response.json());
      if(!active(generation))return;if('jobId'in value&&value.jobId!==('jobId'in request?request.jobId:undefined))throw Error('JOB_MISMATCH');if(value.order.orderId.toLowerCase()!==orderId.toLowerCase())throw Error('ORDER_MISMATCH');
      const o=value.order;result.textContent=`Original order: ${o.orderId}\nChain state: ${o.state}\nPayee credit remaining: ${o.credits.payee}\nPayee withdrawn: ${o.withdrawn.payee}\nVerified block: ${o.block.number}\nAmounts are in smallest asset units. No transaction was sent.`;result.hidden=false;
      if(onRead){onRead(o as OrderSnapshot);view.hidden=false;}
      feedback.textContent='jobId'in value?`The independent SDK verified task ${value.jobId} as completed, with its original order paid and the payee’s funds withdrawn. This was a read-only check.`:'The independent Node client verified account access and read the original chain snapshot. No permission or payment was sent.';
    }catch{if(active(generation))feedback.textContent='The independent check did not complete. Check your session, original order ID and local service. The order is unchanged.';}
    finally{busy=false;if(!closed&&feedback.isConnected){button.disabled=false;workflowButton.disabled=false;}}
  })();};
  button.addEventListener('click',()=>run());workflowButton.addEventListener('click',()=>run(true));
  return ()=>{closed=true;unsubscribe();};
}
