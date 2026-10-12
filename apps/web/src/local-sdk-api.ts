import type {IncomingMessage,ServerResponse} from 'node:http';
import type {BrowserApi} from './browser-api.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
import {runLocalSdkRead,runLocalSdkWorkflow,runLocalSdkProcurement} from './local-sdk-runner.js';
import {LocalSdkProcurementRequestSchema,LocalSdkProcurementReceiptSchema} from '../../../packages/protocol/src/local-sdk-procurement.js';
import {LocalSdkReadRequestSchema,LocalSdkReadResultSchema,LocalSdkWorkflowRequestSchema,LocalSdkWorkflowResultSchema} from '../../../packages/protocol/src/local-sdk-read.js';
export interface LocalSdkApi{auth:BrowserApi['auth'];run:typeof runLocalSdkRead;runWorkflow:typeof runLocalSdkWorkflow;runProcurement?:typeof runLocalSdkProcurement;active:Set<string>;}
export function configuredLocalSdkApi(env:NodeJS.ProcessEnv,browser:BrowserApi|undefined):LocalSdkApi|undefined{
  return env.INTENTPASS_LOCAL_SDK_READ_ENABLED==='1'&&!env.PUBLIC_HTTPS_URL?.trim()&&browser?{auth:browser.auth,run:runLocalSdkRead,runWorkflow:runLocalSdkWorkflow,...(env.INTENTPASS_LOCAL_SDK_PROCUREMENT_ENABLED==='1'?{runProcurement:runLocalSdkProcurement}:{}),active:new Set()}:undefined;
}
const loopback=(address:string|undefined)=>!!address&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
export function serveLocalSdkProcurement(req:IncomingMessage,res:ServerResponse,api:LocalSdkApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'LOCAL_SDK_SUBMISSION_UNCONFIRMED',invoke:async(input,principal)=>{
  if(!api.runProcurement)return {status:'REJECT',code:'LOCAL_SDK_PROCUREMENT_DISABLED'};
  if(!loopback(req.socket.remoteAddress)||!loopback(req.socket.localAddress)||!req.socket.localPort)return {status:'REJECT',code:'LOCAL_SDK_LOOPBACK_REQUIRED'};
  const parsed=LocalSdkProcurementRequestSchema.safeParse(input);if(!parsed.success||!principal.wallets.some(w=>w.toLowerCase()===parsed.data.memory.taskInput.buyer.toLowerCase()))return {status:'REJECT',code:'LOCAL_SDK_PROCUREMENT_INVALID'};
  if(api.active.has(principal.subject)||api.active.size>=2)return {status:'REJECT',code:'LOCAL_SDK_CHECK_BUSY'};
  api.active.add(principal.subject);try{
    const token=req.headers.authorization!.slice(7),result=LocalSdkProcurementReceiptSchema.parse(await api.runProcurement({request:parsed.data,token,expectedSubject:principal.subject,port:req.socket.localPort}));
    const after=await api.auth.authenticate(token),wallets=(w:readonly string[])=>[...new Set(w.map(a=>a.toLowerCase()))].sort().join(',');
    if(after.subject!==principal.subject||wallets(after.wallets)!==wallets(principal.wallets)||wallets(result.walletAddresses)!==wallets(after.wallets)||result.taskId.toLowerCase()!==parsed.data.memory.policy.taskId.toLowerCase())throw Error('LOCAL_SDK_SUBMISSION_UNCONFIRMED');
    return result;
  }finally{api.active.delete(principal.subject);}
}});}
export function serveLocalSdk(req:IncomingMessage,res:ServerResponse,api:LocalSdkApi,workflow=false){return serveAuthenticatedJson(req,res,{auth:api.auth,maxInputBytes:2048,failureCode:'LOCAL_SDK_READ_UNAVAILABLE',invoke:async(input,principal)=>{
  if(!loopback(req.socket.remoteAddress)||!loopback(req.socket.localAddress)||!req.socket.localPort)return {status:'REJECT',code:'LOCAL_SDK_LOOPBACK_REQUIRED'};
  const parsed=(workflow?LocalSdkWorkflowRequestSchema:LocalSdkReadRequestSchema).safeParse(input);if(!parsed.success)return {status:'REJECT',code:'LOCAL_SDK_REQUEST_INVALID'};
  if(api.active.has(principal.subject)||api.active.size>=2)return {status:'REJECT',code:'LOCAL_SDK_CHECK_BUSY'};
  api.active.add(principal.subject);try{
  const token=req.headers.authorization!.slice(7),common={orderId:parsed.data.orderId,token,expectedSubject:principal.subject,port:req.socket.localPort};
  const result=workflow?LocalSdkWorkflowResultSchema.parse(await api.runWorkflow({...common,jobId:LocalSdkWorkflowRequestSchema.parse(parsed.data).jobId})):LocalSdkReadResultSchema.parse(await api.run(common));
  if('jobId'in result&&result.jobId!==LocalSdkWorkflowRequestSchema.parse(parsed.data).jobId)throw Error('LOCAL_SDK_JOB_CHANGED');
  const current=await api.auth.authenticate(token),wallets=(values:readonly string[])=>[...new Set(values.map(w=>w.toLowerCase()))].sort().join(',');
  if(current.subject!==principal.subject||wallets(current.wallets)!==wallets(principal.wallets)||wallets(result.walletAddresses)!==wallets(current.wallets)||result.order.orderId.toLowerCase()!==parsed.data.orderId.toLowerCase())throw Error('LOCAL_SDK_SESSION_CHANGED');
  return result;
  }finally{api.active.delete(principal.subject);}
}});}
