import {DatabaseSync} from 'node:sqlite';
import type {PublicClient} from 'viem';
import {EscrowReader,type EscrowDeployment} from '../../../packages/protocol/src/escrow-read.js';
import type {ReceiptRecoveryGuard} from './services/receipt-recovery.js';
export function receiptRecoveryGuard(client:PublicClient,deployment:EscrowDeployment,fundingPath:string,clock=()=>BigInt(Math.floor(Date.now()/1000))):ReceiptRecoveryGuard{
  return async(request,expiredAt)=>{
    try{
    // Every original submission record is preserved and blocks this route, including IDLE.
    const db=new DatabaseSync(fundingPath,{readOnly:true});try{if(db.prepare('SELECT key FROM funding_attempts WHERE key=?').get(`${deployment.chainId}:${deployment.arbiter.toLowerCase()}:${request.intent.orderId.toLowerCase()}`))throw Error('ORIGINAL_SUBMISSION_EXISTS');}finally{db.close();}
    const [finalized,latest]=await Promise.all([new EscrowReader(client,deployment).read(request.intent.orderId),new EscrowReader(client,deployment,'latest').read(request.intent.orderId)]);
    const now=clock();
    console.info('RECEIPT_RECOVERY_CHAIN',String(now),String(expiredAt),finalized.state,finalized.block.timestamp,latest.state,latest.block.timestamp);
    for(const snapshot of [finalized,latest])if(snapshot.state!=='UNREGISTERED'||BigInt(snapshot.block.timestamp)<expiredAt||BigInt(snapshot.block.timestamp)>now+30n||now-BigInt(snapshot.block.timestamp)>120n)throw Error('ORIGINAL_CHAIN_NOT_READY');
    if(BigInt(latest.block.number)<BigInt(finalized.block.number))throw Error('ORIGINAL_CHAIN_NOT_READY');
    }catch(error){const e=error instanceof Error?error:undefined,known=['ORIGINAL_SUBMISSION_EXISTS','ORIGINAL_CHAIN_NOT_READY','DEPLOYMENT_MISMATCH','CHAIN_MISMATCH','CHAIN_SNAPSHOT_CHANGED','ESCROW_INSOLVENT'];console.info('RECEIPT_RECOVERY_GUARD_ERROR',e&&known.includes(e.message)?e.message:'CHAIN_READ_UNAVAILABLE',e&&/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(e.name)?e.name:'Error');
      let cause:unknown=error;for(let depth=0;depth<6&&cause&&typeof cause==='object';depth++){const c=cause as {name?:unknown;code?:unknown;status?:unknown;functionName?:unknown;cause?:unknown};console.info('RECEIPT_RECOVERY_CAUSE',depth,typeof c.name==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(c.name)?c.name:'Error',typeof c.code==='number'?c.code:0,typeof c.status==='number'?c.status:0,typeof c.functionName==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(c.functionName)?c.functionName:'');if(c.code===-32011&&'message' in c&&typeof c.message==='string'){let safe=c.message.replace(/https?:\/\/\S+/g,'[URL]');for(const [key,value] of Object.entries(process.env))if(/KEY|SECRET|TOKEN|AUTH/.test(key)&&value&&value.length>=8)safe=safe.replaceAll(value,'[REDACTED]');console.info('RECEIPT_RECOVERY_RPC_MESSAGE',safe.slice(0,300));}cause=c.cause;}throw error;}
  };
}
