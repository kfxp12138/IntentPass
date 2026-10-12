import {isHex,type Hex} from 'viem';
import {monad,monadTestnet} from 'viem/chains';
import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {prepareExactApproval,type ApprovalStep} from '../../../packages/capsule/src/asset-approval.js';
import {verifyOriginalAuthorization,RecoveryDeploymentSchema,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {walletFrameReady,createWalletBridge,type WalletSdk,type WalletBridgeFactory} from './privy-grant-wallet.js';
import {withWalletOperation} from './privy-wallet-operation.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
async function bounded<T>(work:()=>Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('APPROVAL_OUTCOME_UNKNOWN')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
/** Explicit buyer operation, never an Agent capability. One RESET or SET transaction.
 * Returned hash means submitted only. No retry, receipt claim, payment or arbitrary calldata.
 * Caller must persist UNKNOWN and reconcile before any subsequent wallet action.
 */
export function approvePrivyAsset(input:unknown,deployment:RecoveryDeployment,step:ApprovalStep,sdk:WalletSdk,appId:string,
  readPreflight:(request:unknown)=>Promise<unknown>,assertActive:()=>void,clock:()=>bigint=()=>BigInt(Math.floor(Date.now()/1000)),bridgeFactory:WalletBridgeFactory=createWalletBridge) {
  return withWalletOperation(sdk,async()=>{
    assertActive();const original=AuthorizationPayloadSchema.parse(input),d=RecoveryDeploymentSchema.parse(deployment),chain=[monad,monadTestnet].find(c=>String(c.id)===d.chainId);
    if(!chain)throw new Error('WALLET_CONFIGURATION_REQUIRED');
    // Clone and verify before any provider operation or frame creation.
    const {getAllUserEmbeddedEthereumWallets}=await import('@privy-io/js-sdk-core');
    const {user}=await bounded(()=>sdk.user.get(),20000).catch(()=>{throw new Error('WALLET_OWNER_UNAVAILABLE');});assertActive();
    const linked=getAllUserEmbeddedEthereumWallets(user),payload=await verifyOriginalAuthorization(original,linked.map(w=>w.address),d);assertActive();
    const matches=linked.filter(w=>eq(w.address,payload.grant.owner));if(matches.length!==1)throw new Error('WALLET_OWNER_UNAVAILABLE');
    const request={intent:payload.intent,grant:payload.grant};
    // Validate once before creating the protected frame, then again directly before send.
    await prepareExactApproval(payload,d,[matches[0].address],await readPreflight(structuredClone(request)),step,clock());assertActive();
    const bridge=bridgeFactory(sdk,appId);let attempted=false,closed=false;
    const guard=()=>{assertActive();if(closed)throw new Error('SESSION_CHANGED');};
    try{return await bounded(async()=>{
      if(!await walletFrameReady(sdk,guard))throw new Error('WALLET_FRAME_UNAVAILABLE');guard();
      const provider=await sdk.embeddedWallet.getProvider(matches[0]);guard();
      const assertWallet=async()=>{
        const id=await provider.request({method:'eth_chainId'}),accounts=await provider.request({method:'eth_accounts'});guard();
        if(typeof id!=='string'||!/^0x[0-9a-fA-F]+$/.test(id)||BigInt(id)!==BigInt(d.chainId))throw new Error('WALLET_CHAIN_MISMATCH');
        if(!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&eq(a,payload.grant.owner)))throw new Error('WALLET_OWNER_MISMATCH');
      };
      await assertWallet();
      const plan=await prepareExactApproval(payload,d,[matches[0].address],await readPreflight(structuredClone(request)),step,clock());guard();
      await assertWallet();guard();if(clock()>=BigInt(payload.grant.deadline))throw new Error('AUTHORIZATION_EXPIRED');
      attempted=true;
      // The installed viem sendTransaction helper may fall back to wallet_sendTransaction.
      // Use one canonical SDK request so application code never sends a second method.
      const hash=await provider.request({method:'eth_sendTransaction',params:[{from:plan.owner,to:plan.asset,data:plan.data,value:'0x0',gas:'0x186a0',chainId:`0x${BigInt(plan.chainId).toString(16)}`}]});
      if(!isHex(hash)||hash.length!==66)throw new Error('APPROVAL_OUTCOME_UNKNOWN');guard();
      return Object.freeze({status:'SUBMITTED' as const,hash:hash as Hex,orderId:plan.orderId,amount:plan.amount,step:plan.step,canSubmitPayment:false as const});
    },60000);}catch(error){
      if(attempted)throw new Error('APPROVAL_OUTCOME_UNKNOWN');
      if(error instanceof Error&&/^(WALLET_CHAIN_MISMATCH|WALLET_OWNER_MISMATCH|WALLET_FRAME_UNAVAILABLE|AUTHORIZATION_EXPIRED|APPROVAL_CHAIN_BLOCKED|APPROVAL_PREFLIGHT_MISMATCH|ALLOWANCE_RESET_REQUIRED|ALLOWANCE_RESET_NOT_REQUIRED|EXACT_ALLOWANCE_ALREADY_SET|SESSION_CHANGED)$/.test(error.message))throw error;
      throw new Error('APPROVAL_CANCELLED_OR_UNAVAILABLE');
    }finally{closed=true;bridge.dispose();}
  });
}
