import {browserSession,type BrowserSession} from './browser-session.js';
import {LocalTaskContextSchema} from '../../../packages/protocol/src/local-sdk-read.js';
export const taskContextControls='<button type="button" id="read-task-context">Use connected buyer details</button><a class="text-link" href="#automation">Check account</a><p id="task-context-feedback" role="status" aria-live="polite"></p>';
export function attachTaskContextControls(locked:()=>boolean,session:BrowserSession=browserSession){
  const button=document.querySelector<HTMLButtonElement>('#read-task-context')!,feedback=document.querySelector<HTMLElement>('#task-context-feedback')!,form=document.querySelector<HTMLFormElement>('#task-form')!;
  const names=['buyer','seller','asset'] as const,fields=Object.fromEntries(names.map(name=>[name,form.querySelector<HTMLInputElement>(`[name="${name}"]`)!])) as Record<typeof names[number],HTMLInputElement>;
  let busy=false;
  const active=(generation:number)=>feedback.isConnected&&session.generation===generation&&!locked();
  button.disabled=locked();
  button.addEventListener('click',()=>{if(busy||locked())return;void(async()=>{
    const generation=session.generation,original=Object.values(fields).map(f=>f.value);let failureCode='LOGIN_REQUIRED';busy=true;button.disabled=true;feedback.textContent='Checking the buyer and local configuration…';
    try{
      const token=await session.token();if(!active(generation))return;
      const response=await fetch('/api/automation/workflows',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({action:'context'}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
      failureCode=`HTTP_${response.status}`;if(!response.ok)throw Error('CONTEXT_UNAVAILABLE');const raw=await response.json();if(raw?.code==='WORKFLOW_BUYER_CONTEXT_UNAVAILABLE')failureCode=raw.code;else failureCode='CONTEXT_RESPONSE_INVALID';const context=LocalTaskContextSchema.parse(raw);
      if(!active(generation))return;if(Object.values(fields).some((f,i)=>f.value!==original[i])){feedback.textContent='Your inputs changed. The returned configuration did not overwrite them.';return;}
      fields.buyer.value=context.buyer;fields.seller.value=context.seller;fields.asset.value=context.asset;
      feedback.textContent='Buyer, provider and token filled in. Your dataset and budget are unchanged. Check them before confirming; no permission or payment was sent.';
    }catch{if(active(generation))feedback.textContent=`Configuration could not be verified. Sign in as the original buyer and check the local connection. The task is unchanged. Reference: ${failureCode}。`;}
    finally{busy=false;if(feedback.isConnected){button.disabled=locked();if(locked())feedback.textContent='The original permission is locked. Its task was not replaced.';}}
  })();});
}
