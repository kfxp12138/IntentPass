import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {checkFundingResponse,FundingResultSchema,type FundingResult} from '../../../packages/protocol/src/funding-api.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {sameProviderSubmission} from '../../../packages/protocol/src/provider-submission.js';
import {browserSession,type BrowserSession} from './browser-session.js';
export interface OriginalFundingPort {submitOriginal:(request:unknown)=>Promise<unknown>;reconcileFunding:(request:unknown)=>Promise<unknown>;}
/** Explicit confirmation sends once. Query, view changes and restore do not submit. */
export class OriginalFundingFlow {
  private payload:ReturnType<typeof AuthorizationPayloadSchema.parse>;
  private attempted=false;
  private busy=false;
  private unknown=false;
  private latest:FundingResult|undefined;
  constructor(input:unknown,private subject:string,private backupReady:()=>boolean,private session:BrowserSession=browserSession,private client:OriginalFundingPort=new PurchaseClient(location.origin,()=>session.token())){this.payload=AuthorizationPayloadSchema.parse(input);}
  get state(){return {attempted:this.attempted,unknown:this.unknown,result:this.latest?FundingResultSchema.parse(this.latest):undefined};}
  private async current(active:()=>void){active();const principal=await this.session.verified(),config=await this.session.configuration();active();if(principal.subject!==this.subject||!config.recoveryDeployment)throw new Error('SESSION_CHANGED');await verifyOriginalAuthorization(this.payload,principal.wallets,config.recoveryDeployment);active();}
  private async exclusive<T>(work:()=>Promise<T>){if(this.busy)throw new Error('FUNDING_OPERATION_PENDING');this.busy=true;try{return await work();}finally{this.busy=false;}}
  private storeResult(input:unknown){const r=checkFundingResponse(this.payload,input);if('status'in r)throw new Error('FUNDING_REQUEST_REJECTED');
    const old=this.latest;if(old?.record.hash&&r.record.hash&&old.record.hash.toLowerCase()!==r.record.hash.toLowerCase())throw new Error('FUNDING_HASH_LOCKED');
    if(old&&(old.record.attempt&&old.record.attempt!==r.record.attempt||old.record.hash&&!r.record.hash||['CONFIRMED','REVERTED'].includes(old.record.status)&&r.record.status!==old.record.status||old.record.status!=='IDLE'&&r.record.status==='IDLE'))throw new Error('FUNDING_RECORD_LOCKED');
    if(old?.record.providerSubmission&&(!r.record.providerSubmission||old.record.attempt!==r.record.attempt||!sameProviderSubmission(old.record.providerSubmission,r.record.providerSubmission)))throw new Error('FUNDING_PROVIDER_SUBMISSION_LOCKED');
    if(old?.snapshot&&r.snapshot&&(BigInt(r.snapshot.block.number)<BigInt(old.snapshot.block.number)||r.snapshot.block.number===old.snapshot.block.number&&r.snapshot.block.hash!==old.snapshot.block.hash))throw new Error('FUNDING_SNAPSHOT_STALE');
    if(old?.snapshot?.state.startsWith('ALLOCATED_')&&r.snapshot&&r.snapshot.state!==old.snapshot.state)throw new Error('FUNDING_TERMINAL_CHANGED');
    this.latest=r;this.unknown=r.record.status==='UNKNOWN'||r.record.status==='IN_FLIGHT'||!!r.error;return r;
  }
  submit(confirm:boolean,active:()=>void=()=>{}){return this.exclusive(async()=>{
    const generation=this.session.generation,guard=()=>{active();if(this.session.generation!==generation)throw new Error('SESSION_CHANGED');};
    if(confirm!==true)throw new Error('FUNDING_CONFIRMATION_REQUIRED');if(!this.backupReady())throw new Error('ENCRYPTED_BACKUP_REQUIRED');if(this.attempted)throw new Error('FUNDING_RECONCILIATION_REQUIRED');
    await this.current(guard);guard();this.attempted=true;
    try{const r=this.storeResult(await this.client.submitOriginal({payload:structuredClone(this.payload),confirm:true}));await this.current(guard);
      // The server proves no send lease was acquired. Any further try is a new explicit action.
      if(r.record.status==='IDLE'&&r.record.attempt===null&&r.record.hash===null)this.attempted=false;return r;
    }catch(error){this.unknown=true;throw error;}
  });}
  reconcile(hash?:string,active:()=>void=()=>{}){return this.exclusive(async()=>{
    const generation=this.session.generation,guard=()=>{active();if(this.session.generation!==generation)throw new Error('SESSION_CHANGED');};await this.current(guard);
    try{const r=this.storeResult(await this.client.reconcileFunding({payload:structuredClone(this.payload),...(hash?{hash}:{})}));await this.current(guard);
    if(r.record.status!=='IDLE')this.attempted=true;return r;}catch(error){this.unknown=true;throw error;}
  });}
}

export function originalFundingPreview(input:unknown){const p=AuthorizationPayloadSchema.parse(input),g=p.grant,e=p.intent;return `已签原订单：${g.orderId}\n原买方：${g.owner}\n服务商：${e.seller}\n收款方：${e.payee}\n受限执行者：${g.executor}\n固定网络：${g.chainId}\n托管合约：${g.arbiter}\n资产：${g.asset}\n价格：${e.price}\n保证金：${e.bond}\n准确入金：${g.amount}\n原预算上限：${p.policy.budget}\n授权 nonce：${g.nonce}\n授权截止（Unix 秒）：${g.deadline}\n原数据集摘要：${e.datasetHash}\n原上下文：${g.contextHash}\n金额均为资产最小单位。原签权限参数不代表已批准额度或已入金。\n\n原报价许可：\n${p.quote.serviceTerms}\n\n全部原证据：\n${p.evidence.documents.map(doc=>`${doc.id}\n${doc.text}`).join('\n\n')}`;}
