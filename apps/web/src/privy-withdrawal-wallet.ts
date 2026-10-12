import {isHex,type Hex} from 'viem';
import {monad,monadTestnet} from 'viem/chains';
import {WithdrawalRequestSchema,verifyWithdrawalRequest,checkWithdrawalPreparation} from '../../../packages/protocol/src/withdrawal.js';
import {WithdrawalReserveResponseSchema,WithdrawalPrepareResponseSchema,checkWithdrawalRecord} from '../../../packages/protocol/src/withdrawal-api.js';
import {RecoveryDeploymentSchema,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {walletFrameReady,createWalletBridge,type WalletSdk,type WalletBridgeFactory} from './privy-grant-wallet.js';
import {withWalletOperation} from './privy-wallet-operation.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
async function bounded<T>(work:()=>Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('WITHDRAWAL_OUTCOME_UNKNOWN')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
/** Internal beneficiary adapter. The controller must obtain this fresh created
 * reservation from the authenticated durable API before invoking it. No signing,
 * retries, new authorization, allocation or arbitrary asset operations.
 */
export function withdrawPrivyOrder(input:unknown,reservation:unknown,confirmation:boolean,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,read:(request:unknown)=>Promise<unknown>,active:()=>void,bridgeFactory:WalletBridgeFactory=createWalletBridge){
  return withWalletOperation(sdk,async()=>{
    if(confirmation!==true)throw new Error('WITHDRAWAL_CONFIRMATION_REQUIRED');active();const d=RecoveryDeploymentSchema.parse(deployment);
    if(![monad,monadTestnet].some(c=>String(c.id)===d.chainId))throw new Error('WALLET_CONFIGURATION_REQUIRED');const request=WithdrawalRequestSchema.parse(input),actor=request.beneficiary;
    await verifyWithdrawalRequest(request,[actor],d);active();const ticket=WithdrawalReserveResponseSchema.parse(reservation);
    if(!('created'in ticket)||!ticket.created||ticket.record.status!=='RESERVED')throw new Error('WITHDRAWAL_FRESH_RESERVATION_REQUIRED');const record=checkWithdrawalRecord(request,ticket.record);
    let closed=false,attempted=false;const guard=()=>{active();if(closed)throw new Error('SESSION_CHANGED');};
    const prepare=async()=>{guard();const response=WithdrawalPrepareResponseSchema.parse(await read(structuredClone(request)).catch(error=>{if(error instanceof Error&&error.message==='SESSION_CHANGED')throw error;throw new Error('WITHDRAWAL_PREPARATION_UNAVAILABLE');}));guard();if('status'in response)throw new Error('WITHDRAWAL_PREPARATION_REJECTED');const p=checkWithdrawalPreparation(request,response);if(p.blockers.length||p.transferEligible!==true||p.amount!==record.amount||p.withdrawn!=='0'||p.order.state!==record.allocationState)throw new Error('WITHDRAWAL_BLOCKED');return p;};
    const initial=await prepare();guard();const {getAllUserEmbeddedEthereumWallets}=await import('@privy-io/js-sdk-core');guard();
    const {user}=await bounded(()=>sdk.user.get(),20000).catch(()=>{throw new Error('WALLET_ROLE_UNAVAILABLE');});guard();const matches=getAllUserEmbeddedEthereumWallets(user).filter(w=>eq(w.address,actor));if(matches.length!==1)throw new Error('WALLET_ROLE_UNAVAILABLE');
    const bridge=bridgeFactory(sdk,appId);try{return await bounded(async()=>{
      guard();if(!await walletFrameReady(sdk,guard))throw new Error('WALLET_FRAME_UNAVAILABLE');guard();const provider=await sdk.embeddedWallet.getProvider(matches[0]);guard();
      const assertWallet=async()=>{const chain=await provider.request({method:'eth_chainId'});guard();const accounts=await provider.request({method:'eth_accounts'});guard();if(typeof chain!=='string'||!/^0x[0-9a-fA-F]+$/.test(chain)||BigInt(chain)!==BigInt(d.chainId))throw new Error('WALLET_CHAIN_MISMATCH');if(!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&eq(a,actor)))throw new Error('WALLET_ROLE_MISMATCH');};
      await assertWallet();const plan=await prepare();guard();if(BigInt(plan.order.block.number)<BigInt(initial.order.block.number)||plan.order.block.number===initial.order.block.number&&!eq(plan.order.block.hash,initial.order.block.hash))throw new Error('WITHDRAWAL_SNAPSHOT_CHANGED');await assertWallet();guard();attempted=true;
      const hash=await provider.request({method:'eth_sendTransaction',params:[{from:actor,to:d.arbiter,data:plan.data,value:'0x0',gas:'0x493e0',chainId:`0x${BigInt(d.chainId).toString(16)}`}]});guard();if(!isHex(hash)||hash.length!==66)throw new Error('WITHDRAWAL_OUTCOME_UNKNOWN');
      return Object.freeze({kind:'WITHDRAWAL_SUBMITTED' as const,hash:hash as Hex,orderId:record.orderId,beneficiary:actor,amount:record.amount,attempt:record.attempt,authorizationHash:record.authorizationHash,dataHash:record.dataHash,canSubmitPayment:false as const});
    },60000);}catch(error){if(attempted)throw new Error('WITHDRAWAL_OUTCOME_UNKNOWN');if(error instanceof Error&&/^(SESSION_CHANGED|WALLET_CHAIN_MISMATCH|WALLET_ROLE_MISMATCH|WALLET_FRAME_UNAVAILABLE|WITHDRAWAL_[A-Z_]+)$/.test(error.message))throw error;throw new Error('WITHDRAWAL_CANCELLED_OR_UNAVAILABLE');}finally{closed=true;bridge.dispose();}
  });
}
