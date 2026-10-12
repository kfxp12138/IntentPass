import {createWalletClient,custom,isHex,verifyTypedData,type Address,type Hex} from 'viem';
import {monad,monadTestnet} from 'viem/chains';
import {DeliveryPrepareRequestSchema,AcceptancePrepareRequestSchema,checkDeliveryPreparation,checkAcceptancePreparation,prepareDelivery,prepareAcceptance} from '../../../packages/protocol/src/fulfillment.js';
import {acceptanceTypedData} from '../../../packages/protocol/src/escrow.js';
import {verifyOriginalAuthorization,RecoveryDeploymentSchema,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {walletFrameReady,createWalletBridge,type WalletSdk,type WalletBridgeFactory} from './privy-grant-wallet.js';
import {withWalletOperation} from './privy-wallet-operation.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
async function bounded<T>(work:()=>Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('FULFILLMENT_OUTCOME_UNKNOWN')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
/** Explicit original-role operations only. Before invocation the caller must reserve
 * a durable original action slot. These functions do not retry, allocate or withdraw.
 * No UI or Agent capability is opened by exporting this internal adapter.
 */
export function deliverPrivyOrder(input:unknown,confirmation:boolean,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,read:(request:unknown)=>Promise<unknown>,active:()=>void,clock=()=>BigInt(Math.floor(Date.now()/1000)),bridge:WalletBridgeFactory=createWalletBridge){
  return withWalletOperation(sdk,()=>operate('DELIVER',input,confirmation,deployment,sdk,appId,read,active,clock,bridge));
}
export function signPrivyAcceptance(input:unknown,confirmation:boolean,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,read:(request:unknown)=>Promise<unknown>,active:()=>void,clock=()=>BigInt(Math.floor(Date.now()/1000)),bridge:WalletBridgeFactory=createWalletBridge){
  return withWalletOperation(sdk,()=>operate('SIGN_ACCEPTANCE',input,confirmation,deployment,sdk,appId,read,active,clock,bridge));
}
async function operate(action:'DELIVER'|'SIGN_ACCEPTANCE',input:unknown,confirmation:boolean,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,read:(request:unknown)=>Promise<unknown>,active:()=>void,clock:()=>bigint,bridgeFactory:WalletBridgeFactory){
  if(confirmation!==true)throw new Error('FULFILLMENT_CONFIRMATION_REQUIRED');active();
  const d=RecoveryDeploymentSchema.parse(deployment);if(![monad,monadTestnet].some(c=>String(c.id)===d.chainId))throw new Error('WALLET_CONFIGURATION_REQUIRED');
  const request=(action==='DELIVER'?DeliveryPrepareRequestSchema:AcceptancePrepareRequestSchema).parse(input);
  // Verify the entire historical authorization before accessing even wallet metadata.
  const p=await verifyOriginalAuthorization(request.payload,[request.payload.intent.buyer],d);active();
  const member=action==='SIGN_ACCEPTANCE'?AcceptancePrepareRequestSchema.parse(request):undefined;
  const actor=member?d.committee[member.memberIndex]:p.intent.seller;
  let closed=false,attempted=false;
  const guard=()=>{active();if(closed)throw new Error('SESSION_CHANGED');};
  const prepare=async()=>{
    guard();const response=await read(structuredClone(request)).catch(()=>{throw new Error('FULFILLMENT_PREPARATION_UNAVAILABLE');});guard();
    if(member){const checked=checkAcceptancePreparation(member,response);if('status'in checked)throw new Error('FULFILLMENT_PREPARATION_REJECTED');return prepareAcceptance(member,[actor],d,async()=>({snapshot:checked.order,finality:checked.finality}),clock);}
    const checked=checkDeliveryPreparation(request,response);if('status'in checked)throw new Error('FULFILLMENT_PREPARATION_REJECTED');return prepareDelivery(request,[actor],d,async()=>({snapshot:checked.order,finality:checked.finality}),clock);
  };
  await prepare();guard();
  const {getAllUserEmbeddedEthereumWallets}=await import('@privy-io/js-sdk-core');
  guard();
  const {user}=await bounded(()=>sdk.user.get(),20000).catch(()=>{throw new Error('WALLET_ROLE_UNAVAILABLE');});guard();
  const matches=getAllUserEmbeddedEthereumWallets(user).filter(w=>eq(w.address,actor));if(matches.length!==1)throw new Error('WALLET_ROLE_UNAVAILABLE');
  const bridge=bridgeFactory(sdk,appId);
  try{return await bounded(async()=>{
    guard();if(!await walletFrameReady(sdk,guard))throw new Error('WALLET_FRAME_UNAVAILABLE');guard();
    const provider=await sdk.embeddedWallet.getProvider(matches[0]);guard();
    const assertWallet=async()=>{const chain=await provider.request({method:'eth_chainId'});guard();const accounts=await provider.request({method:'eth_accounts'});guard();if(typeof chain!=='string'||!/^0x[0-9a-fA-F]+$/.test(chain)||BigInt(chain)!==BigInt(d.chainId))throw new Error('WALLET_CHAIN_MISMATCH');if(!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&eq(a,actor)))throw new Error('WALLET_ROLE_MISMATCH');};
    await assertWallet();const plan=await prepare();guard();await assertWallet();guard();
    if(plan.kind==='DELIVERY_PREPARED'){
      if(clock()>BigInt(plan.order.deliveryDeadline))throw new Error('FULFILLMENT_EXPIRED');attempted=true;
      const hash=await provider.request({method:'eth_sendTransaction',params:[{from:actor,to:d.arbiter,data:plan.data,value:'0x0',gas:'0x493e0',chainId:`0x${BigInt(d.chainId).toString(16)}`}]});guard();if(!isHex(hash)||hash.length!==66)throw new Error('FULFILLMENT_OUTCOME_UNKNOWN');
      return Object.freeze({kind:'DELIVERY_SUBMITTED' as const,hash:hash as Hex,orderId:p.intent.orderId,evidenceHash:plan.evidenceHash,canSubmitPayment:false as const});
    }
    if(clock()>=BigInt(plan.expiresAt))throw new Error('FULFILLMENT_EXPIRED');
    const typed=acceptanceTypedData({orderId:p.intent.orderId,contextHash:p.grant.contextHash,evidenceHash:plan.evidenceHash,committeeHash:p.intent.committeeHash,expiresAt:plan.expiresAt},d);
    attempted=true;const signature=await createWalletClient({transport:custom(provider,{retryCount:0})}).signTypedData({...typed,account:actor as Address});guard();await assertWallet();
    if(!await verifyTypedData({...typed,address:actor as Address,signature}))throw new Error('FULFILLMENT_SIGNATURE_INVALID');guard();
    const fresh=await prepare();guard();if(fresh.kind!=='ACCEPTANCE_PREPARED'||!eq(fresh.voteDigest,plan.voteDigest)||clock()>=BigInt(plan.expiresAt))throw new Error('FULFILLMENT_OUTCOME_UNKNOWN');
    return Object.freeze({kind:'ACCEPTANCE_SIGNED' as const,signature,orderId:p.intent.orderId,evidenceHash:plan.evidenceHash,memberIndex:plan.memberIndex,expiresAt:plan.expiresAt,voteDigest:plan.voteDigest,canSubmitPayment:false as const});
  },60000);}catch(error){
    if(attempted)throw new Error('FULFILLMENT_OUTCOME_UNKNOWN');
    if(error instanceof Error&&/^(SESSION_CHANGED|WALLET_CHAIN_MISMATCH|WALLET_ROLE_MISMATCH|WALLET_FRAME_UNAVAILABLE|FULFILLMENT_[A-Z_]+)$/.test(error.message))throw error;
    throw new Error('FULFILLMENT_CANCELLED_OR_UNAVAILABLE');
  }finally{closed=true;bridge.dispose();}
}
