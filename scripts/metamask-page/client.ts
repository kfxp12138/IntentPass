import {formatEther} from 'viem';
import {MetaMaskDeploymentFlow,type MetaMaskProvider} from '../metamask-wallet.js';
import {MetaMaskWalletPlanSchema,MetaMaskPreflightSchema,type MetaMaskWalletPlan,type MetaMaskStatus,type MetaMaskGateStatus,type MetaMaskPreflight,type MetaMaskAttempt} from '../metamask-types.js';
import {MetaMaskPreflightRejected,MetaMaskNoReservationResponseSchema} from '../metamask-preflight-rejection.js';
import {strictJsonParse} from '../strict-json.js';
const element=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const text=(id:string,value:string)=>{element(id).textContent=value;};
const button=(id:string,disabled:boolean)=>{element<HTMLButtonElement>(id).disabled=disabled;};
const gateMode=document.documentElement.dataset.deployment==='gate',expectedScope=gateMode?'LOCAL_OPERATOR_CLEANVERSE_GATE_HANDOFF':'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF';
let status:MetaMaskStatus|MetaMaskGateStatus,check:MetaMaskPreflight|undefined,flow:MetaMaskDeploymentFlow|undefined,busy=false,observedProvider:MetaMaskProvider|undefined;
let expiryTimer:ReturnType<typeof setTimeout>|undefined,countdownTimer:ReturnType<typeof setInterval>|undefined;
const preflightLifetime=60_000;
function clearPreflightTimers(){if(expiryTimer!==undefined)clearTimeout(expiryTimer);if(countdownTimer!==undefined)clearInterval(countdownTimer);expiryTimer=undefined;countdownTimer=undefined;}
function validPreflight(value:MetaMaskPreflight){const started=Date.parse(value.checkedAt),now=Date.now();return Number.isFinite(started)&&now>=started&&now<started+preflightLifetime;}
function discardPreflight(message:string){clearPreflightTimers();check=undefined;const box=element<HTMLInputElement>('confirm');box.checked=false;box.disabled=true;button('send',true);text('fees',message);}
function expirePreflight(){discardPreflight('预检已过期或时间发生变化。请重新核对部署与手续费，再次勾选确认。');}
function showPreflightLifetime(selected:MetaMaskPreflight,fees:string){
  clearPreflightTimers();
  const paint=()=>{if(check!==selected)return;if(!validPreflight(selected)){expirePreflight();return;}const seconds=Math.ceil((Date.parse(selected.checkedAt)+preflightLifetime-Date.now())/1000);text('fees',`${fees}\n预检剩余 ${seconds} 秒；到期后需重新核对。`);};
  paint();if(check!==selected)return false;
  countdownTimer=setInterval(paint,1000);
  expiryTimer=setTimeout(()=>{if(check===selected)expirePreflight();},Math.max(0,Date.parse(selected.checkedAt)+preflightLifetime-Date.now()));
  return true;
}
function clearHooks(){for(const name of ['accountsChanged','chainChanged','disconnect'])observedProvider?.removeListener?.(name,invalidate);observedProvider=undefined;}
async function api<T>(path:string,body?:unknown):Promise<T>{const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',redirect:'error'}),raw=await response.text();if(raw.length>160000)throw new Error('RESPONSE_INVALID');const value=JSON.parse(raw);if(!response.ok){if(path==='/api/reserve'&&response.status===409){const rejected=MetaMaskNoReservationResponseSchema.safeParse(strictJsonParse(raw));if(rejected.success)throw new MetaMaskPreflightRejected(rejected.data.code);}throw new Error(value&&typeof value.code==='string'?value.code:'CHECK_UNAVAILABLE');}return value;}
function describe(error:unknown){if(error instanceof MetaMaskPreflightRejected)return `${error.message==='DEPLOYMENT_PREFLIGHT_EXPIRED'?'预检已过期':'部署或手续费条件已变化'}。本次未创建发送预留，也未请求签名或发送交易。请重新核对部署与手续费，再次勾选确认。`;const code=error instanceof Error?error.message:'';return /^[A-Z_]+$/.test(code)?`暂未完成：${code}。请先核对钱包活动和当前配置。`:'暂未完成，请核对钱包活动和当前配置。';}
function invalidate(){discardPreflight('钱包或网络变化后，请重新核对。');}
function deploymentName(plan:MetaMaskWalletPlan|null){
  if(plan&&'kind'in plan){
    if(plan.kind==='CLEANVERSE_GATE')return '历史门控';
    return plan.dependency==='ASSET'?'普通 ERC20 测试资产':'固定资产检查';
  }
  return '托管';
}
function describeAttempt(attempt:MetaMaskAttempt){
  if(attempt.status==='CONFIRMED')return `本项部署已确认，${attempt.contractAddress?`原合约地址 ${attempt.contractAddress}`:'原合约地址尚未记录，请只读核对原交易'}。`;
  if(attempt.status==='REVERTED')return '原创建交易已回滚，原部署记录已保留。';
  if(attempt.status==='SUBMITTED')return '原创建交易已记录，待只读核对确认。';
  return '已有部署预留，原交易发送结果待核对。';
}
async function refresh(){
  status=await api<MetaMaskStatus|MetaMaskGateStatus>('/api/status');if(status.scope!==expectedScope)throw new Error('RESPONSE_INVALID');
  if(status.plan){const parsed=MetaMaskWalletPlanSchema.parse(status.plan);if(gateMode!==('kind'in parsed&&parsed.kind==='CLEANVERSE_GATE'))throw new Error('RESPONSE_INVALID');status.plan=parsed;}
  const remainingBlockers=status.attempt?status.blockers.filter(code=>code!=='DEPLOYMENT_ATTEMPT_ALREADY_RESERVED'):status.blockers;
  text('status',status.attempt?`${describeAttempt(status.attempt)}${remainingBlockers.length?` 仍需处理：${remainingBlockers.join('、')}`:''}`:status.ready?'固定部署参数已准备，下一步连接部署钱包。':`仍需准备：${status.blockers.join('、')}`);
  const title=document.getElementById('deployment-title');if(title)title.textContent=`用 MetaMask 部署${deploymentName(status.plan)}合约`;
  const dl=element('plan');dl.replaceChildren();if(status.plan){
    const plan=status.plan,fields:[string,string][]=[['网络','Monad Testnet / 10143'],['部署账户',plan.deployer]];
    if('kind'in plan&&plan.kind==='DEMO_DEPENDENCY'){
      if(plan.dependency==='ASSET')fields.push(['测试代币初始接收者',plan.recipient!]);
      else fields.push(['固定测试资产',plan.asset!]);
    }else if('kind'in plan){
      fields.push(['历史资产合约',plan.asset],['历史 CVI 验证器（旧路线）',plan.validator],['历史资产策略（旧路线）',plan.policy],['门控固定 nonce',BigInt(plan.gateNonce).toString()],['后续托管预期地址',plan.pool],['后续托管创建摘要（仅预览）',plan.escrowInitCodeHash]);
    }else{
      fields.push(['普通 ERC20 测试资产合约',plan.asset],['固定资产检查合约',plan.gate],['审核签署者',plan.reviewer],['三位验收成员',plan.committee.join(' / ')]);
    }
    fields.push(['源码版本',plan.sourceCommit],['本次创建数据摘要',plan.initCodeHash]);
    for(const [label,value] of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);}
  }
  button('check',!flow||!status.ready||busy);button('recover',!status.attempt||!!status.attempt.transactionHash||busy);button('reconcile',!status.attempt?.transactionHash||busy);
  if(status.attempt){text('result',`${describeAttempt(status.attempt)} 原记录源码版本 ${status.attempt.sourceCommit}。请只读核对原交易，页面不会重新发送。`);if(status.attempt.transactionHash)element<HTMLInputElement>('hash').value=status.attempt.transactionHash;else try{const saved=JSON.parse(localStorage.getItem(`intentpass-deployment:${status.attempt.planId}`)??'null');if(saved?.planId===status.attempt.planId&&saved?.attemptId===status.attempt.attemptId&&typeof saved.transactionHash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(saved.transactionHash))element<HTMLInputElement>('hash').value=saved.transactionHash;}catch{/* Manual recovery from wallet activity is still available. */}}
}
async function run(fn:()=>Promise<void>){if(busy)return;busy=true;button('connect',true);button('check',true);button('send',true);try{await fn();}catch(error){if(error instanceof MetaMaskPreflightRejected)discardPreflight('部署或手续费条件已变化。请重新核对，再次勾选确认。');const sent=flow?.submitted;if(sent)element<HTMLInputElement>('hash').value=sent.transactionHash;text('result',`${describe(error)}${sent?` 已返回原哈希：${sent.transactionHash}。仅核对这笔原交易。`:''}`);}finally{busy=false;button('connect',false);try{await refresh();}catch(error){text('status',describe(error));}}}
element('connect').onclick=()=>void run(async()=>{
  invalidate();clearHooks();flow?.dispose();
  const provider=(window as Window&{ethereum?:MetaMaskProvider}).ethereum;if(!provider?.isMetaMask)throw new Error('METAMASK_REQUIRED');
  flow=new MetaMaskDeploymentFlow(provider,{reserve:input=>api('/api/reserve',input),recordHash:input=>api('/api/record-hash',input)},{currentProvider:()=>(window as Window&{ethereum?:MetaMaskProvider}).ethereum,saveHash:(attempt,hash)=>{
    element<HTMLInputElement>('hash').value=hash;
    try{localStorage.setItem(`intentpass-deployment:${attempt.planId}`,JSON.stringify({planId:attempt.planId,attemptId:attempt.attemptId,transactionHash:hash}));}catch{/* The visible hash remains available even if storage is unavailable. */}
  }});
  observedProvider=provider;provider.on?.('accountsChanged',invalidate);provider.on?.('chainChanged',invalidate);provider.on?.('disconnect',invalidate);
  const wallet=await flow.connect();text('wallet',`账户 ${wallet.account} · 网络 ${wallet.chainId} · 余额 ${formatEther(BigInt(wallet.balance))} MON`);
});
element('check').onclick=()=>void run(async()=>{invalidate();if(!flow||!status.plan)throw new Error('METAMASK_REQUIRED');const selected=MetaMaskPreflightSchema.parse(await api('/api/preflight',{}));await flow.checkWallet(status.plan,selected);check=selected;const fees=`预期${deploymentName(status.plan)}合约 ${check.predictedAddress}；本次最高手续费 ${formatEther(BigInt(check.estimatedMaxCost))} MON（钱包确认前仍会核对${gateMode?'；后续托管部署另行核验和确认':''}）。`;if(!showPreflightLifetime(check,fees)){text('result','预检已过期。没有请求钱包发送，请重新核对。');return;}element<HTMLInputElement>('confirm').disabled=false;text('result','钱包账户、网络和交易序号已只读核对，尚未请求钱包发送。');});
element('confirm').onchange=()=>{if(check&&!validPreflight(check)){expirePreflight();return;}button('send',busy||!flow||!check||!status.ready||!element<HTMLInputElement>('confirm').checked);};
element('send').onclick=()=>{if(check&&!validPreflight(check)){expirePreflight();text('result','预检已过期。没有请求钱包发送，请重新核对。');return;}void run(async()=>{const selected=check;if(!selected||!flow||!status.plan)throw new Error('DEPLOYMENT_PREFLIGHT_REQUIRED');const confirmed=element<HTMLInputElement>('confirm').checked;invalidate();text('result','请在 MetaMask 中核对创建交易并自行确认；当前等待钱包结果。');const result=await flow.send(status.plan,selected,confirmed);text('result',`原交易 ${result.transactionHash}。已记录，尚未证明部署成功。`);});};
element('recover').onclick=()=>void run(async()=>{if(!status.plan||!status.attempt)throw new Error('DEPLOYMENT_ATTEMPT_REQUIRED');await api<MetaMaskAttempt>('/api/record-hash',{planId:status.plan.planId,attemptId:status.attempt.attemptId,transactionHash:element<HTMLInputElement>('hash').value.trim()});});
element('reconcile').onclick=()=>void run(async()=>{const result=await api<{attempt:MetaMaskAttempt;proof:{status:string;contractAddress?:string}|null}>('/api/reconcile',{});text('proof',result.proof?.status==='CONFIRMED'?`原${deploymentName(status.plan)}创建交易已 finalized，合约 ${result.proof.contractAddress} 的固定代码与参数一致；实际入金、资金分配与领取须分别核对原交易。`:`原交易核对：${result.proof?.status??'尚无原哈希'}。`);});
window.addEventListener('pagehide',()=>{clearPreflightTimers();check=undefined;clearHooks();flow?.dispose();});
void refresh().catch(error=>text('status',describe(error)));
