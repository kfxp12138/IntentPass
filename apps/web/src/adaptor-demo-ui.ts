import {keccak256,toHex} from 'viem';
import {adaptorSalesRecording as recording} from './generated/adaptor-sales-recording.js';
import {inspectRecordedBindings} from '../../../packages/protocol/src/adaptor-recording.js';
import {usd} from '../../../packages/protocol/src/sales-brief.js';
import {escapeHtml as esc,icon} from './presentation.js';

export const adaptorDemoPage=`<div class="page-heading"><div><span class="eyebrow">THE INTENTPASS DEMO</span><h1>The right report.<br><span>The wrong rights.</span></h1><p class="intro">Your agent found a service. Should it buy?<br>Follow the same intent through two very different offers.</p></div><span class="pill outline">Interactive evidence replay</span></div>
<div class="demo-scope">${icon('code')}<p><strong>Real signature cryptography. Simulated JEV answers.</strong> Replay a recorded local experiment with sample sales data. This demo creates no order, signs no wallet permission and moves no funds.</p></div>
<section class="demo-intent"><span class="eyebrow">ONE USER INTENT</span><blockquote>“Buy a sales summary for my store’s commercial business update. Use my September 1–14 data, include the four verified figures, and spend no more than 0.000010 IPTEST.”</blockquote><div class="demo-facts"><span><strong>14 days</strong> of sample sales</span><span><strong>${usd(recording.sales.report.sum)}</strong> sample revenue</span><span><strong>Commercial use</strong> required</span></div></section>
<div id="adaptor-demo"></div>
<section class="demo-takeaway"><span class="eyebrow">WHAT THE DEMO ESTABLISHES</span><h2>Bind the decision to the purchase.</h2><p>JEV evaluates whether the offer supports the intent. The experimental signature package binds the original order and the recorded review result. Changing either breaks verification.</p><p class="hint">The local IntentPass reviewer signs the result; this is not a signature from JEV or a proof that its judgment is correct. The native adaptor proof was checked when this recording was generated. Browser checks cover the recorded EIP-712 signatures and commitments, not current authorization.</p><a class="text-link" href="#proof">Inspect the separate historical Monad purchase ${icon('arrow')}</a><p class="hint">That earlier purchase uses the existing settlement protocol. This adaptor experiment is not installed in the deployed escrow.</p></section>`;

