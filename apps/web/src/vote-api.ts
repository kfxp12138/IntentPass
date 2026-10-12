import type {IncomingMessage,ServerResponse} from 'node:http';
import {VoteRequestSchema,VoteReconcileRequestSchema,prepareVote,checkVoteReceipt,VotePreparationSchema} from '../../../packages/protocol/src/vote.js';
import {voteRecord} from '../../../packages/protocol/src/vote-api.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import type {AcceptanceStore} from '../../../packages/storage/src/acceptance-store.js';
import type {VoteStore} from '../../../packages/storage/src/vote-store.js';
import type {OrderSnapshot} from '../../../packages/protocol/src/escrow-read.js';
import type {Authenticator} from '../../../packages/adapters/src/privy-auth.js';
import {serveAuthenticatedJson} from './auth-json-api.js';
export interface VoteApi {auth:Authenticator;deployment:RecoveryDeployment;store:VoteStore;signatures:AcceptanceStore;read:(id:string)=>Promise<OrderSnapshot>;receipt:(request:unknown,wallets:readonly string[])=>Promise<unknown>;clock?:()=>bigint;}
export function serveVote(req:IncomingMessage,res:ServerResponse,action:'reserve'|'query'|'prepare'|'reconcile',api:VoteApi){return serveAuthenticatedJson(req,res,{auth:api.auth,failureCode:'VOTE_SERVICE_UNAVAILABLE',invoke:async(input,principal)=>{
  const parsed=(action==='reconcile'?VoteReconcileRequestSchema:VoteRequestSchema).safeParse(input);if(!parsed.success)return {status:'REJECT',code:'INPUT_INVALID'};const request=parsed.data,p=request.payload,actor=api.deployment.committee[request.memberIndex];if(!principal.wallets.some(w=>w.toLowerCase()===actor.toLowerCase()))return {status:'REJECT',code:'ROLE_MISMATCH'};
  await verifyOriginalAuthorization(p,[p.intent.buyer],api.deployment);const expected=await voteRecord(request,api.deployment.committee),{dataHash:_dataHash,hash:_hash,...signatureRecord}=expected;
  try{const signature=api.signatures.get(principal.subject,{...signatureRecord,status:'RESERVED',signatureHash:null});if(!signature||signature.status!=='SIGNED'||signature.signatureHash?.toLowerCase()!==expected.signatureHash.toLowerCase())return {status:'REJECT',code:'SIGNATURE_RECORD_REQUIRED'};
    const old=api.store.get(principal.subject,expected);if(action==='query')return {record:old??null,canExecute:false};
    if(action==='reconcile'){
      if(!old)return {status:'REJECT',code:'VOTE_ATTEMPT_REQUIRED'};const r=VoteReconcileRequestSchema.parse(request);if(old.hash&&old.hash.toLowerCase()!==r.hash.toLowerCase())return {status:'REJECT',code:'VOTE_RECORD_CONFLICT'};
      const receipt=checkVoteReceipt(r,await api.receipt(r,principal.wallets),{...signatureRecord,status:'SIGNED'});if(receipt.status==='PENDING'){if(old.status!=='RESERVED')throw new Error('VOTE_RECEIPT_UNAVAILABLE');return {record:old,receipt,canExecute:false};}
      return {record:api.store.resolve(principal.subject,{...expected,status:receipt.status,hash:receipt.hash}),receipt,canExecute:false};
    }
    if(action==='reserve'&&old)return {...api.store.reserve(principal.subject,expected),canExecute:false};
    const vote=VoteRequestSchema.parse(request);try{const prepared=await prepareVote(vote,principal.wallets,api.deployment,async id=>({snapshot:await api.read(id),finality:'finalized'}),api.clock);if(action==='prepare')return VotePreparationSchema.parse(prepared);}
    catch(e){if(e instanceof Error&&/^(FULFILLMENT_STATE_INVALID|FULFILLMENT_EXPIRED|FULFILLMENT_ORDER_MISMATCH|FULFILLMENT_EVIDENCE_MISMATCH|FULFILLMENT_MEMBER_ALREADY_VOTED)$/.test(e.message))return {status:'REJECT',code:'VOTE_BLOCKED'};throw e;}
    return {...api.store.reserve(principal.subject,expected),canExecute:false};
  }catch(e){if(e instanceof Error&&['VOTE_RECORD_CONFLICT','ACCEPTANCE_RECORD_CONFLICT'].includes(e.message))return {status:'REJECT',code:'VOTE_RECORD_CONFLICT'};throw e;}
}});}
