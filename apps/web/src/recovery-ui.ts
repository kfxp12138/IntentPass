import {z} from 'zod';
import {TaskPolicySchema} from '../../../packages/protocol/src/schemas.js';
import {EvidenceBundleSchema} from '../../../packages/protocol/src/review-evidence.js';
import {encryptCapsule,decryptCapsule,exportCapsule,importCapsule} from '../../../packages/capsule/src/crypto.js';
import {memoryNamespace,TaskInputSchema,type CapsuleFile} from '../../../packages/capsule/src/format.js';
import {createCapsulePasskey,MeraPrfSource} from '../../../packages/capsule/src/mera.js';
import {RestoredOrderContext} from './restored-order-context.js';
import {IntentPassClient} from '../../../packages/protocol/src/index.js';
import {originalOrderReadProof} from '../../../packages/capsule/src/recovery.js';
import {browserSession,type BrowserSession} from './browser-session.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import {createPasskeyReference,taskPasskeyReference,type PasskeyReferencePort} from './passkey-reference.js';
import {isIpRpId} from '../../../packages/capsule/src/rp-domain.js';
const TaskSchema=z.object({policy:TaskPolicySchema,taskInput:TaskInputSchema,evidence:EvidenceBundleSchema.optional()}).strict();
const messages:Record<string,string>={ORIGINAL_TASK_AUTHORIZATION_UNRESOLVED:'当前权限仍在处理中或结果待核对，不能用另一份备份覆盖原任务。请先核对原授权。',PRF_UNSUPPORTED:'这个 Passkey 不支持加密恢复所需的 PRF，请换用支持的设备或浏览器。',PASSKEY_CANCELLED:'你已取消 Passkey 操作，没有保存或提交数据。',RPID_MISMATCH:'当前域名无法使用这个 Passkey。请在创建时的同一站点打开文件。',PASSKEY_UNAVAILABLE:'Passkey 暂时不可用。请检查浏览器、设备和站点连接后重试。',CAPSULE_AUTH_FAILED:'无法解密：Passkey、命名空间或文件内容不匹配。',CAPSULE_TOO_LARGE:'文件超过大小限制。'};
messages.PASSKEY_DOMAIN_REQUIRED='当前是 IP 地址，不能创建 Passkey。请先把同一原任务迁移到 localhost 备份页，再完成设备确认。';
Object.assign(messages,{LOGIN_REQUIRED:'请先登录，再核对原订单。',RECOVERY_CONFIGURATION_REQUIRED:'站点尚未配置可信链上部署。已停止订单恢复，不会付款。',RECOVERY_OWNER_MISMATCH:'当前账户未关联原买方钱包，不能继续这个订单。',RECOVERY_CHAIN_UNAVAILABLE:'无法取得最新链上记录。请检查连接后重试，不会重新付款。',SESSION_CHANGED:'会话已退出或页面已切换，本次恢复结果已丢弃。',SECURE_CONTEXT_REQUIRED:'需要 HTTPS 或 localhost 才能使用 Passkey。'});
export const recoveryControls=`<h2>加密备份当前任务</h2><p class="hint">使用设备的 Passkey 加密，再下载密文文件。跨设备时打开同一站点并导入文件；请保留原文件和已同步的 Passkey。</p><button id="encrypt-task">创建 Passkey 并导出任务密文</button><h2 style="margin-top:28px">打开密文文件</h2><label>选择 IntentPass 备份<input id="capsule-file" type="file" accept="application/json,.json"></label><button id="decrypt-file">使用原 Passkey 解密</button><p class="hint">若本页已有同一原任务，可仅读取原备份的 Passkey 定位信息，用于之后加密授权。读取定位信息不等于解密恢复。</p><button id="reuse-task-passkey">为本页同一任务读取原 Passkey 定位信息</button><p id="capsule-feedback" role="status" aria-live="polite"></p><pre id="capsule-preview" hidden></pre><p class="hint">解密在当前页面完成。此入口不付款；原授权继续处理需要登录后验签并核对原链上订单。</p>`;
export function attachRecoveryControls(currentTask:()=>unknown,onMemory:(payload:unknown)=>void,onOrder:(order:OrderSnapshot)=>void,references:PasskeyReferencePort=createPasskeyReference(),restored:RestoredOrderContext|(()=>RestoredOrderContext)=new RestoredOrderContext(),session:BrowserSession=browserSession,canRestoreMemory:()=>boolean=()=>true) {
  const encrypt=document.querySelector<HTMLButtonElement>('#encrypt-task')!,decrypt=document.querySelector<HTMLButtonElement>('#decrypt-file')!,feedback=document.querySelector<HTMLElement>('#capsule-feedback')!,preview=document.querySelector<HTMLElement>('#capsule-preview')!;
  const ipSite=typeof location!=='undefined'&&isIpRpId(location.hostname);let busy=false;if(ipSite){encrypt.disabled=true;feedback.textContent=messages.PASSKEY_DOMAIN_REQUIRED;}
  const context=()=>typeof restored==='function'?restored():restored;
  const run=async(work:(assertActive:()=>void,original:RestoredOrderContext)=>Promise<void>)=>{if(busy)return;busy=true;const generation=session.generation,original=context(),assertActive=()=>{if(generation!==session.generation||original!==context()||!feedback.isConnected)throw new Error('SESSION_CHANGED');};encrypt.disabled=decrypt.disabled=true;preview.hidden=true;preview.textContent='';feedback.textContent='等待设备确认 Passkey…';
    try{if(!window.isSecureContext)throw new Error('SECURE_CONTEXT_REQUIRED');await work(assertActive,original);}catch(error){const code=error instanceof Error?error.message:'';if(generation===session.generation&&original===context()&&feedback.isConnected)feedback.textContent=messages[code]??'操作未完成。请检查备份格式、任务数据和当前站点，再重试。';}finally{busy=false;encrypt.disabled=ipSite;decrypt.disabled=false;}};
  encrypt.addEventListener('click',()=>{void run(async assertActive=>{
    const task=TaskSchema.safeParse(currentTask());if(!task.success){feedback.textContent='请先在创建任务页确认任务，再回来加密备份。';return;}
    const namespace=memoryNamespace(task.data.policy.taskId);
    const reference=references.get()??await createCapsulePasskey(location.hostname,{name:'IntentPass backup',displayName:'IntentPass 加密备份'},namespace);assertActive();references.set(reference);
    const payload={schemaVersion:1,kind:'memory',policy:task.data.policy,taskInput:task.data.taskInput,evidence:task.data.evidence??{schemaVersion:1,taskText:'购买当前数据集的 count、sum、min、max 报告，许可必须允许商业用途。',documents:[]}};
    const file=await encryptCapsule(payload,{namespace,objectId:task.data.policy.taskId,revision:'1'},reference,new MeraPrfSource(reference));
    assertActive();const url=URL.createObjectURL(new Blob([exportCapsule(file)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`intentpass-${file.capsule.objectId}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    feedback.textContent='已导出加密任务文件。未上传原文，也未发起订单或付款。';
  });});
  decrypt.addEventListener('click',()=>{void run(async(assertActive,original)=>{
    const selected=document.querySelector<HTMLInputElement>('#capsule-file')!.files?.[0];if(!selected){feedback.textContent='请先选择原加密备份文件。';return;}
    if(selected.size>1500000)throw new Error('CAPSULE_TOO_LARGE');const file=importCapsule(await selected.text()),payload=await decryptCapsule(file,new MeraPrfSource(file.keyReference));assertActive();
    if(payload.kind==='memory') {
      if(!canRestoreMemory())throw new Error('ORIGINAL_TASK_AUTHORIZATION_UNRESOLVED');
      const memory=original.restoreMemory(payload,file.keyReference);assertActive();references.set(file.keyReference);onMemory(memory);preview.textContent=JSON.stringify(memory,null,2);preview.hidden=false;
      feedback.textContent='已在页面内存恢复原任务与证据。没有提交订单或生成付款授权。';
    }else{
      const principal=await session.verified(),configuration=await session.configuration();
      const deployment=configuration.recoveryDeployment;if(!deployment)throw new Error('RECOVERY_CONFIGURATION_REQUIRED');
      const proof=originalOrderReadProof(payload);
      const result=await original.restoreAuthorization(payload,file.keyReference,principal.wallets,deployment,{read:async id=>{if(id.toLowerCase()!==proof.intent.orderId.toLowerCase())throw new Error('ORDER_ANCHOR_CHANGED');const order=await new IntentPassClient(location.origin,await session.token()).originalOrder(proof,deployment),current=await session.verified();assertActive();if(current.subject!==principal.subject||!current.wallets.some(w=>w.toLowerCase()===payload.intent.buyer.toLowerCase()))throw new Error('SESSION_CHANGED');return order;}},assertActive);
      assertActive();
      const current=await session.verified();assertActive();if(current.subject!==principal.subject||!current.wallets.some(w=>w.toLowerCase()===payload.intent.buyer.toLowerCase()))throw new Error('SESSION_CHANGED');
      references.set(file.keyReference);
      onOrder(result.order);
      preview.textContent=JSON.stringify({orderId:result.orderId,state:result.order.state,credits:result.order.credits,withdrawn:result.order.withdrawn,block:result.order.block},null,2);preview.hidden=false;
      feedback.textContent=result.continuation==='NOT_FUNDED'?'原授权已核对，但原订单尚未入金。恢复不重新下单。':result.continuation==='VIEW_ALLOCATION'?'原订单已分配资金。请分别核对应收与实际提现；恢复不再次付款。':'原授权和链上订单已核对，继续查看原订单的交付或验收状态。恢复不重新入金。';
      const link=document.createElement('a');link.href='#orders';link.textContent=' 查看原订单';feedback.append(link);
    }
  });});
  document.querySelector('#reuse-task-passkey')!.addEventListener('click',()=>{void run(async assertActive=>{
    const task=TaskSchema.parse(currentTask()),selected=document.querySelector<HTMLInputElement>('#capsule-file')!.files?.[0];if(!selected||selected.size>1500000)throw Error('CAPSULE_TOO_LARGE');
    const reference=taskPasskeyReference(JSON.parse(await selected.text()),task.policy.taskId,location.hostname,references.get());assertActive();references.set(reference);
    feedback.textContent='已读取同一原任务备份中的 Passkey 定位信息。后续加密仍需设备确认；此步尚未解密文件，也没有付款。';
  });});
}