type Outcome='PASS'|'REJECT';
const titles=['The user’s intent','The agent’s offer','The review decision','The signature outcome'];
export function attachAdaptorDemo(root:HTMLElement=document.querySelector<HTMLElement>('#adaptor-demo')!){
  let outcome:Outcome='PASS',step=0,inspection:boolean|undefined,busy=false,message='',version=0,disposed=false;
  const selected=()=>recording.cases.find(c=>c.decision===outcome)!;
  function render(){
    const item=selected(),pass=outcome==='PASS';
    const rights=pass?'“This exact report explicitly permits commercial use, including commercial redistribution.”':'“This exact report is for personal, non-commercial use only. Commercial use and redistribution are prohibited.”';
    root.innerHTML=`<div class="demo-scenarios" role="group" aria-label="Choose a demo"><button data-demo="pass" class="demo-choice ${pass?'selected':''}" aria-pressed="${pass}"><span class="demo-choice-label">01 / PASS</span><strong>The offer matches the intent</strong><span>The seller explicitly grants commercial report rights.</span></button><button data-demo="reject" class="demo-choice ${pass?'':'selected'}" aria-pressed="${!pass}"><span class="demo-choice-label">02 / REJECT</span><strong>The offer contradicts the intent</strong><span>The report is useful, but its license forbids the intended use.</span></button></div>
    <div class="demo-workbench"><section class="demo-stage"><div class="section-head"><span class="eyebrow">${step===0?'READY TO REPLAY':`STEP ${step} OF 4`}</span><span class="pill ${pass?'outline':'amber'}">${outcome} scenario</span></div><h2>${step===0?'A relevant service is only the start.':titles[step-1]}</h2>
    ${step===0?'<p>Both offers compute the same four figures, charge the same fee and concern the same sample data. The difference is the right to use the report.</p><p>Walk through the evidence to see why only one gets a completed signature.</p>':''}
    ${step===1?'<p>The buyer needs a commercial-use report: reporting days, total revenue, lowest day and highest day. The budget and dataset are fixed before review.</p><div class="demo-bound"><span>Intent</span><span>Dataset</span><span>Budget</span><span>Exact order</span></div><p class="hint">An adaptor pre-signature is prepared for this candidate before the simulated provider returns.</p>':''}
    ${step===2?`<p>The proposed service satisfies the computation requirement. Now inspect the rights attached to this specific signed quote.</p><blockquote class="demo-license ${pass?'':'forbidden'}">${rights}</blockquote><details class="disclosure"><summary>Read the exact signed service terms</summary><div class="disclosure-body"><p>${esc(item.request.quote.serviceTerms)}</p></div></details>`:''}
    ${step===3?`<p>${pass?'All three review questions are supported by the supplied evidence.':'The computation fits, and the evidence belongs to this offer. But the commercial-use requirement is explicitly contradicted.'}</p><div class="demo-checks">${[['service','Report matches the task'],['purpose','Commercial use is permitted'],['provenance','Evidence belongs to this offer']].map(([key,label])=>{const answer=item.evaluation!.answers![key as 'service'|'purpose'|'provenance'];return `<div><span>${label}</span><strong class="${answer.choice==='CONTRADICTED'?'demo-denied':''}">${esc(answer.choice)}</strong></div>`;}).join('')}</div><p class="hint">These are recorded synthetic answers through the existing review controller, not a live JEV request.</p>`:''}
    ${step===4?`<div class="demo-outcome ${pass?'':'denied'}"><span class="eyebrow">${outcome}</span><h3>${pass?(busy?'Checking recorded signatures…':inspection?'Bound. Completed. Inspectable.':'Recorded verification failed.'):'No completion. No purchase.'}</h3><p>${pass?'The completed candidate signature and a separate signed review statement bind this order to its exact recorded result.':'The controller stops the session. No completed signature or release certificate is issued, and the experiment sends no transaction.'}</p></div>${pass?`<div class="demo-tamper"><strong>Try to change the story</strong><p>Check a modified copy against the original signed transcript.</p><div class="demo-tamper-actions"><button class="button-secondary" data-demo="order" ${busy?'disabled':''}>Replace the order</button><button class="button-secondary" data-demo="result" ${busy?'disabled':''}>Alter the review result</button><button class="button-secondary" data-demo="original" ${busy?'disabled':''}>Verify original</button></div></div>`:'<p class="hint">If the terms were merely missing, the third outcome would be ABSTAIN: pause for more evidence instead of treating silence as permission.</p>'}`:''}
    <div class="demo-controls">${step<4?`<button data-demo="next">${step===0?`Replay ${outcome}`:'Next step'} ${icon('arrow')}</button>`:'<button data-demo="reset" class="button-secondary">Replay from the start</button>'}${step>0?'<button data-demo="back" class="button-secondary">Back</button>':''}</div><p class="demo-feedback" role="status" aria-live="polite">${esc(message)}</p></section>
    <aside class="demo-transcript"><span class="eyebrow">RECORDED EXECUTION</span><h3>Intent → review → signature</h3><ol>${titles.map((label,i)=>`<li class="${step>i?'reached':''}"><span>${String(i+1).padStart(2,'0')}</span><div><strong>${label}</strong><small>${step>i?['Original candidate committed','Signed terms inspected',`${outcome} · simulated JEV`,pass?'Completion recorded':'Session stopped'][i]:'Waiting for replay'}</small></div></li>`).join('')}</ol><div class="demo-transcript-footer"><span>WALLET TRANSACTIONS</span><strong>0</strong><small>Recorded ${esc(recording.createdAt.slice(0,10))} · experiment keys only</small></div><details><summary>Inspect the public transcript</summary><div class="demo-record-actions"><button data-demo="download" class="button-secondary">Download evidence JSON</button></div><p>Session</p><code>${esc(item.preparation.candidate.sessionId)}</code><p>State</p><code>${step===4?esc(item.state):'Replay in progress'}</code><p>Signed deadline (historical)</p><code>${esc(new Date(Number(item.preparation.candidate.expiresAt)*1000).toISOString())}</code></details></aside></div>`;
  }
  async function check(kind:'original'|'order'|'result'){
    const turn=++version;busy=true;message='Checking the recorded signature bindings…';render();
    try{
      const original=selected(),proof=structuredClone(original.certificate);
      if(!proof)throw Error();
      if(kind==='order')proof.candidate.orderId=keccak256(toHex('tampered demo order'));
      if(kind==='result')proof.evaluation.answers.purpose.confidence=.5;
      const valid=await inspectRecordedBindings(proof,original.request,recording.trust);
      if(disposed||version!==turn)return;
      if(kind==='original'){inspection=valid;message=valid?'Original recorded bindings verified. This historical certificate is not a current spending permission.':'Original transcript verification failed. Do not rely on this recording.';}
      else message=valid?'Unexpected verification result. Do not rely on this recording.':kind==='order'?'Replacement rejected: the signed candidate binds the original order.':'Alteration rejected: the signed release binds the exact review answers.';
    }catch{if(!disposed&&version===turn)message='The transcript could not be verified. No action was taken.';}
    finally{if(!disposed&&version===turn){busy=false;render();}}
  }
  function click(event:Event){
    const target=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button[data-demo]'):null;if(!target||!root.contains(target))return;
    const action=target.dataset.demo;
    if(action==='download'){const url=URL.createObjectURL(new Blob([JSON.stringify(recording,null,2)+'\n'],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='intentpass-adaptor-sales-demo.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    if(action==='order'||action==='result'||action==='original'){void check(action);return;}
    version++;busy=false;message='';
    if(action==='pass'||action==='reject'){outcome=action==='pass'?'PASS':'REJECT';step=0;inspection=undefined;}
    if(action==='reset'){step=0;inspection=undefined;}
    if(action==='back')step=Math.max(0,step-1);
    if(action==='next')step=Math.min(4,step+1);
    render();if(step===4&&outcome==='PASS')void check('original');
  }
  root.addEventListener('click',click);render();
  return()=>{disposed=true;version++;root.removeEventListener('click',click);};
}
