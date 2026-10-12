import {BrowserSession,browserSession} from './browser-session.js';
import {loginControls,attachLoginControls} from './login-ui.js';
import {CompleteOrderAutomation,type OrderAutomationPhase} from './order-automation.js';
import {DeliveryPrepareRequestSchema} from '../../../packages/protocol/src/fulfillment.js';
export const sellerSession=new BrowserSession(undefined,undefined,{role:'seller'});
export const orderAutomationControls=`<h2>Complete an original funded order</h2><p class="hint">Sign in as the original test provider below. The buyer and provider act as the original committee members. Missing roles stop execution; two votes are required before settlement and withdrawal. Every step continues the same funded order.</p><div id="automation-seller-login">${loginControls}</div><button id="check-automation-roles">Check execution roles</button><p id="automation-role-feedback" role="status"></p><label><input id="agree-order-automation" type="checkbox">I authorize the verified original roles to deliver, recompute, sign and submit both votes, settle and withdraw for this same order. Unknown results are reconciled without another send.</label><button id="run-order-automation" disabled>Confirm and complete this order</button><p id="order-automation-feedback" role="status" aria-live="polite"></p>`;
export function clearAutomationSeller(){return sellerSession.logout();}
export function attachOrderAutomationControls(input:()=>unknown,buyer:BrowserSession=browserSession){
  const sellerRoot=document.querySelector<HTMLElement>('#automation-seller-login')!,check=document.querySelector<HTMLButtonElement>('#check-automation-roles')!,consent=document.querySelector<HTMLInputElement>('#agree-order-automation')!,start=document.querySelector<HTMLButtonElement>('#run-order-automation')!,feedback=document.querySelector<HTMLElement>('#order-automation-feedback')!,roles=document.querySelector<HTMLElement>('#automation-role-feedback')!;
  let ready=false,busy=false,run:CompleteOrderAutomation|undefined,generation=buyer.generation,sellerGeneration=sellerSession.generation;
  const active=()=>{if(!feedback.isConnected||buyer.generation!==generation||sellerSession.generation!==sellerGeneration)throw Error('SESSION_CHANGED');};
  const paint=()=>{start.disabled=busy||!ready||!consent.checked||!!run;check.disabled=busy;consent.disabled=busy;};
  attachLoginControls(()=>{ready=false;roles.textContent='The provider signed out. Check execution roles again.';paint();},sellerSession,{root:sellerRoot});
  const actorCheck=async()=>{
    generation=buyer.generation;sellerGeneration=sellerSession.generation;
    const r=DeliveryPrepareRequestSchema.parse(input()),b=await buyer.verified(),s=await sellerSession.verified(),config=await buyer.configuration();active();const d=config.recoveryDeployment;if(!d)throw Error('AUTOMATION_DEPLOYMENT_REQUIRED');
    const owns=(list:readonly string[],address:string)=>list.some(w=>w.toLowerCase()===address.toLowerCase()),bi=d.committee.findIndex(w=>owns(b.wallets,w)),si=d.committee.findIndex(w=>owns(s.wallets,w));
    if(!owns(b.wallets,r.payload.intent.buyer)||!owns(s.wallets,r.payload.intent.seller)||!owns(s.wallets,r.payload.intent.payee)||bi<0||si<0||bi===si)throw Error('AUTOMATION_ROLE_AUTHORITY_REQUIRED');
    return {seller:sellerSession,members:[{index:bi as 0|1|2,session:buyer},{index:si as 0|1|2,session:sellerSession}] as const,settler:buyer,payee:sellerSession};
  };
  check.addEventListener('click',()=>{if(busy)return;busy=true;paint();void actorCheck().then(()=>{active();ready=true;roles.textContent='Original buyer, provider/payee and two distinct committee members verified. Confirm before continuing execution.';}).catch(()=>{if(feedback.isConnected){ready=false;roles.textContent='Roles are not ready. Sign in as the original buyer and provider, confirm committee membership and load the original funded order.';}}).finally(()=>{busy=false;if(feedback.isConnected)paint();});});
  consent.addEventListener('change',paint);
  start.addEventListener('click',()=>{if(busy||!ready||!consent.checked||run)return;busy=true;paint();void(async()=>{
    const actors=await actorCheck();active();run=new CompleteOrderAutomation(input(),location.origin,actors);
    const labels:Record<OrderAutomationPhase,string>={CHECK_ROLES:'Checking roles and original signatures…',DELIVERY:'Delivering the original report and waiting for finality…',MEMBER_ONE:'Completing the first member’s original acceptance and vote…',MEMBER_TWO:'Completing the second member’s original acceptance and vote…',SETTLEMENT:'Settling and verifying the original allocation…',PAYOUT:'Withdrawing and checking the actual transfer evidence…',COMPLETE:'The original order’s remaining steps and the seller’s actual withdrawal are verified.'};
    await run.run(true,active,phase=>{active();feedback.textContent=labels[phase];});active();consent.checked=false;
  })().catch(()=>{if(feedback.isConnected)feedback.textContent='Execution is not fully confirmed. Original roles and records are retained. Reconcile the original delivery, votes, allocation or withdrawal; no automatic duplicate send will occur.';}).finally(()=>{busy=false;if(feedback.isConnected)paint();});});
  paint();
}
