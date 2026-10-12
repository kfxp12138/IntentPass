import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import type {ReceiptRecoveryService} from './services/receipt-recovery.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface ReceiptRecoveryApi {auth:Authenticator;service:ReceiptRecoveryService;}
export function serveReceiptRecovery(req:IncomingMessage,res:ServerResponse,api:ReceiptRecoveryApi){return serveAuthenticatedJson(req,res,{auth:api.auth,invoke:async(input,principal)=>{
  const mode=!!input&&typeof input==='object'&&'reschedule'in input&&input.reschedule===true?'RESCHEDULE':'RECEIPT';
  try{const result=await api.service.recover(input,principal);console.info('RECEIPT_RECOVERY_RESULT',mode,result.status,'code'in result?result.code:'SIGNED','canReschedule'in result&&result.canReschedule===true?'READY':'NO_CHANGE');return result;}
  catch{console.info('RECEIPT_RECOVERY_RESULT',mode,'ERROR','RECEIPT_RECOVERY_UNAVAILABLE');throw Error('RECEIPT_RECOVERY_UNAVAILABLE');}
},failureCode:'RECEIPT_RECOVERY_UNAVAILABLE'});}
