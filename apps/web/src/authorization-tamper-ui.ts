import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {CapsuleError} from '../../../packages/capsule/src/crypto.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {browserSession,type BrowserSession} from './browser-session.js';

export const authorizationTamperControls=`<h2>Inspect authorization integrity</h2><p class="hint">Verify this account’s original permission, change the payee in an in-memory copy and check that the binding rejects it. This is a local validation demonstration, not a live contract rejection. It does not sign or send.</p><button id="test-authorization-tamper" type="button" disabled>Check payee-tampering rejection</button><pre id="authorization-tamper-preview" hidden></pre><p id="authorization-tamper-feedback" role="status" aria-live="polite"></p>`;

const incomplete='The check did not complete because the original permission, account, configuration or connection was not verified. Rejection is not established and no transaction was sent.';
const sameAddress=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
const testPayee=(original:string)=>sameAddress(original,'0x0000000000000000000000000000000000000001')
  ?'0x0000000000000000000000000000000000000002'
  :'0x0000000000000000000000000000000000000001';

/** Uses the historical original-authorization verifier only; it is not chain acceptance evidence. */
export function attachAuthorizationTamperControls(originalPayload:()=>unknown,session:BrowserSession=browserSession){
  const button=document.querySelector<HTMLButtonElement>('#test-authorization-tamper')!,preview=document.querySelector<HTMLElement>('#authorization-tamper-preview')!,feedback=document.querySelector<HTMLElement>('#authorization-tamper-feedback')!;
  let busy=false;
  const connected=()=>button.isConnected&&preview.isConnected&&feedback.isConnected;
  const paint=()=>{if(!connected())return;try{const original=originalPayload();button.disabled=busy||original===undefined||original===null;}catch{button.disabled=true;}};
  button.addEventListener('click',()=>{void(async()=>{
    if(busy||!connected())return;
    busy=true;button.disabled=true;preview.hidden=true;preview.textContent='';feedback.textContent='Verifying the original permission and testing the in-memory payee change…';
    const generation=session.generation;
    try{
      const original=AuthorizationPayloadSchema.parse(originalPayload()),anchor=JSON.stringify(original);
      const active=()=>{if(!connected()||generation!==session.generation||JSON.stringify(AuthorizationPayloadSchema.parse(originalPayload()))!==anchor)throw new Error('SESSION_CHANGED');};
      active();const principal=await session.verified();active();const configuration=await session.configuration();active();
      if(!configuration.recoveryDeployment)throw new Error('RECOVERY_CONFIGURATION_REQUIRED');
      await verifyOriginalAuthorization(original,principal.wallets,configuration.recoveryDeployment);active();
      const changed=structuredClone(original);changed.intent.payee=testPayee(original.intent.payee);
      let rejected=false;
      try{await verifyOriginalAuthorization(changed,principal.wallets,configuration.recoveryDeployment);}
      catch(error){if(error instanceof CapsuleError&&error.message==='RECOVERY_CONTEXT_MISMATCH')rejected=true;else throw error;}
      active();const current=await session.verified();active();
      if(current.subject!==principal.subject||!current.wallets.some(wallet=>sameAddress(wallet,original.intent.buyer)))throw new Error('SESSION_CHANGED');
      if(!rejected)throw new Error('TAMPER_REJECTION_NOT_OBSERVED');
      preview.textContent=JSON.stringify({orderId:original.intent.orderId,contextHash:original.grant.contextHash,testField:'intent.payee',originalPayee:original.intent.payee,testPayee:changed.intent.payee},null,2);preview.hidden=false;
      feedback.textContent='The local authorization binding rejected the payee change. No contract call or transaction was sent; this is not a live onchain rejection test.';
    }catch{
      if(connected()){preview.hidden=true;preview.textContent='';feedback.textContent=incomplete;}
    }finally{busy=false;paint();}
  })();});
  paint();return paint;
}
