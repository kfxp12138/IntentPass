import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { address,digest,positiveUint } from '../../protocol/src/schemas.js';
import {encodeFunctionData,keccak256,type Hex} from 'viem';
import {escrowAbi} from '../../protocol/src/escrow-abi.js';
import {checkProviderSubmission,type ProviderSubmission} from '../../protocol/src/provider-submission.js';

export const trackedOrderSchema=z.object({chainId:positiveUint,arbiter:address,orderId:digest,contextHash:digest,buyer:address,seller:address,payee:address}).strict();
export type TrackedOrder=z.infer<typeof trackedOrderSchema>;
export type AttemptStatus='IDLE'|'IN_FLIGHT'|'SUBMITTED'|'UNKNOWN'|'CONFIRMED'|'RECONCILED'|'REVERTED'|'BLOCKED';
export type SettlementAction='settle'|'timeout';
export interface SettlementRecord {
  key:string;order:TrackedOrder;status:AttemptStatus;attempt:string|null;action:SettlementAction|null;
  leaseUntil:number|null;txHash:string|null;error:string|null;providerSubmission?:ProviderSubmission;
}
export interface SettlementSubmission {attempt:string;action:SettlementAction;hash:string;providerSubmission?:ProviderSubmission;}
const keyOf=(o:TrackedOrder)=>`${o.chainId}:${o.arbiter.toLowerCase()}:${o.orderId.toLowerCase()}`;
const canonical=(o:TrackedOrder)=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,k==='chainId'?v:v.toLowerCase()])) as TrackedOrder;

