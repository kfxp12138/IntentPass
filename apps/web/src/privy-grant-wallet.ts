import {withWalletOperation} from './privy-wallet-operation.js';
import type Privy from '@privy-io/js-sdk-core';
import {createWalletClient,custom,type Address,type Hex} from 'viem';
import {CapabilityGrantSchema,address,positiveUint} from '../../../packages/protocol/src/schemas.js';
import {grantTypedData,verifyGrantSignature} from '../../../packages/protocol/src/typed-data.js';
import {RecoveryDeploymentSchema,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
export interface WalletBridge {dispose():void;}
export type WalletSdk=Pick<Privy,'user'|'embeddedWallet'|'setMessagePoster'>;
export type WalletBridgeFactory=(sdk:WalletSdk,appId:string)=>WalletBridge;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const beforeRequestCodes=new Set(['AUTHORIZATION_EXPIRED','SESSION_CHANGED','WALLET_SIGNATURE_PENDING','WALLET_CONFIGURATION_REQUIRED','WALLET_GRANT_DEPLOYMENT_MISMATCH','WALLET_OWNER_UNAVAILABLE','WALLET_OWNER_MISMATCH','WALLET_CHAIN_MISMATCH','WALLET_FRAME_UNAVAILABLE','WALLET_FRAME_INVALID','WALLET_SIGNATURE_CANCELLED_OR_UNAVAILABLE']);
/** Only trusted local code can establish that this Grant RPC was never invoked. */
export class WalletSignatureNotRequested extends Error {
  constructor(error:unknown){super(error instanceof Error&&beforeRequestCodes.has(error.message)?error.message:'WALLET_SIGNATURE_NOT_REQUESTED');}
}
/** Only the idempotent readiness message is retried while the iframe hydrates. */
export async function walletFrameReady(sdk:WalletSdk,active:()=>void=()=>{},timeout=5000):Promise<boolean>{
  const deadline=performance.now()+timeout;
  while(performance.now()<deadline){
    active();const started=performance.now(),remaining=deadline-started;
    const ready=await sdk.embeddedWallet.ping(Math.max(1,Math.min(250,remaining)));active();
    if(ready)return performance.now()<deadline;
    const delay=Math.min(250-(performance.now()-started),deadline-performance.now());
    if(delay>0)await new Promise<void>(resolve=>setTimeout(resolve,delay));
  }
  active();return false;
}
/** The frame is scoped to an explicit protected wallet operation, then disposed. */
export const createWalletBridge:WalletBridgeFactory=(sdk,appId)=>{
  const url=new URL(sdk.embeddedWallet.getURL());
  if(url.origin!=='https://auth.privy.io'||url.username||url.password||url.hash||url.pathname!==`/apps/${appId}/embedded-wallets`)throw new Error('WALLET_FRAME_INVALID');
  const frame=document.createElement('iframe');frame.hidden=true;frame.title='Privy wallet secure context';frame.referrerPolicy='no-referrer';frame.setAttribute('sandbox','allow-scripts allow-same-origin');
  let disposed=false,loaded=false;
  const pending:Array<{message:Record<string,unknown>;transfer?:Transferable}>=[];
  const onLoad=()=>{if(disposed)return;loaded=true;for(const item of pending.splice(0))frame.contentWindow?.postMessage(item.message,url.origin,item.transfer?[item.transfer]:[]);};
  const receive=(event:MessageEvent)=>{
    if(disposed||event.origin!==url.origin||event.source!==frame.contentWindow)return;
    let message:unknown=event.data;
    if(typeof message==='string'){if(message.length>1_000_000)return;try{message=JSON.parse(message);}catch{return;}}
    if(!message||typeof message!=='object'||!('event'in message)||typeof message.event!=='string'||!message.event.startsWith('privy:'))return;
    try{sdk.embeddedWallet.onMessage(message as Parameters<typeof sdk.embeddedWallet.onMessage>[0]);}catch{/* Never log wallet messages or provider exceptions. */}
  };
  window.addEventListener('message',receive);
  frame.addEventListener('load',onLoad);
  try {
    frame.src=url.href;document.body.append(frame);
    if(!frame.contentWindow)throw new Error('WALLET_FRAME_UNAVAILABLE');
    sdk.setMessagePoster({postMessage:(message,targetOrigin,transfer)=>{
      // The pinned SDK requests '*'; the actual browser target stays pinned to Privy.
      if(disposed||(targetOrigin!==url.origin&&targetOrigin!=='*'))throw new Error('WALLET_FRAME_ORIGIN_INVALID');
      if(typeof message!=='string'||message.length>1_000_000)throw new Error('WALLET_FRAME_MESSAGE_INVALID');
      // Decode the SDK's cross-platform wire JSON to a browser message object.
      let payload:unknown;try{payload=JSON.parse(message);}catch{throw new Error('WALLET_FRAME_MESSAGE_INVALID');}
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||!('event'in payload)||typeof payload.event!=='string'||!payload.event.startsWith('privy:'))throw new Error('WALLET_FRAME_MESSAGE_INVALID');
      if(!loaded){if(pending.length>=128)throw new Error('WALLET_FRAME_MESSAGE_INVALID');pending.push({message:payload as Record<string,unknown>,transfer});return;}
      frame.contentWindow!.postMessage(payload,url.origin,transfer?[transfer]:[]);
    },reload:()=>{if(!disposed){loaded=false;pending.length=0;frame.src=url.href;}}});
  }catch(error){window.removeEventListener('message',receive);frame.removeEventListener('load',onLoad);pending.length=0;frame.remove();throw error;}
  return {dispose:()=>{if(disposed)return;disposed=true;pending.length=0;window.removeEventListener('message',receive);frame.removeEventListener('load',onLoad);frame.remove();}};
};
async function within<T>(work:()=>Promise<T>,milliseconds:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('WALLET_SIGNATURE_OUTCOME_UNKNOWN')),milliseconds);})]);}
  finally{if(timer)clearTimeout(timer);}
}
export interface WalletConnection {wallet:string;chainId:string;status:'READY';}
/** Read existing wallet metadata and two read-only provider methods. Never sign,
 * create a wallet, switch a chain, reserve an operation or send a transaction. */
