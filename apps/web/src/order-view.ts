import {IntentPassClient} from '../../../packages/protocol/src/index.js';
import {OrderSnapshotSchema,type OrderSnapshot,type OrderState} from '../../../packages/protocol/src/escrow-read.js';
import {browserSession,BrowserSession} from './browser-session.js';
import {icon,escapeHtml} from './presentation.js';
export const stateLabels:Record<OrderState,string>={UNREGISTERED:'Not funded',FUNDED:'Funded · awaiting delivery',EVIDENCE_FROZEN:'Delivered · awaiting acceptance',CERTIFIED:'Certified · awaiting allocation',ALLOCATED_PAID:'Payment allocated',ALLOCATED_REFUND:'Refund allocated',ALLOCATED_COMPENSATION:'Compensation allocated'};
export function orderSnapshotPresentation(order:OrderSnapshot){
  const stages:[string,boolean][]=[['Funding',order.state!=='UNREGISTERED'],['Delivery',['EVIDENCE_FROZEN','CERTIFIED','ALLOCATED_PAID'].includes(order.state)],['Acceptance',['CERTIFIED','ALLOCATED_PAID'].includes(order.state)],['Allocation',order.state.startsWith('ALLOCATED_')],['Withdrawal',BigInt(order.withdrawn.buyer)+BigInt(order.withdrawn.payee)>0n]];
  return `<div class="order-overview"><span class="pill">${stateLabels[order.state]}</span><div class="order-stages">${stages.map(([label,done])=>`<span class="order-stage ${done?'done':''}">${done?icon('check'):''}${label}</span>`).join('')}</div><div class="order-amounts"><div><span>Payee credit remaining</span><strong>${escapeHtml(order.credits.payee)}</strong><small>Smallest units · ${order.credits.payee==='0'?'No remaining credit':'Awaiting withdrawal'}</small></div><div><span>Payee total withdrawn</span><strong>${escapeHtml(order.withdrawn.payee)}</strong><small>Smallest units · chain snapshot</small></div></div><p class="hint">Verified block ${escapeHtml(order.block.number)}. Credits, allocation and withdrawal are recorded separately. Original order details are retained below.</p></div>`;
}
export function checkOrderSnapshotContinuation(anchor:OrderSnapshot,current:OrderSnapshot){
  for(const key of ['chainId','arbiter','asset','orderId','contextHash','buyer','seller','payee','price','bond','deliveryDeadline','settlementDeadline','datasetHash','serviceTermsHash'] as const)if(current[key].toLowerCase()!==anchor[key].toLowerCase())throw new Error('ORDER_ANCHOR_CHANGED');
  if(BigInt(current.block.number)<BigInt(anchor.block.number)||current.block.number===anchor.block.number&&current.block.hash.toLowerCase()!==anchor.block.hash.toLowerCase())throw new Error('ORDER_SNAPSHOT_STALE');
  if(anchor.state.startsWith('ALLOCATED_')&&current.state!==anchor.state)throw new Error('ORDER_TERMINAL_CHANGED');
  return current;
}
export async function refreshRestoredOrder(anchor:OrderSnapshot,session:BrowserSession=browserSession,read?:(id:string,token:string)=>Promise<OrderSnapshot>) {
  const generation=session.generation,principal=await session.verified();
  if(!principal.wallets.some(wallet=>wallet.toLowerCase()===anchor.buyer.toLowerCase()))throw new Error('ORDER_ACCESS_DENIED');
  const token=await session.token(),current=OrderSnapshotSchema.parse(await(read?read(anchor.orderId,token):new IntentPassClient(location.origin,token).order(anchor.orderId))) as OrderSnapshot;
  if(generation!==session.generation)throw new Error('SESSION_CHANGED');
  return checkOrderSnapshotContinuation(anchor,current);
}
export function attachOrderView(original:OrderSnapshot,onRefresh:(order:OrderSnapshot)=>void,refresh?:()=>Promise<OrderSnapshot>) {
  const detail=document.querySelector<HTMLElement>('#order-detail')!,feedback=document.querySelector<HTMLElement>('#order-feedback')!,button=document.querySelector<HTMLButtonElement>('#refresh-order')!;
  const overview=document.querySelector<HTMLElement>('#order-overview');
  const show=(order:OrderSnapshot)=>{if(overview)overview.innerHTML=orderSnapshotPresentation(order);detail.textContent=`Original order: ${order.orderId}\nState: ${stateLabels[order.state]}\nBuyer credit remaining: ${order.credits.buyer}\nPayee credit remaining: ${order.credits.payee}\nBuyer withdrawn: ${order.withdrawn.buyer}\nPayee withdrawn: ${order.withdrawn.payee}\nVerified block: ${order.block.number}\nAmounts are in smallest units. Credit does not establish receipt.`;};
  let current=original;show(current);
  button.addEventListener('click',()=>{void(async()=>{button.disabled=true;feedback.textContent='Reading the latest finalized chain state…';try{const order=await(refresh?refresh():refreshRestoredOrder(current));if(!detail.isConnected)return;current=order;onRefresh(order);show(order);feedback.textContent='Original order state verified. No transaction was sent.';}catch{feedback.textContent='The latest state could not be verified. Check your session and connection. The previous snapshot is retained and is not a current confirmation.';}finally{button.disabled=false;}})();});
}
