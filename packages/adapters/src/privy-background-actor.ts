import type {PrivyClient} from '@privy-io/node';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {hashTypedData,keccak256,stringToHex,type Hex} from 'viem';
import type {BrowserAuthPort} from '../../../apps/web/src/browser-session.js';
import {ExecutionScopeSchema,assertBackgroundAuthorization,assertBackgroundUnsignedAuthorization,type ExecutionScope} from '../../automation/src/background-scope.js';
import {inspectBackgroundAuthority,type BackgroundAuthority} from './privy-background-policy.js';
import {compileGrant} from '../../protocol/src/escrow.js';
import {grantTypedData,verifyGrantSignature} from '../../protocol/src/typed-data.js';
import {prepareExactApproval} from '../../capsule/src/asset-approval.js';
import {verifyOriginalAuthorization} from '../../capsule/src/recovery.js';
import {DeliveryPrepareRequestSchema,AcceptancePrepareRequestSchema,checkDeliveryPreparation,checkAcceptancePreparation,prepareDelivery,prepareAcceptance} from '../../protocol/src/fulfillment.js';
import {acceptanceTypedData} from '../../protocol/src/escrow.js';
import {verifyAcceptanceSignature} from '../../protocol/src/acceptance-api.js';
import {VoteRequestSchema,checkVotePreparation,prepareVote} from '../../protocol/src/vote.js';
import {WithdrawalRequestSchema,checkWithdrawalPreparation,verifyWithdrawalRequest} from '../../protocol/src/withdrawal.js';
import {WithdrawalReserveResponseSchema,checkWithdrawalRecord} from '../../protocol/src/withdrawal-api.js';
import {z} from 'zod';
const signature=z.string().regex(/^0x[0-9a-fA-F]{130}$/),hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const domainTypes=[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}];
export interface BackgroundActorConfig extends BackgroundAuthority {authorizationPrivateKey:string;subject:string;}
/** Privy idempotency is application-scoped. Different wallets intentionally sign
 * the same committee message, so the resource must be part of the key. */
export function backgroundSignatureIdempotencyKey(walletId:string,typedDataHash:string){if(!walletId||!/^0x[0-9a-fA-F]{64}$/.test(typedDataHash))throw Error('BACKGROUND_SIGNATURE_KEY_INVALID');return keccak256(stringToHex(JSON.stringify(['IntentPass.BackgroundSignature',2,walletId,typedDataHash.toLowerCase()])));}
/** Server SDK transport. No browser frame, OTP, generic signing or raw calldata API.
 * The original controllers must reserve every transaction before calling this port.
 */