export async function inspectPrivyWalletConnection(wallet:string,chainId:string,sdk:WalletSdk,appId:string,active:()=>void=()=>{},bridgeFactory:WalletBridgeFactory=createWalletBridge,timeout=20000):Promise<WalletConnection>{
  const expected=address.parse(wallet),chain=positiveUint.parse(chainId);
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)throw Error('WALLET_CONNECTION_TIMEOUT_INVALID');
  return withWalletOperation(sdk,async()=>{
    let closed=false,bridge:WalletBridge|undefined;
    const guard=()=>{active();if(closed)throw Error('SESSION_CHANGED');};
    try{return await within(async()=>{
      guard();const {getAllUserEmbeddedEthereumWallets}=await import('@privy-io/js-sdk-core');
      const {user}=await sdk.user.get();guard();
      const matches=getAllUserEmbeddedEthereumWallets(user).filter(w=>eq(w.address,expected));
      if(matches.length!==1)throw Error('WALLET_OWNER_UNAVAILABLE');
      bridge=bridgeFactory(sdk,appId);guard();
      if(!await walletFrameReady(sdk,guard,Math.min(timeout,15000)))throw Error('WALLET_FRAME_UNAVAILABLE');
      const provider=await sdk.embeddedWallet.getProvider(matches[0]);guard();
      const observedChain=await provider.request({method:'eth_chainId'});guard();
      if(typeof observedChain!=='string'||!/^0x[0-9a-fA-F]+$/.test(observedChain)||BigInt(observedChain)!==BigInt(chain))throw Error('WALLET_CHAIN_MISMATCH');
      const accounts=await provider.request({method:'eth_accounts'});guard();
      if(!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&eq(a,expected)))throw Error('WALLET_OWNER_MISMATCH');
      return {wallet:expected,chainId:chain,status:'READY' as const};
    },timeout);}catch(error){
      if(error instanceof Error&&['SESSION_CHANGED','WALLET_OWNER_UNAVAILABLE','WALLET_FRAME_UNAVAILABLE','WALLET_FRAME_INVALID','WALLET_CHAIN_MISMATCH','WALLET_OWNER_MISMATCH'].includes(error.message))throw error;
      throw Error('WALLET_CONNECTION_UNAVAILABLE');
    }finally{closed=true;bridge?.dispose();}
  });
}
/** Only one canonical EIP-712 Grant. Caller must separately validate the executable
 * receipt, policy/evidence, fresh preflight and explicit user confirmation.
 */
