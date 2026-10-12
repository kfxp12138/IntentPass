import {getAddress,type Address} from 'viem';
import {getAllUserEmbeddedEthereumWallets,getAllUserEmbeddedSolanaWallets} from '@privy-io/js-sdk-core';
import {z} from 'zod';
import {address} from '../../../packages/protocol/src/schemas.js';
import {walletFrameReady,createWalletBridge,type WalletSdk,type WalletBridgeFactory} from './privy-grant-wallet.js';
import {withWalletOperation} from './privy-wallet-operation.js';

export interface SetupWallets {subject:string;addresses:Address[];}
const attempts=new WeakMap<object,Set<string>>();
const subjectSchema=z.string().min(1).max(512);
async function bounded<T>(work:()=>Promise<T>,ms:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('WALLET_SETUP_TIMEOUT')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
function metadata(user:Parameters<typeof getAllUserEmbeddedEthereumWallets>[0],subject:string):SetupWallets {
  if(!user||user.id!==subject)throw new Error('SESSION_CHANGED');
  const wallets=getAllUserEmbeddedEthereumWallets(user);if(wallets.length>128)throw new Error('WALLET_SETUP_RESPONSE_INVALID');
  const addresses=[...new Set(wallets.map(wallet=>getAddress(address.parse(wallet.address))))];
  return {subject,addresses};
}
/** Wallet metadata only. No frame, provider, signer, transaction or role assignment. */
export async function readPrivySetupWallets(subject:string,sdk:WalletSdk,active:()=>void=()=>{}):Promise<SetupWallets>{
  subjectSchema.parse(subject);active();
  let user;try{({user}=await bounded(()=>sdk.user.get(),20000));}catch{active();throw new Error('WALLET_SETUP_UNAVAILABLE');}
  active();return metadata(user,subject);
}
/** An explicit first Ethereum wallet creation, never a retry or a new role wallet.
 * The shared SDK lock outlives a UI timeout until the original operation settles.
 */
export async function createPrivySetupWallet(subject:string,confirmation:boolean,sdk:WalletSdk,appId:string,active:()=>void=()=>{},bridgeFactory:WalletBridgeFactory=createWalletBridge,timeout=60000):Promise<SetupWallets>{
  if(confirmation!==true)throw new Error('WALLET_SETUP_CONFIRMATION_REQUIRED');subjectSchema.parse(subject);active();
  let closed=false,attempted=false,dispose:()=>void=()=>{};
  const guard=()=>{active();if(closed)throw new Error('SESSION_CHANGED');};
  const operation=withWalletOperation(sdk,async()=>{
    try{
      const existing=await readPrivySetupWallets(subject,sdk,guard);guard();if(existing.addresses.length)return existing;
      if(attempts.get(sdk)?.has(subject))throw new Error('WALLET_SETUP_CREATION_OUTCOME_UNKNOWN');
      const bridge=bridgeFactory(sdk,appId);let disposed=false;dispose=()=>{if(!disposed){disposed=true;bridge.dispose();}};
      guard();if(!await walletFrameReady(sdk,guard))throw new Error('WALLET_FRAME_UNAVAILABLE');guard();
      const {user}=await bounded(()=>sdk.user.get(),20000);guard();const fresh=metadata(user,subject);if(fresh.addresses.length)return fresh;
      // Existing Solana recovery linkage needs an explicit separate flow; never guess it.
      if(getAllUserEmbeddedSolanaWallets(user).length)throw new Error('WALLET_SETUP_EXISTING_SOLANA_UNSUPPORTED');
      const subjects=attempts.get(sdk)??new Set<string>();subjects.add(subject);attempts.set(sdk,subjects);attempted=true;
      // SDK 0.77.0 requires an explicit options object. No recovery secrets or signers.
      const result=await sdk.embeddedWallet.create({});guard();metadata(result.user,subject);
      const current=await readPrivySetupWallets(subject,sdk,guard);guard();if(!current.addresses.length)throw new Error('WALLET_SETUP_CREATION_OUTCOME_UNKNOWN');return current;
    }finally{dispose();}
  });
  try{return await bounded(()=>operation,timeout);}catch(error){
    if(attempted)throw new Error('WALLET_SETUP_CREATION_OUTCOME_UNKNOWN');
    if(error instanceof Error&&/^(SESSION_CHANGED|WALLET_SIGNATURE_PENDING|WALLET_FRAME_UNAVAILABLE|WALLET_SETUP_[A-Z_]+)$/.test(error.message))throw error;
    throw new Error('WALLET_SETUP_UNAVAILABLE');
  }finally{closed=true;dispose();}
}