export function createBackgroundActor(client:PrivyClient,scopeInput:unknown,config:BackgroundActorConfig,getUnsigned:()=>unknown,
  applicationToken:()=>Promise<string>,clock=()=>BigInt(Math.floor(Date.now()/1000)),onGrantSignature?:(original:unknown)=>Promise<void>):BrowserAuthPort{
  config=Object.freeze(structuredClone(config));
  const s:ExecutionScope=ExecutionScopeSchema.parse(structuredClone(scopeInput)),d=s.deployment,actor=s[config.role],wallets=client.wallets(),policies=client.policies(),ethereum=wallets.ethereum();let closed=false;
  const active=()=>{if(closed)throw Error('SESSION_CHANGED');if(clock()>=BigInt(s.expiresAt))throw Error('BACKGROUND_SCOPE_EXPIRED');};
  const ready=async()=>{
    active();await inspectBackgroundAuthority(s,config,{wallet:wallets.get.bind(wallets),policy:policies.get.bind(policies)},clock());active();
    const w=await wallets.get(config.walletId);if(w.owner_id!==config.subject)throw Error('BACKGROUND_OWNER_CHANGED');
    const quorum=await client.keyQuorums().get(config.signerId);active();
    let publicKey:string;try{const privateKey=createPrivateKey({key:Buffer.from(config.authorizationPrivateKey.replace(/^wallet-auth:/,''),'base64'),type:'pkcs8',format:'der'});if(privateKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error();publicKey=createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64');}catch{throw Error('BACKGROUND_SIGNER_KEY_INVALID');}
    if(quorum.authorization_threshold!==1||(quorum.user_ids?.length??0)!==0||(quorum.key_quorum_ids?.length??0)!==0||quorum.authorization_keys.length!==1||quorum.authorization_keys[0].public_key!==publicKey)throw Error('BACKGROUND_SIGNER_KEY_MISMATCH');
  };
  const authorized=async(input:unknown)=>{active();const p=assertBackgroundAuthorization(s,input,clock());await verifyOriginalAuthorization(p,[s.buyer],d);active();return p;};
  const signTyped=async(typed:ReturnType<typeof grantTypedData>|ReturnType<typeof acceptanceTypedData>)=>{
    await ready();active();
    const deadline='deadline'in typed.message?String(typed.message.deadline):String(typed.message.expiresAt);if(clock()>=BigInt(deadline))throw Error('AUTHORIZATION_EXPIRED');
    const message=Object.fromEntries(Object.entries(typed.message).map(([key,value])=>[key,typeof value==='bigint'?String(value):value]));
    try{const result=await ethereum.signTypedData(config.walletId,{params:{typed_data:{domain:{...typed.domain,chainId:Number(typed.domain.chainId)},types:{EIP712Domain:domainTypes,...typed.types},primary_type:typed.primaryType,message}},authorization_context:{authorization_private_keys:[config.authorizationPrivateKey]},idempotency_key:backgroundSignatureIdempotencyKey(config.walletId,hashTypedData(typed as Parameters<typeof hashTypedData>[0]))});active();return signature.parse(result.signature) as Hex;}catch{throw Error('BACKGROUND_SIGNATURE_OUTCOME_UNKNOWN');}
  };
  const send=async(target:string,data:Hex,key:string,gas:number,deadline?:string)=>{
    await ready();active();if(deadline&&clock()>=BigInt(deadline))throw Error('AUTHORIZATION_EXPIRED');
    try{const result=await ethereum.sendTransaction(config.walletId,{caip2:`eip155:${s.chainId}`,params:{transaction:{from:actor,to:target,value:'0x0',data,chain_id:'0x279f',gas_limit:`0x${gas.toString(16)}`}},authorization_context:{authorization_private_keys:[config.authorizationPrivateKey]},idempotency_key:key});active();if(result.caip2!==`eip155:${s.chainId}`)throw Error();return hash.parse(result.hash) as Hex;}catch{throw Error('BACKGROUND_TRANSACTION_OUTCOME_UNKNOWN');}
  };
  const guard=(external:()=>void)=>()=>{external();active();};
  return {initialize:ready,sendCode:async()=>{throw Error('BACKGROUND_EMAIL_NOT_USED');},login:async()=>{throw Error('BACKGROUND_EMAIL_NOT_USED');},token:async()=>{active();return applicationToken();},logout:async()=>{closed=true;},
    signGrant:async input=>{if(config.role!=='buyer')throw Error('BACKGROUND_ROLE_MISMATCH');const p=assertBackgroundUnsignedAuthorization(s,getUnsigned(),clock());if(JSON.stringify(p.grant)!==JSON.stringify(input))throw Error('BACKGROUND_GRANT_CHANGED');const expected=await compileGrant({policy:p.policy,intent:p.intent,quote:p.quote,receipt:p.receipt,deployment:d,authenticatedOwner:s.buyer,executor:d.executor,nonce:p.grant.nonce,deadline:p.grant.deadline,now:clock()});if(JSON.stringify(expected)!==JSON.stringify(p.grant))throw Error('BACKGROUND_GRANT_CHANGED');const typed=grantTypedData(p.grant),signed=await signTyped(typed);if(!await verifyGrantSignature(p.grant,signed))throw Error('BACKGROUND_SIGNATURE_OUTCOME_UNKNOWN');await onGrantSignature?.({...p,ownerSignature:signed});return signed;},
    approveAsset:async(input,step,read,external)=>{const g=guard(external);g();if(config.role!=='buyer')throw Error('BACKGROUND_ROLE_MISMATCH');const p=await authorized(input),plan=await prepareExactApproval(p,d,[actor],await read({intent:p.intent,grant:p.grant}),step,clock());g();const tx=await send(plan.asset,plan.data as Hex,`approve:${p.intent.orderId}:${step}`,100000,p.grant.deadline);g();return {status:'SUBMITTED',hash:tx,orderId:plan.orderId,amount:plan.amount,step:plan.step,canSubmitPayment:false};},
    deliverOrder:async(input,read,external)=>{const g=guard(external),request=DeliveryPrepareRequestSchema.parse(input);g();if(config.role!=='seller')throw Error('BACKGROUND_ROLE_MISMATCH');const p=await authorized(request.payload),checked=checkDeliveryPreparation(request,await read(request));g();if('status'in checked)throw Error('BACKGROUND_PREPARATION_REJECTED');const plan=await prepareDelivery(request,[actor],d,async()=>({snapshot:checked.order,finality:checked.finality}),clock);g();const tx=await send(d.arbiter,plan.data as Hex,`deliver:${p.intent.orderId}`,300000,p.intent.deliveryDeadline);g();return {kind:'DELIVERY_SUBMITTED',hash:tx,orderId:p.intent.orderId,evidenceHash:plan.evidenceHash,canSubmitPayment:false};},
    signAcceptance:async(input,read,external)=>{const g=guard(external),request=AcceptancePrepareRequestSchema.parse(input);g();const p=await authorized(request.payload);if(d.committee[request.memberIndex].toLowerCase()!==actor.toLowerCase())throw Error('BACKGROUND_ROLE_MISMATCH');const checked=checkAcceptancePreparation(request,await read(request));g();if('status'in checked)throw Error('BACKGROUND_PREPARATION_REJECTED');const plan=await prepareAcceptance(request,[actor],d,async()=>({snapshot:checked.order,finality:checked.finality}),clock),typed=acceptanceTypedData({orderId:p.intent.orderId,contextHash:p.grant.contextHash,evidenceHash:plan.evidenceHash,committeeHash:p.intent.committeeHash,expiresAt:plan.expiresAt},d);g();const signed=await signTyped(typed);await verifyAcceptanceSignature({...request,signature:signed},d.committee);g();return {kind:'ACCEPTANCE_SIGNED',signature:signed,orderId:p.intent.orderId,evidenceHash:plan.evidenceHash,memberIndex:plan.memberIndex,expiresAt:plan.expiresAt,voteDigest:plan.voteDigest,canSubmitPayment:false};},
    submitVote:async(input,read,external)=>{const g=guard(external),request=VoteRequestSchema.parse(input);g();const p=await authorized(request.payload),signed=await verifyAcceptanceSignature(request,d.committee);if(signed.signer.toLowerCase()!==actor.toLowerCase())throw Error('BACKGROUND_ROLE_MISMATCH');const checked=await checkVotePreparation(request,await read(request));g();const plan=await prepareVote(request,[actor],d,async()=>({snapshot:checked.order,finality:checked.finality}),clock);g();const tx=await send(d.arbiter,plan.data as Hex,`vote:${p.intent.orderId}:${request.memberIndex}`,300000,request.expiresAt);g();return {kind:'VOTE_SUBMITTED',hash:tx,orderId:p.intent.orderId,evidenceHash:signed.evidenceHash,memberIndex:signed.memberIndex,signatureHash:signed.signatureHash,canSubmitPayment:false};},
    withdrawOrder:async(input,reservation,read,external)=>{const g=guard(external),request=WithdrawalRequestSchema.parse(input);g();await authorized(request.payload);await verifyWithdrawalRequest(request,[actor],d);const ticket=WithdrawalReserveResponseSchema.parse(reservation);if(!('created'in ticket)||!ticket.created||ticket.record.status!=='RESERVED')throw Error('BACKGROUND_FRESH_RESERVATION_REQUIRED');const record=checkWithdrawalRecord(request,ticket.record),plan=checkWithdrawalPreparation(request,await read(request));g();if(plan.blockers.length||plan.transferEligible!==true||plan.amount!==record.amount||plan.withdrawn!=='0'||plan.order.state!==record.allocationState)throw Error('BACKGROUND_WITHDRAWAL_BLOCKED');const tx=await send(d.arbiter,plan.data as Hex,`withdraw:${record.orderId}:${record.attempt}`,300000);g();return {kind:'WITHDRAWAL_SUBMITTED',hash:tx,orderId:record.orderId,beneficiary:actor,amount:record.amount,attempt:record.attempt,authorizationHash:record.authorizationHash,dataHash:record.dataHash,canSubmitPayment:false};},
  };
}