/** Only public on-chain anchors and submission metadata; no plaintext tasks, evidence or keys. */
export class SettlementStore {
  private db:DatabaseSync;
  constructor(path:string) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settlement_orders (
        key TEXT PRIMARY KEY, order_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'IDLE',
        attempt TEXT, action TEXT, lease_until INTEGER, tx_hash TEXT, error TEXT,
        CHECK(status IN ('IDLE','IN_FLIGHT','SUBMITTED','UNKNOWN','CONFIRMED','RECONCILED','REVERTED','BLOCKED')),
        CHECK(action IS NULL OR action IN ('settle','timeout'))
      ) STRICT;`);
    this.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS settlement_send_reservations(attempt TEXT PRIMARY KEY,key TEXT NOT NULL,action TEXT NOT NULL,order_json TEXT NOT NULL,CHECK(action IN ('settle','timeout'))) STRICT;
        CREATE TABLE IF NOT EXISTS settlement_broadcast_history(attempt TEXT PRIMARY KEY,hash TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS settlement_provider_history(attempt TEXT PRIMARY KEY,transaction_id TEXT NOT NULL UNIQUE,provider_json TEXT NOT NULL) STRICT;`);
      for(const row of this.db.prepare('SELECT key,order_json,attempt,action,tx_hash FROM settlement_orders WHERE attempt IS NOT NULL').all()){
        if(row.action!=='settle'&&row.action!=='timeout')throw Error('PROVIDER_SUBMISSION_CONFLICT');
        this.reserveHistory(String(row.key),String(row.attempt),row.action,trackedOrderSchema.parse(JSON.parse(String(row.order_json))));
        if(row.tx_hash!==null)this.bindHash(String(row.attempt),digest.parse(row.tx_hash).toLowerCase());
      }
    });
  }
  register(input:unknown):SettlementRecord {
    const order=canonical(trackedOrderSchema.parse(input)),key=keyOf(order);
    this.db.prepare('INSERT INTO settlement_orders(key,order_json) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(key,JSON.stringify(order));
    const record=this.get(key)!;
    if(JSON.stringify(record.order)!==JSON.stringify(order)) throw new Error('ORDER_ANCHOR_CONFLICT');
    return record;
  }
  get(key:string):SettlementRecord|undefined {
    const row=this.db.prepare('SELECT * FROM settlement_orders WHERE key=?').get(key);
    if(!row)return undefined;
    const record:SettlementRecord={key:String(row.key),order:trackedOrderSchema.parse(JSON.parse(String(row.order_json))),status:row.status as AttemptStatus,
      attempt:row.attempt===null?null:String(row.attempt),action:row.action as SettlementAction|null,
      leaseUntil:row.lease_until===null?null:Number(row.lease_until),txHash:row.tx_hash===null?null:String(row.tx_hash),error:row.error===null?null:String(row.error)};
    if(record.attempt&&record.txHash){const submission=this.submission(record.key,record.attempt);if(submission){if(submission.hash!==record.txHash.toLowerCase()||submission.action!==record.action)throw Error('PROVIDER_SUBMISSION_CONFLICT');if(submission.providerSubmission)record.providerSubmission=submission.providerSubmission;}}
    return record;
  }
  /** Atomic across separate SQLite connections. An expired send lease never becomes retryable. */
  acquire(key:string,action:SettlementAction,now:number,leaseMs=30000):string|undefined {
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(leaseMs)||leaseMs<=0||!Number.isSafeInteger(now+leaseMs))throw new Error('LEASE_INVALID');
    return this.transaction(()=>{const attempt=randomUUID();
    const changed=this.db.prepare("UPDATE settlement_orders SET status='IN_FLIGHT',attempt=?,action=?,lease_until=?,error=NULL WHERE key=? AND status='IDLE'").run(attempt,action,now+leaseMs,key).changes;
    if(changed!==1)return undefined;this.reserveHistory(key,attempt,action,this.get(key)!.order);return attempt;});
  }
  expire(key:string,now:number):void {
    this.db.prepare("UPDATE settlement_orders SET status='UNKNOWN',error='SEND_LEASE_EXPIRED',lease_until=NULL WHERE key=? AND status='IN_FLIGHT' AND lease_until<=?").run(key,now);
  }
  broadcast(key:string,attempt:string,txHash:string,providerSubmission?:ProviderSubmission):void {
    const hash=digest.parse(txHash).toLowerCase();this.transaction(()=>{
      const reserved=this.reservation(key,attempt),record=this.get(key);if(!record||JSON.stringify(record.order)!==JSON.stringify(reserved.order))throw Error('STALE_ATTEMPT');
      const metadata=providerSubmission===undefined?undefined:this.metadata(providerSubmission,reserved);
      if(record.attempt===attempt){
        if(record.action!==reserved.action||record.txHash&&record.txHash.toLowerCase()!==hash)throw Error('PROVIDER_SUBMISSION_CONFLICT');
        if(['IN_FLIGHT','UNKNOWN'].includes(record.status))this.db.prepare("UPDATE settlement_orders SET status='SUBMITTED',tx_hash=?,lease_until=NULL,error=NULL WHERE key=? AND attempt=?").run(hash,key,attempt);
        else if(!['SUBMITTED','CONFIRMED','REVERTED','RECONCILED'].includes(record.status))throw Error('STALE_ATTEMPT');
      }
      this.bindHash(attempt,hash);if(metadata)this.bindProvider(attempt,metadata);
    });
  }
  finish(key:string,attempt:string,status:'UNKNOWN'|'BLOCKED'|'CONFIRMED'|'REVERTED',error:string|null=null):void {
    // Error codes are fixed by worker; never store provider messages, request bodies or credentials.
    if(error!==null&&!/^[A-Z0-9_]{1,80}$/.test(error))throw new Error('ERROR_CODE_INVALID');
    const allowed=status==='CONFIRMED'||status==='REVERTED'?['SUBMITTED']:['IN_FLIGHT'];
    const changed=this.db.prepare(`UPDATE settlement_orders SET status=?,lease_until=NULL,error=? WHERE key=? AND attempt=? AND status IN (${allowed.map(()=>'?').join(',')})`).run(status,error,key,attempt,...allowed).changes;
    if(changed!==1) {
      const current=this.get(key);
      if(current?.attempt!==attempt||current.status!==status||current.error!==error)throw new Error('STALE_ATTEMPT');
    }
  }
  /** Caller must first prove the exact original canonical finalized transaction.
   * Missing/pending provider observations must never bind an arbitrary hash.
   */
  provenBroadcast(key:string,attempt:string,action:SettlementAction,txHash:string):void {
    const hash=digest.parse(txHash).toLowerCase();this.transaction(()=>{
    const reserved=this.reservation(key,attempt);if(reserved.action!==action)throw Error('STALE_ATTEMPT');
    const changed=this.db.prepare("UPDATE settlement_orders SET status='SUBMITTED',tx_hash=?,lease_until=NULL,error=NULL WHERE key=? AND attempt=? AND action=? AND tx_hash IS NULL AND status IN ('UNKNOWN','RECONCILED')").run(txHash.toLowerCase(),key,attempt,action).changes;
    if(changed!==1)throw new Error('STALE_ATTEMPT');this.bindHash(attempt,hash);});
  }
  reconcile(key:string):void {
    this.db.prepare("UPDATE settlement_orders SET status='RECONCILED',lease_until=NULL,error=NULL WHERE key=? AND status IN ('IDLE','UNKNOWN','BLOCKED','REVERTED')").run(key);
  }
  /** Explicit retry only after a confirmed revert or before any broadcast. UNKNOWN cannot be retried. */
  retryBlocked(key:string):void {
    const changed=this.db.prepare("UPDATE settlement_orders SET status='IDLE',attempt=NULL,action=NULL,lease_until=NULL,tx_hash=NULL,error=NULL WHERE key=? AND status IN ('BLOCKED','REVERTED')").run(key).changes;
    if(changed!==1)throw new Error('RETRY_UNSAFE');
  }
  /** Original attempt records survive explicit retries and late acknowledgements. */
  listSubmissions(key:string):SettlementSubmission[]{return this.db.prepare('SELECT r.attempt FROM settlement_send_reservations r JOIN settlement_broadcast_history h ON h.attempt=r.attempt WHERE r.key=? ORDER BY h.rowid').all(key).map(row=>this.submission(key,String(row.attempt))!);}
  private transaction<T>(operation:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private reserveHistory(key:string,attempt:string,action:SettlementAction,order:TrackedOrder){const json=JSON.stringify(order),old=this.db.prepare('SELECT key,action,order_json FROM settlement_send_reservations WHERE attempt=?').get(attempt);
    if(old){if(old.key!==key||old.action!==action||old.order_json!==json)throw Error('PROVIDER_SUBMISSION_CONFLICT');return;}
    this.db.prepare('INSERT INTO settlement_send_reservations VALUES(?,?,?,?)').run(attempt,key,action,json);}
  private reservation(key:string,attempt:string):{action:SettlementAction;order:TrackedOrder}{const row=this.db.prepare('SELECT key,action,order_json FROM settlement_send_reservations WHERE attempt=?').get(attempt);if(!row||row.key!==key)throw Error('STALE_ATTEMPT');if(row.action!=='settle'&&row.action!=='timeout')throw Error('PROVIDER_SUBMISSION_CONFLICT');return {action:row.action,order:trackedOrderSchema.parse(JSON.parse(String(row.order_json)))};}
  private metadata(input:unknown,reserved:{action:SettlementAction;order:TrackedOrder}){const {order,action}=reserved,data=encodeFunctionData({abi:escrowAbi,functionName:action,args:[order.orderId as Hex]}),value=checkProviderSubmission(input,{chainId:order.chainId,to:order.arbiter,calldataHash:keccak256(data)});return {...value,from:value.from.toLowerCase(),to:value.to.toLowerCase(),calldataHash:value.calldataHash.toLowerCase()};}
  private bindHash(attempt:string,hash:string){const old=this.db.prepare('SELECT hash FROM settlement_broadcast_history WHERE attempt=?').get(attempt);if(old){if(old.hash!==hash)throw Error('PROVIDER_SUBMISSION_CONFLICT');return;}this.db.prepare('INSERT INTO settlement_broadcast_history VALUES(?,?)').run(attempt,hash);}
  private bindProvider(attempt:string,metadata:ProviderSubmission){const json=JSON.stringify(metadata),old=this.db.prepare('SELECT provider_json FROM settlement_provider_history WHERE attempt=?').get(attempt);
    if(old){if(old.provider_json!==json)throw Error('PROVIDER_SUBMISSION_CONFLICT');return;}
    if(this.db.prepare('SELECT 1 FROM settlement_provider_history WHERE transaction_id=?').get(metadata.transactionId))throw Error('PROVIDER_SUBMISSION_CONFLICT');this.db.prepare('INSERT INTO settlement_provider_history VALUES(?,?,?)').run(attempt,metadata.transactionId,json);}
  private submission(key:string,attempt:string):SettlementSubmission|undefined{const reserved=this.reservation(key,attempt),row=this.db.prepare('SELECT hash FROM settlement_broadcast_history WHERE attempt=?').get(attempt);if(!row)return undefined;
    const hash=digest.parse(row.hash).toLowerCase(),provider=this.db.prepare('SELECT transaction_id,provider_json FROM settlement_provider_history WHERE attempt=?').get(attempt);if(!provider)return {attempt,action:reserved.action,hash};
    const metadata=this.metadata(JSON.parse(String(provider.provider_json)),reserved);if(metadata.transactionId!==provider.transaction_id)throw Error('PROVIDER_SUBMISSION_CONFLICT');return {attempt,action:reserved.action,hash,providerSubmission:metadata};}
  close(){this.db.close();}
}
