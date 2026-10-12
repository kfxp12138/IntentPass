import {buyerDeliveryHandoff,downloadHandoff} from './role-handoff.js';
import {TaskInputSchema,AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {AutomaticPreparation,AutomaticPayment} from './purchase-automation.js';
import {purchaseFailureCode,automaticFailureFeedback} from './purchase-failure.js';
import {WalletSignatureNotRequested} from './privy-grant-wallet.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {contextHash} from '../../../packages/protocol/src/index.js';
import {createReport} from '../../../packages/protocol/src/report.js';
import {OriginalFundingFlow,originalFundingPreview} from './original-funding-flow.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {AssetApprovalFlow} from './asset-approval-flow.js';
import type {ApprovalStep} from '../../../packages/capsule/src/asset-approval.js';
import {PurchaseFlow} from './purchase-flow.js';
import {browserSession,type BrowserSession} from './browser-session.js';
import type {EvidenceBundle} from '../../../packages/protocol/src/review-evidence.js';
import {AuthorizationBackup} from '../../../packages/capsule/src/authorization-backup.js';
import {CapsuleClient} from '../../../packages/capsule/src/client.js';
import {authorizationNamespace} from '../../../packages/capsule/src/format.js';
import {createCapsulePasskey,MeraPrfSource} from '../../../packages/capsule/src/mera.js';
import {exportCapsule,PreparedCapsuleKey,type PrfSource} from '../../../packages/capsule/src/crypto.js';
import {createPasskeyReference,type PasskeyReferencePort} from './passkey-reference.js';
export interface PendingAuthorization {payload:unknown;subject:string;dataset?:number[];backup?:AuthorizationBackup;approval?:AssetApprovalFlow;funding?:OriginalFundingFlow;}
export interface PendingAuthorizationPort {get():PendingAuthorization|undefined;set(value:PendingAuthorization):void;}
import {authorizationDeadline,candidateNonce,grantPreview,preflightPreview} from './authorization-preview.js';
import {receiptRecoveryControls,attachReceiptRecoveryControls} from './receipt-recovery-ui.js';
const evidenceControls=`<h3>补充当前报价的证据</h3><p class="hint">粘贴你取得的补充原文。原报价和原证据会全部保留；补充材料不修改卖方签署的许可条款。加入后需重新确认披露并审查新版本。</p><label>补充材料原文<textarea id="additional-evidence" maxlength="16000" rows="4" disabled></textarea></label><button id="add-evidence" type="button" disabled>加入证据并生成新版本</button><pre id="evidence-history" hidden></pre><p class="hint">同一证据版本只审查一次。刷新或退出会清除未备份的本页材料与历史；审查服务保留已提交的结论，不会因此重新审核。</p>`;
const automaticControls=`<section class="automatic-purchase"><h2>自动推进本单</h2><p class="hint">连续完成候选、审查、权限准备与预检。先完成设备验证，再申请短期限权限。核对本单后，可一次确认连续签署、备份、准确额度与入金，并等待原交易最终确认。设备提示仍由你完成，结果未知时保留原单并停止发送。</p><label><input id="disclose-evidence" type="checkbox">我同意将本次任务、报价及全部证据发送给配置的 planner / JEV 审查服务。</label><button id="check-purchase-wallet">只读核对签署连接</button><button id="auto-purchase-prepare" disabled>自动准备本单</button><p id="auto-grant-details"></p><label><input id="agree-checkout" type="checkbox">我已核对本单金额、资产、收款方、执行者和期限，同意签署本单一次性权限、设置准确额度，并将本单金额转入托管。</label><button id="auto-checkout" disabled>确认本单权限并自动完成入金</button><label><input id="agree-grant" type="checkbox">我已核对本单金额、执行者和期限，同意通过 Privy 钱包签署仅一次的权限。此操作不会自动批准资产或付款。</label><button id="auto-sign-backup" disabled>确认签署并自动备份</button><label><input id="auto-payment-consent" type="checkbox">我确认按下方已签原单设置准确资产额度，并将该单金额转入指定托管合约。</label><button id="auto-purchase-pay" disabled>确认额度并自动完成入金</button><p id="auto-purchase-feedback" role="status" aria-live="polite"></p></section>`;
export const purchaseControls=`${automaticControls}<details class="disclosure"><summary>逐步操作：报价、证据、单次授权与原单入金</summary><div class="disclosure-body"><h2>选择签名服务报价</h2><button id="load-catalog">读取服务目录</button><div id="quote-list"></div><button id="propose-draft" disabled>生成采购候选</button><h2 style="margin-top:24px">候选与证据</h2><pre id="draft-preview" hidden></pre>${evidenceControls}<button id="review-draft" disabled>审查当前候选</button><p id="purchase-feedback" role="status" aria-live="polite"></p><pre id="review-preview" hidden></pre>${receiptRecoveryControls}<h2 style="margin-top:24px">一次性授权准备</h2><label>期望有效时长（1–300 秒，实际受回执和报价期限限制）<input id="authorization-window" type="number" min="1" max="300" step="1" value="120"></label><button id="prepare-grant" disabled>准备本单权限</button><pre id="grant-preview" hidden></pre><button id="check-funding" disabled>读取链上入金预检</button><pre id="preflight-preview" hidden></pre><button id="confirm-grant" disabled>确认并签署本单权限</button><h2 style="margin-top:24px">保留原授权</h2><p class="hint">先创建原授权密文并下载。刷新或退出会清除页面内存；关闭前请保存文件及可同步的 Passkey。已签权限不会因关闭页面而被撤销。</p><button id="seal-authorization" disabled>使用 Passkey 加密原授权</button><button id="download-authorization" disabled>下载原授权密文</button><button id="upload-authorization" disabled>保存密文到本账户</button><button id="reconcile-authorization" disabled>核对服务端原备份</button><h2 style="margin-top:24px">本单资产额度</h2><p class="hint">先加密原授权。已有不同非零额度须先清零，最终确认后再独立设置准确额度。额度操作不等于付款；结果未知时只核对，不重新发送。</p><label>操作<select id="approval-step"><option value="SET">设置本单准确额度</option><option value="RESET">清零当前额度</option></select></label><label><input id="agree-asset" type="checkbox">我确认仅修改指定资产对本单托管合约的额度。将请求钱包发出一笔交易。</label><button id="approve-asset" disabled>确认并请求额度交易</button><label>需核对的额度交易哈希（可从钱包记录填写）<input id="approval-hash" type="text" autocomplete="off" placeholder="0x…"></label><button id="check-approval" disabled>只读核对额度交易</button><pre id="asset-approval-preview" hidden></pre><h2 style="margin-top:24px">原订单入金</h2><pre id="signed-original-preview" hidden></pre><p class="hint">仅提交已签的原订单。服务端会重新核对全部签名、资产资格、准确额度并模拟；结果未知时只对账。已入金不等于卖方已收到结算款。</p><label><input id="agree-funding" type="checkbox">我确认将本单价格加保证金转入指定托管合约，并同意受限执行者提交原订单。</label><button id="submit-original" disabled>确认并提交原订单入金</button><label>原入金交易哈希（可选，仅用于对账）<input id="funding-hash" type="text" autocomplete="off" placeholder="0x…"></label><button id="reconcile-funding" disabled>只读核对原入金</button><pre id="funding-preview" hidden></pre></div></details>`;
export function attachPurchaseControls(task:()=>unknown,pending:PendingAuthorizationPort=(()=>{let value:PendingAuthorization|undefined;return {get:()=>value,set:p=>{value=p;}};})(),references:PasskeyReferencePort=createPasskeyReference(),onOrder:(order:OrderSnapshot)=>void=()=>{},options:{flow?:PurchaseFlow;session?:BrowserSession;clock?:()=>bigint;onEvidenceChanged?:(evidence:EvidenceBundle)=>void;onTaskRescheduled?:(task:unknown)=>void;prfSource?:(reference:NonNullable<ReturnType<typeof references.get>>)=>PrfSource}={}) {
  const session=options.session??browserSession,clock=options.clock??(()=>BigInt(Math.floor(Date.now()/1000))),flow=options.flow??new PurchaseFlow(task,session),list=document.querySelector<HTMLElement>('#quote-list')!,feedback=document.querySelector<HTMLElement>('#purchase-feedback')!,load=document.querySelector<HTMLButtonElement>('#load-catalog')!,propose=document.querySelector<HTMLButtonElement>('#propose-draft')!,review=document.querySelector<HTMLButtonElement>('#review-draft')!,draftPreview=document.querySelector<HTMLElement>('#draft-preview')!,resultPreview=document.querySelector<HTMLElement>('#review-preview')!;
  const additional=document.querySelector<HTMLTextAreaElement>('#additional-evidence')!,addEvidence=document.querySelector<HTMLButtonElement>('#add-evidence')!,history=document.querySelector<HTMLElement>('#evidence-history')!,disclose=document.querySelector<HTMLInputElement>('#disclose-evidence')!;
  const handoff=document.createElement('section');handoff.innerHTML='<h2>原订单资料交接</h2><p class="hint">仅交给原服务商。此下载包含原数据、原授权与证据的明文，不是加密备份；没有自动发送给任何人。</p><label><input id="buyer-handoff-consent" type="checkbox">我同意下载明文原资料，供指定服务商生成报告，并自行妥善传递。</label><button id="buyer-handoff" type="button" disabled>下载给原服务商的资料</button>';document.querySelector('#funding-preview')!.after(handoff);const handoffConsent=document.querySelector<HTMLInputElement>('#buyer-handoff-consent')!,handoffButton=document.querySelector<HTMLButtonElement>('#buyer-handoff')!;
  const prepare=document.querySelector<HTMLButtonElement>('#prepare-grant')!,preflight=document.querySelector<HTMLButtonElement>('#check-funding')!,grant=document.querySelector<HTMLElement>('#grant-preview')!,chain=document.querySelector<HTMLElement>('#preflight-preview')!,windowInput=document.querySelector<HTMLInputElement>('#authorization-window')!;
  const confirm=document.querySelector<HTMLButtonElement>('#confirm-grant')!,agree=document.querySelector<HTMLInputElement>('#agree-grant')!,seal=document.querySelector<HTMLButtonElement>('#seal-authorization')!,download=document.querySelector<HTMLButtonElement>('#download-authorization')!,upload=document.querySelector<HTMLButtonElement>('#upload-authorization')!,reconcile=document.querySelector<HTMLButtonElement>('#reconcile-authorization')!;
  const approveAsset=document.querySelector<HTMLButtonElement>('#approve-asset')!,checkApproval=document.querySelector<HTMLButtonElement>('#check-approval')!,agreeAsset=document.querySelector<HTMLInputElement>('#agree-asset')!,approvalStep=document.querySelector<HTMLSelectElement>('#approval-step')!,approvalHash=document.querySelector<HTMLInputElement>('#approval-hash')!,approvalPreview=document.querySelector<HTMLElement>('#asset-approval-preview')!;
  const submitOriginal=document.querySelector<HTMLButtonElement>('#submit-original')!,reconcileFunding=document.querySelector<HTMLButtonElement>('#reconcile-funding')!,agreeFunding=document.querySelector<HTMLInputElement>('#agree-funding')!,fundingHash=document.querySelector<HTMLInputElement>('#funding-hash')!,fundingPreview=document.querySelector<HTMLElement>('#funding-preview')!;
  const locked=()=>!!pending.get()||flow.authorizationLocked;
  const autoPrepare=document.querySelector<HTMLButtonElement>('#auto-purchase-prepare')!,autoSignBackup=document.querySelector<HTMLButtonElement>('#auto-sign-backup')!,autoPay=document.querySelector<HTMLButtonElement>('#auto-purchase-pay')!,autoConsent=document.querySelector<HTMLInputElement>('#auto-payment-consent')!,autoFeedback=document.querySelector<HTMLElement>('#auto-purchase-feedback')!;
  const connectionCheck=document.querySelector<HTMLButtonElement>('#check-purchase-wallet')!;
  const checkout=document.querySelector<HTMLButtonElement>('#auto-checkout')!,checkoutConsent=document.querySelector<HTMLInputElement>('#agree-checkout')!;
  let preparedBackup:{key:PreparedCapsuleKey;reference:NonNullable<ReturnType<typeof references.get>>;context:string;subject:string;generation:number}|undefined;
  const dropPrepared=()=>{preparedBackup?.key.dispose();preparedBackup=undefined;};
  const deviceReady=()=>!!preparedBackup?.key.ready&&preparedBackup.key.remainingMs>150000&&preparedBackup.generation===session.generation&&!!flow.draft&&preparedBackup.context===contextHash(flow.draft.intent);
  const preparationAutomation=new AutomaticPreparation(flow,clock,()=>prepareBackupDevice());let paymentAutomation:AutomaticPayment|undefined;
  const clearAuthorization=()=>{grant.hidden=chain.hidden=true;prepare.disabled=preflight.disabled=confirm.disabled=true;agree.checked=false;};
  const receiptCurrent=()=>{const r=flow.reviewResult;return !!r&&r.source==='JEV'&&r.executable&&clock()<BigInt(r.receipt.expiresAt);};
  const canPrepare=()=>{const r=flow.reviewResult;return !locked()&&disclose.checked&&!additional.value&&!!r&&r.source==='JEV'&&r.decision==='PASS'&&r.executable&&receiptCurrent();};
  const updateButtons=()=>{connectionCheck.disabled=busy;checkoutConsent.disabled=busy;checkout.disabled=busy||locked()||!receiptCurrent()||!flow.authorization||!checkoutConsent.checked||!deviceReady();const automaticGrant=flow.authorization?.payload.grant;document.querySelector<HTMLElement>('#auto-grant-details')!.textContent=automaticGrant?`本单金额：${automaticGrant.amount} 个资产最小单位；执行者：${automaticGrant.executor}；有效截止：${new Date(Number(automaticGrant.deadline)*1000).toLocaleString()}；仅一次。`:'';autoPrepare.disabled=busy||locked()||!disclose.checked||!!additional.value;autoSignBackup.disabled=busy||locked()||!receiptCurrent()||!flow.authorization||!agree.checked||!deviceReady();const autoOriginal=pending.get();autoPay.disabled=busy||!autoOriginal?.backup?.file||!autoConsent.checked||!!paymentAutomation?.hasStarted||!!autoOriginal&&clock()>=BigInt(AuthorizationPayloadSchema.parse(autoOriginal.payload).grant.deadline);autoConsent.disabled=busy;additional.disabled=busy||locked()||!flow.draft||flow.draft.evidence.documents.length>=12;addEvidence.disabled=additional.disabled||!additional.value.trim();paintHistory();handoffButton.disabled=busy||!pending.get()?.dataset||!handoffConsent.checked;handoffConsent.disabled=busy;const originalPreview=document.querySelector<HTMLElement>('#signed-original-preview')!,original=pending.get();if(original){originalPreview.textContent=originalFundingPreview(original.payload);originalPreview.hidden=false;}const funding=pending.get()?.funding?.state;submitOriginal.disabled=busy||!pending.get()?.backup?.file||!agreeFunding.checked||!!funding?.attempted;reconcileFunding.disabled=busy||!pending.get();agreeFunding.disabled=fundingHash.disabled=busy;if(funding){const r=funding.result;fundingPreview.textContent=`入金记录：${r?.record.status??(funding.unknown?'结果未知':'尚未提交')}\n原交易：${r?.record.hash??'未取得可验证哈希'}\n原链状态：${r?.snapshot?.state??'待核对'}\n${r?.error||funding.unknown?'本次核对有阻塞，保留的记录不代表当前资金状态。':'额度、入金、分配与实际提现须分别核对。'}`;fundingPreview.hidden=false;}const saved=pending.get()?.backup,file=saved?.file,attempts=pending.get()?.approval?.attemptStates,selected=approvalStep.value as ApprovalStep;approveAsset.disabled=busy||!file||!agreeAsset.checked||!!attempts?.[selected]||Object.values(attempts??{}).some(a=>!['CONFIRMED','REVERTED'].includes(a.status));checkApproval.disabled=busy||!pending.get()||!(approvalHash.value.trim()||attempts?.[selected]?.hash);agreeAsset.disabled=approvalStep.disabled=approvalHash.disabled=busy;if(attempts){approvalPreview.textContent=JSON.stringify(attempts,null,2);approvalPreview.hidden=false;}prepare.disabled=busy||!canPrepare();preflight.disabled=busy||locked()||!flow.authorization;confirm.disabled=busy||locked()||!receiptCurrent()||!!additional.value||!disclose.checked||!flow.authorization||!agree.checked;seal.disabled=busy||!pending.get();download.disabled=busy||!file;upload.disabled=busy||!file||saved?.status==='UNKNOWN'||saved?.status==='SAVED';reconcile.disabled=busy||!file;windowInput.disabled=busy||locked();load.disabled=busy||locked();propose.disabled=busy||locked()||list.querySelectorAll('input').length===0;review.disabled=busy||locked()||!!additional.value||!flow.canReview||!disclose.checked;agree.disabled=busy||locked();document.querySelector<HTMLInputElement>('#disclose-evidence')!.disabled=busy||locked();for(const input of Array.from(list.querySelectorAll<HTMLInputElement>('input')))input.disabled=busy||locked();};
  let busy=false;
  const paintDraft=()=>{const result=flow.draft;if(!result){draftPreview.hidden=true;return;}const e=result.intent;draftPreview.textContent=`证据版本：${e.attempt}\n候选订单：${e.orderId}\n服务商：${e.seller}\n收款方：${e.payee}\n价格：${e.price}\n保证金：${e.bond}\n总支出：${BigInt(e.price)+BigInt(e.bond)}\n预算上限：${result.policy.budget}\n资产：${e.asset}\n金额均为资产最小单位。\n\n报价许可原文：\n${result.quote.serviceTerms}\n\n全部证据：\n${result.evidence.documents.map(doc=>`${doc.id}\n${doc.text}`).join('\n\n')}`;draftPreview.hidden=false;};
  const reviewMessages:Record<string,string>={REVIEW_VERSION_ALREADY_REQUESTED:'此材料版本已有审查记录，不能通过更换订单编号重复审核。请补充新的材料后再送审。',REVIEW_REQUEST_IN_PROGRESS_OR_UNKNOWN:'原审查已提交，仍在进行或结果未知。不会重复请求；请核对原审查记录。',REVIEW_SIGNING_OUTCOME_UNKNOWN:'原审核判断已保存，但回执签署结果未知。请核对原记录，不会再次签发。',REVIEW_RECEIPT_EXPIRED:'原回执已过期，不能通过重复审核自动续期。请核对原记录与当前报价。',REVIEW_JOURNAL_UNAVAILABLE:'审查记录暂不可用，无法继续。请恢复审查服务后核对原记录。',REVIEW_TIME_INVALID:'审查时间暂无法核对，无法使用原回执。请核对服务时间与原记录。',JEV_UNAVAILABLE_OR_INVALID:'原审查未取得有效结果，暂停结论已保留。同一材料版本不会重复请求。'};
  const paintReview=(result:Awaited<ReturnType<PurchaseFlow['review']>>)=>{const note='code'in result&&result.code?reviewMessages[result.code]:undefined;if(result.source==='JEV'){const labels={SUPPORTED:'证据支持',CONTRADICTED:'证据矛盾',INSUFFICIENT:'证据不足'};resultPreview.textContent=`服务是否满足任务：${labels[result.answers.service.choice]}（确定性 ${result.answers.service.confidence.toFixed(3)}）\n是否允许商业用途：${labels[result.answers.purpose.choice]}（确定性 ${result.answers.purpose.confidence.toFixed(3)}）\n证据是否属于当前服务：${labels[result.answers.provenance.choice]}（确定性 ${result.answers.provenance.confidence.toFixed(3)}）\n模型：${result.modelId}\n确定性描述本次模型判断，不代表交易安全或许可必然真实。`;}else{resultPreview.textContent=note??(result.source==='HARD_RULE'?'固定规则校验未通过，未进行模型审查。':'审查服务未提供有效结果，无法继续。');}resultPreview.hidden=false;feedback.textContent=note??(result.decision==='REJECT'?'审查拒绝：必要要求存在矛盾或硬规则未通过。':result.decision==='ABSTAIN'?'审查暂停：证据或确定性不足，需要补充后重新审查。':result.source==='JEV'&&result.executable?(receiptCurrent()?'审查通过，签名回执已核对。下一步仍需用户确认一次性授权。':'通过判断已保留，原回执已过期。请核对原记录与交付时间。'):'语义审查通过，但尚无可执行签名回执。没有授权或付款。');};
  const paintHistory=()=>{const attempts=flow.reviewHistory;history.hidden=!attempts.length;history.textContent=attempts.map(a=>`版本 ${a.request.intent.attempt} · ${a.state==='COMPLETE'?a.result?.decision??'未取得结果':a.state==='PENDING'?'等待结果':a.state==='DISCARDED'?'旧结果已丢弃':'审查未完成'}\n原候选：${a.request.intent.orderId}\n材料：${a.request.evidence.documents.map(d=>d.id).join('、')}`).join('\n\n');};
  const handoffRefresh=()=>{handoffButton.disabled=busy||!pending.get()?.dataset||!handoffConsent.checked;};handoffConsent.addEventListener('change',handoffRefresh);
  agreeFunding.addEventListener('change',updateButtons);fundingHash.addEventListener('input',updateButtons);
  agree.addEventListener('change',updateButtons);agreeAsset.addEventListener('change',updateButtons);approvalStep.addEventListener('change',()=>{agreeAsset.checked=false;approvalHash.value='';updateButtons();});approvalHash.addEventListener('input',updateButtons);
  if(pending.get())feedback.textContent='本页内存保留了已签原授权。请加密、下载并核对备份；尚未付款。';
  paintDraft();if(flow.reviewResult)paintReview(flow.reviewResult);updateButtons();
  additional.addEventListener('input',()=>{flow.invalidateAuthorization();clearAuthorization();disclose.checked=false;updateButtons();feedback.textContent='补充原文尚未加入当前版本。请加入后重新确认披露并审查。';});
  addEvidence.addEventListener('click',()=>{void run(async()=>{if(locked())throw new Error('ORIGINAL_AUTHORIZATION_ALREADY_SIGNED');const draft=flow.draft;if(!draft)throw new Error('DRAFT_REQUIRED');let label=1;while(draft.evidence.documents.some(d=>d.id===`additional-${label}`))label++;const next=await flow.supplementEvidence({id:`additional-${label}`,subjectQuoteId:draft.quote.quoteId,text:additional.value});if(!feedback.isConnected)return;options.onEvidenceChanged?.(structuredClone(next.evidence));clearAuthorization();additional.value='';disclose.checked=false;resultPreview.hidden=true;paintDraft();feedback.textContent=`已生成证据版本 ${next.intent.attempt}，原材料全部保留。请重新确认披露并审查；旧审查和待签权限已失效，没有签名或付款。`;},'supplement');});
  windowInput.addEventListener('input',()=>{flow.invalidateAuthorization();clearAuthorization();updateButtons();feedback.textContent='有效时长已改变，请重新准备权限并预检。尚未签署或付款。';});
  list.addEventListener('change',()=>{flow.reset();clearAuthorization();draftPreview.hidden=resultPreview.hidden=true;review.disabled=true;feedback.textContent='报价选择已改变，请重新生成候选。';});
  disclose.addEventListener('change',()=>{if(!disclose.checked){flow.invalidateAuthorization();flow.reviewResult=undefined;clearAuthorization();resultPreview.hidden=true;feedback.textContent='已取消后续审查。已经发出的请求不能撤回，其结果不会用于授权。';}updateButtons();});
  const run=async(work:()=>Promise<void>,operation:'default'|'supplement'|'review'|'receipt'|'automation'|'connection'='default')=>{
    if(busy)return;busy=true;updateButtons();
    try{await work();}catch(error){
      if(operation==='connection')feedback.textContent=`签署连接未就绪，原候选与审查保留。故障编号：${purchaseFailureCode(error)}。此检查没有签署或付款。`;
      else if(error instanceof WalletSignatureNotRequested)feedback.textContent='本次钱包签署没有发起，原候选、审查和准备记录保留。请先只读核对签署连接和期限，再明确继续。没有付款。';
      else if(error instanceof Error&&error.message==='EVIDENCE_VERSION_ALREADY_REVIEWED')feedback.textContent='此证据版本已有审查记录。请补充新的材料后再审查，不重复请求同一版本。';
      else if(operation==='review'&&!locked())feedback.textContent='本版本审查未完成，记录仍保留。请补充新材料后再送审，不重复请求同一版本。';
      else if(operation==='supplement'&&!locked())feedback.textContent='补充材料未加入。请检查材料长度、报价归属和当前登录；原候选仍保留，没有发送审查或付款。';
      else if(flow.authorizationLocked&&!flow.signedAuthorization&&!pending.get())feedback.textContent='钱包签署已请求，但未取得可核对的原签名。此候选已冻结，请核对钱包记录；不要重新授权或下单。';
      else if(pending.get()||flow.signedAuthorization){
        const code=purchaseFailureCode(error);
        feedback.textContent=code==='CAPSULE_UPLOAD_OUTCOME_UNKNOWN'?'原授权密文上传结果未知。文件保留，请核对服务端，不会自动重发。尚未付款。':code==='PASSKEY_CANCELLED'?'Passkey 操作已取消；已签原授权仍保留在页面内存，请重新备份。尚未付款。':'操作未完成，已签原授权不会被改写。请核对当前账户、Passkey 与备份配置；尚未付款。';
      }else if(operation==='automation')feedback.textContent='自动操作未完成，原候选、审查与准备记录保留。请核对登录、签署连接和期限。没有付款。';
      else{flow.reset();clearAuthorization();draftPreview.hidden=resultPreview.hidden=true;feedback.textContent='操作已停止：请检查登录、原任务、服务目录、审查配置和期限。页面未收到可用授权；若钱包操作超时，签名结果可能未知。没有付款。';}
      if(feedback.isConnected&&(operation==='automation'||operation==='connection'))autoFeedback.textContent=automaticFailureFeedback(error,feedback.textContent);
    }finally{busy=false;load.disabled=false;propose.disabled=list.querySelectorAll('input').length===0;review.disabled=!flow.draft;updateButtons();}
  };
  attachReceiptRecoveryControls(flow,work=>run(work,'receipt'),resultChanged=>{
    if(resultChanged){
      clearAuthorization();paintDraft();
      if(flow.reviewResult)paintReview(flow.reviewResult);
      else{resultPreview.hidden=true;resultPreview.textContent='';if(flow.canReview)feedback.textContent='当前候选尚未审查，请点击“审查当前候选”。旧候选的判断保留在历史中，尚未授权或付款。';}
    }
    updateButtons();
  },clock,()=>busy,options.onTaskRescheduled);
  load.addEventListener('click',()=>{void run(async()=>{const catalog=await flow.catalog();if(!feedback.isConnected)return;list.textContent='';flow.reset();clearAuthorization();draftPreview.hidden=resultPreview.hidden=true;
    for(const entry of catalog.entries){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=entry.quote.quoteId;label.append(input,document.createTextNode(`数据报告 · 价格 ${entry.quote.amount}（最小单位） · 服务商 ${entry.quote.seller} · 收款方 ${entry.quote.payee}`));list.append(label);}
    feedback.textContent=catalog.entries.length?'目录已读取。选择最多五个报价生成候选；最终报价仍需验签和审查。':'目录没有可用报价。';});});
  propose.addEventListener('click',()=>{void run(async()=>{if(!document.querySelector<HTMLInputElement>('#disclose-evidence')!.checked){feedback.textContent='请先确认本次模型审查所需的数据披露。';return;}
    clearAuthorization();const refs=Array.from(list.querySelectorAll<HTMLInputElement>('input:checked')).map(input=>input.value),result=await flow.propose(refs);if(!feedback.isConnected)return;resultPreview.hidden=true;
    if(result.status==='DRAFT'){paintDraft();feedback.textContent='候选已生成并核对原始策略。这只是草稿，尚未授权或付款。';}else{draftPreview.hidden=true;feedback.textContent=result.status==='REJECT'?'候选被拒绝：报价或任务不满足固定要求。':'候选生成暂停：模型或目录未提供有效结果。';}});});
  review.addEventListener('click',()=>{void run(async()=>{if(!document.querySelector<HTMLInputElement>('#disclose-evidence')!.checked){feedback.textContent='请先确认本次审查的数据披露。';return;}clearAuthorization();const result=await flow.review();if(!feedback.isConnected)return;
    paintReview(result);},'review');});
  prepare.addEventListener('click',()=>{void run(async()=>{
    clearAuthorization();const now=clock(),deadline=authorizationDeadline(flow.draft,flow.reviewResult,windowInput.value,now);
    const prepared=await flow.prepare(candidateNonce(),deadline);if(!feedback.isConnected)return;
    grant.textContent=grantPreview(prepared.payload.grant);grant.hidden=false;feedback.textContent='本单权限已准备并验签核对，请查看准确金额、执行者和有效截止。尚未签署或付款。';
  });});
  preflight.addEventListener('click',()=>{void run(async()=>{
    chain.hidden=true;const result=await flow.preflight();if(!feedback.isConnected)return;
    if('status'in result){feedback.textContent='预检拒绝：原订单账户或输入不匹配，请重新核对。没有付款。';return;}
    chain.textContent=preflightPreview(result);chain.hidden=false;
    feedback.textContent=result.blockers.length?'预检发现阻塞，请查看原因。没有付款。':'已读取最终确认区块，未观察到所列阻塞。下一步需核对并明确签署本单权限，尚未付款。';
  });});
  const active=(generation:number)=>{if(!feedback.isConnected||session.generation!==generation)throw new Error('SESSION_CHANGED');};
  const getBackup=async()=>{
    const generation=session.generation;active(generation);
    const original=pending.get();if(!original)throw new Error('ORIGINAL_AUTHORIZATION_REQUIRED');
    const principal=await session.verified(),config=await session.configuration();
    if(principal.subject!==original.subject||!config.recoveryDeployment)throw new Error('BACKUP_SESSION_CHANGED');
    if(!original.backup){const created=await AuthorizationBackup.create(original.payload,principal,config.recoveryDeployment,()=>session.verified(),new CapsuleClient(location.origin,()=>session.token()));active(generation);if(pending.get()!==original)throw new Error('BACKUP_SESSION_CHANGED');original.backup=created;}
    return original.backup;
  };
  const signOriginal=async()=>{
    const generation=session.generation,principal=await session.verified();active(generation);
    if(pending.get())throw new Error('ORIGINAL_AUTHORIZATION_ALREADY_SIGNED');
    const currentTask=task() as {taskInput:unknown},dataset=TaskInputSchema.parse(currentTask.taskInput).dataset;
    const signed=await flow.sign(()=>active(generation));active(generation);
    pending.set({payload:signed.payload,subject:principal.subject,...(createReport(dataset).datasetHash.toLowerCase()===signed.payload.intent.datasetHash.toLowerCase()?{dataset}:{})});agree.checked=false;grant.hidden=chain.hidden=true;
    feedback.textContent='原授权已签署并复核，仅在页面内存保留。请立即加密备份。没有批准资产或付款。';
  };
  confirm.addEventListener('click',()=>{void run(async()=>{if(!agree.checked){feedback.textContent='请先核对本单权限并明确确认签署。';return;}await signOriginal();});});
  const prepareBackupDevice=async()=>{
    const generation=session.generation;active(generation);if(!flow.draft||!window.isSecureContext)throw Error('SECURE_CONTEXT_REQUIRED');
    const expected=contextHash(flow.draft.intent),principal=await session.verified(),configuration=await session.configuration();active(generation);
    if(deviceReady()&&preparedBackup?.subject===principal.subject)return;
    dropPrepared();const rpId=configuration.meraRpId??location.hostname;
    const reference=references.get()??await createCapsulePasskey(rpId,{name:'IntentPass backup',displayName:'IntentPass 加密备份'},authorizationNamespace(flow.draft.intent.orderId));active(generation);references.set(reference);
    const key=await PreparedCapsuleKey.prepare(authorizationNamespace(flow.draft.intent.orderId),reference,options.prfSource?.(reference)??new MeraPrfSource(reference),()=>{active(generation);if(!flow.draft||contextHash(flow.draft.intent)!==expected)throw Error('PURCHASE_CONTEXT_CHANGED');});
    try{active(generation);const current=await session.verified();active(generation);if(current.subject!==principal.subject||!flow.draft||contextHash(flow.draft.intent)!==expected)throw Error('SESSION_CHANGED');preparedBackup={key,reference,context:expected,subject:principal.subject,generation};}catch(error){key.dispose();throw error;}
  };
  const ensurePrepared=async()=>{if(!deviceReady())throw Error('PREPARED_KEY_EXPIRED');const principal=await session.verified();if(!deviceReady()||principal.subject!==preparedBackup?.subject)throw Error('SESSION_CHANGED');};
  const unsubscribe=session.onGenerationChange(dropPrepared);
  const cleanup=setInterval(()=>{if(!feedback.isConnected){dropPrepared();unsubscribe();clearInterval(cleanup);}},1000);if(typeof cleanup==='object'&&'unref' in cleanup)cleanup.unref();
  const sealOriginal=async()=>{
    const generation=session.generation;if(!window.isSecureContext)throw new Error('SECURE_CONTEXT_REQUIRED');
    const backup=await getBackup();active(generation);const config=await session.configuration(),rpId=config.meraRpId??location.hostname;
    const reference=backup.file?.keyReference??references.get()??await createCapsulePasskey(rpId,{name:'IntentPass backup',displayName:'IntentPass 加密备份'},authorizationNamespace(backup.orderId));active(generation);
    references.set(reference);
    const held=preparedBackup;
    if(held){const original=AuthorizationPayloadSchema.parse(pending.get()!.payload);if(!held.key.ready||held.generation!==generation||held.subject!==pending.get()!.subject||held.context!==original.grant.contextHash)throw Error('PREPARED_KEY_CONTEXT_MISMATCH');await backup.seal(reference,held.key,()=>active(generation));dropPrepared();}
    else await backup.seal(reference,new MeraPrfSource(reference),()=>active(generation));active(generation);
    feedback.textContent='已在本页生成原授权密文。请下载；只有点击保存密文才会上传。尚未付款。';
  };
  seal.addEventListener('click',()=>{void run(sealOriginal);});
  const downloadOriginal=async()=>{
    const generation=session.generation,backup=await getBackup();active(generation);const file=backup.file;if(!file)throw new Error('ENCRYPTED_BACKUP_REQUIRED');
    const url=URL.createObjectURL(new Blob([exportCapsule(file)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`intentpass-authorization-${file.capsule.objectId}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    feedback.textContent='已请求下载原授权密文，请确认浏览器保存成功。没有付款。';
  };
  download.addEventListener('click',()=>{void run(downloadOriginal);});
  upload.addEventListener('click',()=>{void run(async()=>{
    const generation=session.generation,backup=await getBackup();active(generation);await backup.upload(()=>active(generation));active(generation);
    feedback.textContent='服务端已返回与本页完全一致的原密文。已备份，不代表已付款。';
  });});
  reconcile.addEventListener('click',()=>{void run(async()=>{
    const generation=session.generation,backup=await getBackup();active(generation);await backup.reconcile(()=>active(generation));active(generation);
    feedback.textContent='已读取并核对服务端保存的同一份原密文，没有重复上传或付款。';
  });});
  const getApproval=async()=>{
    const generation=session.generation,original=pending.get();active(generation);if(!original)throw new Error('ORIGINAL_AUTHORIZATION_REQUIRED');
    const principal=await session.verified();active(generation);if(principal.subject!==original.subject)throw new Error('SESSION_CHANGED');
    original.approval??=new AssetApprovalFlow(original.payload,original.subject,()=>!!original.backup?.file);return original.approval;
  };
  approveAsset.addEventListener('click',()=>{void run(async()=>{
    if(!agreeAsset.checked)throw new Error('APPROVAL_CONFIRMATION_REQUIRED');const generation=session.generation,approval=await getApproval();active(generation);
    const result=await approval.approve(approvalStep.value as ApprovalStep,()=>active(generation));active(generation);agreeAsset.checked=false;
    feedback.textContent=result.status==='ALREADY_RECORDED'?'该额度步骤已有持久化记录，没有再次请求钱包。请核对原交易；尚未付款。':'额度交易已提交，尚未最终确认。请只读核对原交易；没有提交订单或付款。';
  });});
  checkApproval.addEventListener('click',()=>{void run(async()=>{
    const generation=session.generation,approval=await getApproval();active(generation);const result=await approval.reconcile(approvalStep.value as ApprovalStep,approvalHash.value.trim()||undefined,()=>active(generation));active(generation);
    feedback.textContent=result.receipt.status==='PENDING'?'尚未取得最终确认回执。保持原步骤，不重新发送；尚未付款。':result.receipt.status==='REVERTED'?'原额度交易已最终确认失败，没有重新发送；尚未付款。':result.receipt.exactAllowance?'原额度交易已最终确认，当前额度准确。订单尚未入金。':'原额度交易已最终确认，当前额度仍不是本单准确额度。订单尚未入金。';
  });});

  const getFunding=async()=>{
    const generation=session.generation,original=pending.get();active(generation);if(!original)throw new Error('ORIGINAL_AUTHORIZATION_REQUIRED');
    const principal=await session.verified();active(generation);if(principal.subject!==original.subject)throw new Error('SESSION_CHANGED');
    original.funding??=new OriginalFundingFlow(original.payload,original.subject,()=>!!original.backup?.file);return original.funding;
  };
  const showFundingResult=(result:Awaited<ReturnType<OriginalFundingFlow['submit']>>)=>{
    if(result.error){feedback.textContent='本次入金或核对发现阻塞。请只读核对原记录；没有自动重发。';return;}
    if(result.snapshot&&result.snapshot.state!=='UNREGISTERED')onOrder(result.snapshot as OrderSnapshot);
    feedback.textContent=result.record.status==='CONFIRMED'?'原入金交易及准确资金事件已最终确认。可进入订单页核对交付、验收、分配和实际提现。':result.record.status==='RECONCILED'?'原订单链状态已匹配，尚无完整原交易证明。没有重新入金；可进入订单页查看。':result.record.status==='SUBMITTED'?'原入金交易已提交，尚未最终确认。请只读核对原记录。':result.record.status==='IDLE'?'未执行入金。请核对期限、资格、余额及准确额度后再明确提交。':'原入金未取得可确认成功的结果。请核对记录，不自动重新提交。';
  };
  submitOriginal.addEventListener('click',()=>{void run(async()=>{const generation=session.generation,funding=await getFunding();active(generation);const result=await funding.submit(agreeFunding.checked,()=>active(generation));active(generation);agreeFunding.checked=false;showFundingResult(result);});});
  reconcileFunding.addEventListener('click',()=>{void run(async()=>{const generation=session.generation,funding=await getFunding();active(generation);const result=await funding.reconcile(fundingHash.value.trim()||undefined,()=>active(generation));active(generation);showFundingResult(result);});});

  connectionCheck.addEventListener('click',()=>{void run(async()=>{
    const generation=session.generation,input=TaskInputSchema.parse((task() as {taskInput:unknown}).taskInput);
    autoFeedback.textContent='正在只读核对原买方的签署连接…';
    const result=await session.walletConnection(input.buyer,()=>active(generation));active(generation);
    autoFeedback.textContent=`签署连接已核对：钱包 ${result.wallet}，网络 ${result.chainId}。没有签署、切换网络或付款；原签署结果未知时仍需保留并核对原记录。`;
  },'connection');});
  autoConsent.addEventListener('change',updateButtons);
  autoPrepare.addEventListener('click',()=>{void run(async()=>{
    if(!disclose.checked||additional.value)throw Error('AUTOMATION_DISCLOSURE_REQUIRED');
    const generation=session.generation,refs=Array.from(list.querySelectorAll<HTMLInputElement>('input:checked')).map(x=>x.value);
    const input=TaskInputSchema.parse((task() as {taskInput:unknown}).taskInput);autoFeedback.textContent='正在只读核对签署连接…';await session.walletConnection(input.buyer,()=>active(generation));active(generation);
    const reschedule=document.querySelector<HTMLInputElement>('#agree-reschedule')!,readyReceipt=document.querySelector<HTMLInputElement>('#ready-original-receipt')!;
    if(flow.draft&&clock()>=BigInt(flow.draft.intent.deliveryDeadline)&&reschedule.checked&&options.onTaskRescheduled){if(!refs.length)refs.push(flow.draft.quote.quoteId);await flow.rescheduleOriginal(true,options.onTaskRescheduled);active(generation);reschedule.checked=false;}
    const labels={CANDIDATE:'正在生成本单候选…',DEVICE:'等待设备验证；完成前尚未申请短期限权限…',REVIEW:'正在审查本单证据…',RECEIPT:'正在为同一原单获取已确认的新回执…',PERMISSION:'正在准备一次性权限…',PREFLIGHT:'正在核对本单链状态…'};
    const result=await preparationAutomation.run(refs,windowInput.value,phase=>{active(generation);autoFeedback.textContent=labels[phase];},readyReceipt.checked);active(generation);readyReceipt.checked=false;
    paintDraft();if(flow.reviewResult)paintReview(flow.reviewResult);
    if(flow.authorization){grant.textContent=grantPreview(flow.authorization.payload.grant);grant.hidden=false;}
    if(flow.preflightSnapshot){chain.textContent=preflightPreview(flow.preflightSnapshot);chain.hidden=false;}
    autoFeedback.textContent=result==='READY'?'设备验证与自动准备完成。核对本单后，勾选联合确认并点击“确认本单权限并自动完成入金”。':result==='RECEIPT_EXPIRED'?'原回执已过期，当前候选和通过判断保留。准备好设备验证后明确申请原单续期；没有重复审核。':result==='CHAIN_BLOCKED'?'链上预检有阻塞，原候选已保留。请核对下方原因。':'当前审查未提供可执行通过，流程已停止。请核对原结果或补充真实材料。';
  },'automation');});
  autoSignBackup.addEventListener('click',()=>{void run(async()=>{
    if(!agree.checked){autoFeedback.textContent='请先核对下方本单权限并勾选签署确认。';return;}
    await ensurePrepared();const generation=session.generation;autoFeedback.textContent='正在签署本单权限…';await signOriginal();active(generation);
    autoFeedback.textContent='原权限已签署，正在使用已验证设备生成密文…';await sealOriginal();active(generation);await downloadOriginal();active(generation);
    const backup=await getBackup();active(generation);autoFeedback.textContent='已加密并请求下载，正在保存同一份密文…';await backup.upload(()=>active(generation));active(generation);
    autoFeedback.textContent='签署和密文备份完成。核对已签原单金额，确认额度与入金后可自动等待最终确认。尚未付款。';
  },'automation');});
  const completePayment=async(confirmed:boolean)=>{
    if(!confirmed)throw Error('AUTOMATIC_PAYMENT_CONFIRMATION_REQUIRED');const generation=session.generation,original=pending.get();active(generation);if(!original?.backup?.file)throw Error('ENCRYPTED_BACKUP_REQUIRED');
    const approval=await getApproval(),funding=await getFunding();active(generation);const client=new PurchaseClient(location.origin,()=>session.token()),p=AuthorizationPayloadSchema.parse(original.payload);
    paymentAutomation??=new AutomaticPayment(p,approval,funding,()=>client.preflight({intent:p.intent,grant:p.grant}),clock);
    const labels={CHECKING:'正在复核原单…',APPROVING:'正在请求本单准确额度…',APPROVAL_CONFIRMATION:'等待原额度交易最终确认…',FUNDING:'正在提交已签原订单…',FUNDING_CONFIRMATION:'等待原入金交易最终确认…'};
    const result=await paymentAutomation.run(true,()=>active(generation),phase=>{active(generation);autoFeedback.textContent=labels[phase];});active(generation);autoConsent.checked=false;
    if(result.funding)showFundingResult(result.funding);
    autoFeedback.textContent=result.status==='CONFIRMED'?'原订单入金已最终确认。继续交付、验收、分配与实际提现。':result.status==='EXPIRED'?'原授权已过期，自动推进已停止。已发生的额度或发送记录保留，请只读核对。':result.status==='BLOCKED'?'原单预检有阻塞，未自动修改其他非零额度或付款。':'原步骤未取得完整确认，原记录保留。请只读核对，不会自动重新发送。';
  };
  autoPay.addEventListener('click',()=>{void run(()=>completePayment(autoConsent.checked),'automation');});
  checkoutConsent.addEventListener('change',updateButtons);
  checkout.addEventListener('click',()=>{void run(async()=>{
    if(!checkoutConsent.checked)throw Error('AUTOMATIC_PAYMENT_CONFIRMATION_REQUIRED');await ensurePrepared();
    const generation=session.generation;autoFeedback.textContent='正在签署本单权限…';await signOriginal();active(generation);
    autoFeedback.textContent='正在加密、下载并保存本单原授权…';await sealOriginal();active(generation);await downloadOriginal();active(generation);
    const backup=await getBackup();await backup.upload(()=>active(generation));active(generation);
    await completePayment(true);active(generation);checkoutConsent.checked=false;
  },'automation');});


  handoffButton.addEventListener('click',()=>{void run(async()=>{const generation=session.generation,original=pending.get();active(generation);if(!original?.dataset||!handoffConsent.checked)throw new Error('HANDOFF_CONFIRMATION_REQUIRED');const principal=await session.verified(),configuration=await session.configuration();active(generation);if(principal.subject!==original.subject||!configuration.recoveryDeployment)throw new Error('SESSION_CHANGED');const value=await buyerDeliveryHandoff(original.payload,original.dataset,principal.wallets,configuration.recoveryDeployment,true);active(generation);const current=await session.verified();active(generation);if(current.subject!==principal.subject||!current.wallets.some(w=>w.toLowerCase()===value.payload.intent.buyer.toLowerCase())||pending.get()!==original)throw new Error('SESSION_CHANGED');downloadHandoff(value,`intentpass-delivery-${value.payload.intent.orderId}.json`);handoffConsent.checked=false;feedback.textContent='已下载给原服务商的明文资料。没有上传、发给他人或发交易；请妥善传递。';});});

}