async function signPrivyGrantOnce(input:unknown,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,bridgeFactory:WalletBridgeFactory,onRequest:()=>void,timeout:number):Promise<Hex> {
  const grant=Object.freeze(CapabilityGrantSchema.parse(input)),d=RecoveryDeploymentSchema.parse(deployment);
  if(grant.chainId!==d.chainId||!eq(grant.arbiter,d.arbiter)||!eq(grant.asset,d.asset)||!eq(grant.executor,d.executor))throw new Error('WALLET_GRANT_DEPLOYMENT_MISMATCH');
  const {getAllUserEmbeddedEthereumWallets}=await import('@privy-io/js-sdk-core');
  const {user}=await within(()=>sdk.user.get(),20000).catch(()=>{throw new Error('WALLET_OWNER_UNAVAILABLE');}),matches=getAllUserEmbeddedEthereumWallets(user).filter(wallet=>eq(wallet.address,grant.owner));
  if(matches.length!==1)throw new Error('WALLET_OWNER_UNAVAILABLE');
  const bridge=bridgeFactory(sdk,appId);let closed=false;
  const guard=()=>{if(closed)throw Error('SESSION_CHANGED');};
  try {
    return await within(async()=>{
      if(!await walletFrameReady(sdk,guard,Math.min(timeout,15000)))throw new Error('WALLET_FRAME_UNAVAILABLE');
      // Existing wallet only; no creation, export, recovery secrets, arbitrary RPC or retries.
      const provider=await sdk.embeddedWallet.getProvider(matches[0]);guard();
      const assertWallet=async()=>{
        guard();const chain=await provider.request({method:'eth_chainId'});guard();const accounts=await provider.request({method:'eth_accounts'});guard();
        if(typeof chain!=='string'||!/^0x[0-9a-fA-F]+$/.test(chain)||BigInt(chain)!==BigInt(grant.chainId))throw new Error('WALLET_CHAIN_MISMATCH');
        if(!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&eq(a,grant.owner)))throw new Error('WALLET_OWNER_MISMATCH');
      };
      await assertWallet();
      guard();if(BigInt(grant.deadline)<=BigInt(Math.floor(Date.now()/1000)))throw Error('AUTHORIZATION_EXPIRED');
      onRequest();
      const signature=await createWalletClient({transport:custom(provider,{retryCount:0})}).signTypedData({...grantTypedData(grant),account:grant.owner as Address});
      guard();
      await assertWallet();
      if(!await verifyGrantSignature(grant,signature))throw new Error('WALLET_OWNER_SIGNATURE_INVALID');
      return signature;
    },timeout);
  }catch(error){
    if(error instanceof Error&&['AUTHORIZATION_EXPIRED','SESSION_CHANGED','WALLET_CHAIN_MISMATCH','WALLET_OWNER_MISMATCH','WALLET_FRAME_UNAVAILABLE','WALLET_OWNER_SIGNATURE_INVALID','WALLET_SIGNATURE_OUTCOME_UNKNOWN'].includes(error.message))throw error;
    throw new Error('WALLET_SIGNATURE_CANCELLED_OR_UNAVAILABLE');
  }finally{closed=true;bridge.dispose();}
}
export async function signPrivyGrant(input:unknown,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,bridgeFactory:WalletBridgeFactory=createWalletBridge,timeout=60000):Promise<Hex> {
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw Error('WALLET_SIGNATURE_TIMEOUT_INVALID');
  let requested=false;
  try{return await withWalletOperation(sdk,()=>signPrivyGrantOnce(input,deployment,sdk,appId,bridgeFactory,()=>{requested=true;},timeout));}
  catch(error){if(!requested)throw new WalletSignatureNotRequested(error);throw error;}
}
