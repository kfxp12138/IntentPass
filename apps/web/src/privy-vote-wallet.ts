import {isHex,type Hex} from 'viem';
import {monad,monadTestnet} from 'viem/chains';
import {VoteRequestSchema,checkVotePreparation,prepareVote} from '../../../packages/protocol/src/vote.js';
import {verifyOriginalAuthorization,RecoveryDeploymentSchema,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {verifyAcceptanceSignature} from '../../../packages/protocol/src/acceptance-api.js';
import {VotePrepareResponseSchema} from '../../../packages/protocol/src/vote-api.js';
import {walletFrameReady,createWalletBridge,type WalletSdk,type WalletBridgeFactory} from './privy-grant-wallet.js';
import {withWalletOperation} from './privy-wallet-operation.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
async function bounded<T>(work:()=>Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('VOTE_OUTCOME_UNKNOWN')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
/** Internal original-member adapter. Caller must first obtain created=true from
 * the durable original vote slot. Sends once; never signs, retries or settles.
 */
export function submitPrivyVote(input:unknown,confirmation:boolean,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,read:(request:unknown)=>Promise<unknown>,active:()=>void,clock=()=>BigInt(Math.floor(Date.now()/1000)),bridgeFactory:WalletBridgeFactory=createWalletBridge){
  return withWalletOperation(sdk,async()=>{
    if(confirmation!==true)throw new Error('VOTE_CONFIRMATION_REQUIRED');active();const d=RecoveryDeploymentSchema.parse(deployment);
    if(![monad,monadTestnet].some(c=>String(c.id)===d.chainId))throw new Error('WALLET_CONFIGURATION_REQUIRED');const request=VoteRequestSchema.parse(input);
    await verifyOriginalAuthorization(request.payload,[request.payload.intent.buyer],d);const signed=await verifyAcceptanceSignature(request,d.committee);active();const actor=signed.signer;
    let closed=false,attempted=false;const guard=()=>{active();if(closed)throw new Error('SESSION_CHANGED');};
    const prepare=async()=>{guard();const response=VotePrepareResponseSchema.parse(await read(structuredClone(request)).catch(error=>{if(error instanceof Error&&error.message==='SESSION_CHANGED')throw error;throw new Error('VOTE_PREPARATION_UNAVAILABLE');}));guard();if('status'in response)throw new Error('VOTE_PREPARATION_REJECTED');const checked=await checkVotePreparation(request,response);guard();const p=await prepareVote(request,[actor],d,async()=>({snapshot:checked.order,finality:checked.finality}),clock);guard();return p;};
    await prepare();guard();const {getAllUserEmbeddedEthereumWallets}=await import('@privy-io/js-sdk-core');guard();
    const {user}=await bounded(()=>sdk.user.get(),20000).catch(()=>{throw new Error('WALLET_ROLE_UNAVAILABLE');});guard();const matches=getAllUserEmbeddedEthereumWallets(user).filter(w=>eq(w.address,actor));if(matches.length!==1)throw new Error('WALLET_ROLE_UNAVAILABLE');
    const bridge=bridgeFactory(sdk,appId);try{return await bounded(async()=>{
      guard();if(!await walletFrameReady(sdk,guard))throw new Error('WALLET_FRAME_UNAVAILABLE');guard();const provider=await sdk.embeddedWallet.getProvider(matches[0]);guard();
      const assertWallet=async()=>{const chain=await provider.request({method:'eth_chainId'});guard();const accounts=await provider.request({method:'eth_accounts'});guard();if(typeof chain!=='string'||!/^0x[0-9a-fA-F]+$/.test(chain)||BigInt(chain)!==BigInt(d.chainId))throw new Error('WALLET_CHAIN_MISMATCH');if(!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&eq(a,actor)))throw new Error('WALLET_ROLE_MISMATCH');};
      await assertWallet();const plan=await prepare();guard();await assertWallet();guard();if(clock()>=BigInt(plan.record.expiresAt))throw new Error('FULFILLMENT_EXPIRED');attempted=true;
      // Direct RPC prevents a wallet client from falling back to another send method.
      const hash=await provider.request({method:'eth_sendTransaction',params:[{from:actor,to:d.arbiter,data:plan.data,value:'0x0',gas:'0x493e0',chainId:`0x${BigInt(d.chainId).toString(16)}`}]});guard();if(!isHex(hash)||hash.length!==66)throw new Error('VOTE_OUTCOME_UNKNOWN');
      return Object.freeze({kind:'VOTE_SUBMITTED' as const,hash:hash as Hex,orderId:signed.orderId,evidenceHash:signed.evidenceHash,memberIndex:signed.memberIndex,signatureHash:signed.signatureHash,canSubmitPayment:false as const});
    },60000);}catch(error){if(attempted)throw new Error('VOTE_OUTCOME_UNKNOWN');if(error instanceof Error&&/^(SESSION_CHANGED|WALLET_CHAIN_MISMATCH|WALLET_ROLE_MISMATCH|WALLET_FRAME_UNAVAILABLE|VOTE_[A-Z_]+|FULFILLMENT_[A-Z_]+)$/.test(error.message))throw error;throw new Error('VOTE_CANCELLED_OR_UNAVAILABLE');}finally{closed=true;bridge.dispose();}
  });
}
