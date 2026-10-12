import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import type {FundingResult} from '../../../packages/protocol/src/funding-api.js';
import {PurchaseClient} from '../../../packages/protocol/src/purchase-client.js';
import {OriginalFundingFlow,type OriginalFundingPort} from './original-funding-flow.js';
import {browserSession,type BrowserSession} from './browser-session.js';

export type RestoredFundingPort=Pick<OriginalFundingPort,'reconcileFunding'>;
export interface RestoredFundingObservation {
  orderId:string;
  contextHash:string;
  attemptId:string|null;
  status:FundingResult['record']['status'];
  hash:string|null;
  providerAssociation:'RECORDED'|'NOT_RECORDED';
  chain:{state:string;blockNumber:string;blockHash:string;timestamp:string}|null;
}
export interface RestoredFundingState {
  phase:'NOT_QUERIED'|'CURRENT'|'STALE'|'UNAVAILABLE';
  observation?:RestoredFundingObservation;
}

/** RAM-only public projection of the original durable attempt. The only port
 * operation is reconciliation; no payment, signer or hash input is exposed.
 */
export class RestoredFundingReader {
  private readonly payload:ReturnType<typeof AuthorizationPayloadSchema.parse>;
  private readonly generation:number;
  private readonly reconcile:RestoredFundingPort['reconcileFunding']|undefined;
  private flow:OriginalFundingFlow|undefined;
  private subject:string|undefined;
  private busy=false;
  private latest:RestoredFundingState={phase:'NOT_QUERIED'};
  constructor(input:unknown,private session:BrowserSession=browserSession,client?:RestoredFundingPort){
    this.payload=AuthorizationPayloadSchema.parse(input);
    this.generation=session.generation;
    this.reconcile=client?.reconcileFunding.bind(client);
  }
  get state():RestoredFundingState{return structuredClone(this.latest);}
  async query(active:()=>void=()=>{}):Promise<RestoredFundingState>{
    if(this.busy)throw new Error('RESTORED_FUNDING_PENDING');
    this.busy=true;
    const guard=()=>{active();if(this.generation!==this.session.generation)throw new Error('SESSION_CHANGED');};
    const current=async()=>{
      guard();const principal=await this.session.verified();guard();
      if(this.subject!==undefined&&principal.subject!==this.subject)throw new Error('SESSION_CHANGED');
      if(!principal.wallets.some(w=>w.toLowerCase()===this.payload.grant.owner.toLowerCase()))throw new Error(this.subject===undefined?'RESTORED_FUNDING_OWNER_REQUIRED':'SESSION_CHANGED');
      this.subject??=principal.subject;
      return principal;
    };
    try{
      const principal=await current();
      if(!this.flow){
        const client=this.reconcile?undefined:new PurchaseClient(location.origin,()=>this.session.token());
        const reconcile=this.reconcile??client!.reconcileFunding.bind(client!);
        this.flow=new OriginalFundingFlow(this.payload,principal.subject,()=>false,this.session,{
          submitOriginal:async()=>{throw new Error('RESTORED_FUNDING_READ_ONLY');},
          reconcileFunding:async request=>{
            await current();
            const result=structuredClone(await reconcile(request));
            await current();
            return result;
          }
        });
      }
      const result=await this.flow.reconcile(undefined,guard);
      await current();guard();
      const {record,snapshot}=result;
      const observation:RestoredFundingObservation={orderId:record.anchor.orderId,contextHash:record.anchor.contextHash,attemptId:record.attempt,status:record.status,hash:record.hash,providerAssociation:record.providerSubmission?'RECORDED':'NOT_RECORDED',chain:!result.error&&snapshot?{state:snapshot.state,blockNumber:snapshot.block.number,blockHash:snapshot.block.hash,timestamp:snapshot.block.timestamp}:null};
      if(result.error){
        this.latest={phase:'STALE',observation:this.latest.observation??observation};
        throw new Error('RESTORED_FUNDING_UNAVAILABLE');
      }
      this.latest={phase:'CURRENT',observation};
      return this.state;
    }catch(error){
      guard();
      if(error instanceof Error&&error.message==='SESSION_CHANGED')throw new Error('SESSION_CHANGED');
      // A failed read must not publish into a different principal, even when
      // the provider failed before the normal post-response identity check.
      if(this.subject!==undefined){
        try{await current();}catch(check){guard();if(check instanceof Error&&check.message==='SESSION_CHANGED')throw new Error('SESSION_CHANGED');}
      }
      guard();this.latest={...this.latest,phase:this.latest.observation?'STALE':'UNAVAILABLE'};
      throw new Error('RESTORED_FUNDING_UNAVAILABLE');
    }finally{this.busy=false;}
  }
}

export function restoredFundingText(state:RestoredFundingState):string{
  const o=state.observation;
  if(!o)return state.phase==='UNAVAILABLE'?'本次无法核对原入金记录；发送状态未知。没有重新付款。':'尚未核对原入金发送记录。';
  const status:Record<RestoredFundingObservation['status'],string>={
    IDLE:'未保存发送尝试；不能据此证明外部从未广播。',
    IN_FLIGHT:'原发送尝试仍在处理中；结果未知，不能再次付款。',
    UNKNOWN:'原发送结果未知；没有 hash 也可能已广播，不能再次付款。',
    SUBMITTED:'已保存原交易 hash；尚不代表最终入金或到账。',
    CONFIRMED:'服务端保存了原入金确认状态；不代表分配或领取。',
    RECONCILED:'链上原订单已存在；本记录没有绑定准确的原入金交易 hash。',
    REVERTED:'原入金交易已回滚；恢复面板不提供重新付款。',
    BLOCKED:'原发送记录已阻塞；恢复面板不提供重发。'
  };
  const chain=o.chain?state.phase==='STALE'?`上次链订单：${o.chain.state==='UNREGISTERED'?'NOT_FUNDED（尚未入金）':o.chain.state}\n上次区块：${o.chain.blockNumber}\n上次区块 hash：${o.chain.blockHash}\n上次区块时间：${o.chain.timestamp}\n本次链快照不可用；不能确认当前入金状态。`:`原链订单：${o.chain.state==='UNREGISTERED'?'NOT_FUNDED（尚未入金）':o.chain.state}\n核对区块：${o.chain.blockNumber}\n区块 hash：${o.chain.blockHash}\n区块时间：${o.chain.timestamp}`:'本次链快照不可用；不能确认当前入金状态。';
  return [state.phase==='STALE'?'保留的原发送记录（本次核对失败，不代表当前链状态）':'本次原记录核对结果',`原订单：${o.orderId}`,`原上下文：${o.contextHash}`,`原发送尝试：${o.attemptId??'未保存'}`,`原发送状态：${o.status}`,status[o.status],`原交易 hash：${o.hash??'未保存；不代表未发送'}`,`Provider 关联：${o.providerAssociation==='RECORDED'?'已保存原 SDK 发送响应关联':'未保存原 provider 关联信息'}`,'Provider 关联不是最终确认或历史策略来源证明。',chain,'交易 hash 不等于到账，分配不等于领取。此面板只核对原记录，没有重新授权或付款入口。'].join('\n');
}
