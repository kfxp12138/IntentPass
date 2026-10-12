import type {PurchaseFlow} from './purchase-flow.js';
export const receiptRecoveryControls=`<h3>继续已审查的原候选</h3><p class="hint">恢复文件只包含原订单的公开承诺字段。先恢复同一任务密文，再导入原候选；不会调用模型或生成新订单。</p><label>原候选恢复文件<input id="original-candidate-file" type="file" accept="application/json,.json"></label><button id="restore-original-candidate" type="button">导入原候选并核对旧审查</button><p id="receipt-validity" role="status" aria-live="polite"></p><button id="read-original-receipt" type="button" disabled>只读核对原回执</button><label><input id="ready-original-receipt" type="checkbox">我已准备好马上签署并完成设备确认，同意为同一原单申请新的最长5分钟回执。</label><button id="renew-original-receipt" type="button" disabled>确认准备好并申请原单新回执</button><label><input id="agree-reschedule" type="checkbox">我确认保留旧原单记录，为同一需求开始新的30分钟交付窗口；预算、数据集、商业用途和收款方保持。</label><button id="start-rescheduled-purchase" type="button" disabled>确认新安排并开始采购窗口</button><p id="receipt-recovery-feedback" role="status" aria-live="polite"></p><p class="hint">复用已保存的通过判断，不重复请求模型。原报价、原订单和原证据不变；过期报价、已入金或未知签署结果须先处理。新回执不会自动授权、批准资产或付款。</p>`;
export function attachReceiptRecoveryControls(flow:PurchaseFlow,run:(work:()=>Promise<void>)=>Promise<void>,changed:(resultChanged:boolean)=>void,clock=()=>BigInt(Math.floor(Date.now()/1000)),isBusy=()=>false,onTask?:(task:unknown)=>void){
  const file=document.querySelector<HTMLInputElement>('#original-candidate-file')!,restore=document.querySelector<HTMLButtonElement>('#restore-original-candidate')!,read=document.querySelector<HTMLButtonElement>('#read-original-receipt')!,renew=document.querySelector<HTMLButtonElement>('#renew-original-receipt')!,ready=document.querySelector<HTMLInputElement>('#ready-original-receipt')!,feedback=document.querySelector<HTMLElement>('#receipt-recovery-feedback')!,validity=document.querySelector<HTMLElement>('#receipt-validity')!;
  const agreeReschedule=document.querySelector<HTMLInputElement>('#agree-reschedule')!,start=document.querySelector<HTMLButtonElement>('#start-rescheduled-purchase')!;
  let unknown=false,busy=false;
  const paint=()=>{
    const r=flow.reviewResult,locked=flow.authorizationLocked,now=clock(),working=busy||isBusy();
    read.disabled=working||locked||!flow.draft;restore.disabled=working||locked||!!flow.draft;ready.disabled=working||locked;
    renew.disabled=working||locked||unknown||!ready.checked||!r||r.source!=='JEV'||!r.executable||now<BigInt(r.receipt.expiresAt)||!flow.draft||now>=BigInt(flow.draft.quote.expiresAt)||now>=BigInt(flow.draft.intent.deliveryDeadline);
    start.disabled=working||locked||unknown||!onTask||!agreeReschedule.checked||!flow.draft||!r||r.source!=='JEV'||!r.executable||now<BigInt(flow.draft.intent.deliveryDeadline)||now>=BigInt(flow.draft.quote.expiresAt);
    agreeReschedule.disabled=working||locked;
    if(r?.source==='JEV'&&r.executable){const left=BigInt(r.receipt.expiresAt)-now;validity.textContent=left>0n?`原单回执还剩 ${left} 秒，可在此期限内完成授权与入金。`:'原单回执已过期。通过判断仍保留；旧权限不能继续签署或入金。先核对原回执，准备好后再明确申请。';}
    else validity.textContent='尚无可执行的原单回执。';
  };
  const action=(work:()=>Promise<void>)=>{if(busy||isBusy())return;busy=true;paint();void run(async()=>{try{await work();}finally{busy=false;changed(true);paint();}}).catch(()=>{busy=false;paint();});};
  restore.addEventListener('click',()=>action(async()=>{const selected=file.files?.[0];if(!selected||selected.size>100000){feedback.textContent='请选择原候选恢复文件。';return;}await flow.resumeOriginal(JSON.parse(await selected.text()));feedback.textContent='已核对同一原候选与旧审查。没有重复调用模型或生成授权。';}));
  const recover=(confirmation:boolean)=>action(async()=>{
    if(confirmation&&!ready.checked)return;try{const result=await flow.recoverReceipt(confirmation);unknown=result.status==='PENDING'||result.status==='UNKNOWN';ready.checked=false;
      feedback.textContent=result.status==='SIGNED'?(clock()<BigInt(result.receipt.expiresAt)?'原单回执已核对并有效。请马上准备、核对并签署本单权限。':'已核对过期原回执及保留的通过判断。准备好后可明确申请新回执。'):`已停止：${result.code}。请只读核对原记录。`;
    }catch(error){if(confirmation)unknown=true;feedback.textContent=confirmation?'签发结果未确认，请只读核对原回执，暂不再次申请。':'无法读取原回执，请检查登录和连接。';throw error;}
  });
  read.addEventListener('click',()=>recover(false));renew.addEventListener('click',()=>recover(true));ready.addEventListener('change',paint);
  agreeReschedule.addEventListener('change',paint);start.addEventListener('click',()=>action(async()=>{if(!agreeReschedule.checked||!onTask)return;const quoteId=flow.draft?.quote.quoteId;if(!quoteId)return;await flow.rescheduleOriginal(true,onTask);agreeReschedule.checked=false;const candidate=await flow.propose([quoteId]);feedback.textContent=candidate.status==='DRAFT'?'新采购窗口已开始，原任务编号和原数据保留。请核对新候选并审查一次。':'本次候选未生成。新策略版本已保留，尚未审核、授权或付款。';}));
  const timer=setInterval(()=>{if(!validity.isConnected){clearInterval(timer);return;}paint();changed(false);},1000);if(typeof timer==='object'&&'unref' in timer)timer.unref();paint();
  return {refresh:paint,dispose:()=>clearInterval(timer)};
}
