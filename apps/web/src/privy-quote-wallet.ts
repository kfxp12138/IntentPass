import {createWalletClient,custom,type Address,type Hex} from 'viem';
import {getAllUserEmbeddedEthereumWallets} from '@privy-io/js-sdk-core';
import {UnsignedDemoQuoteSchema} from '../../../packages/protocol/src/demo-quotes.js';
import {quoteTypedData,verifyQuoteSignature,termsHash} from '../../../packages/protocol/src/typed-data.js';
import type {RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {createWalletBridge,walletFrameReady,type WalletSdk,type WalletBridgeFactory} from './privy-grant-wallet.js';
import {withWalletOperation} from './privy-wallet-operation.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export async function signPrivyDemoQuote(input:unknown,subject:string,confirmation:boolean,deployment:RecoveryDeployment,sdk:WalletSdk,appId:string,reserve:()=>Promise<boolean>,active:()=>void,bridgeFactory:WalletBridgeFactory=createWalletBridge,timeout=60000):Promise<Hex>{
  if(confirmation!==true)throw Error('DEMO_QUOTE_CONFIRMATION_REQUIRED');const q=Object.freeze(UnsignedDemoQuoteSchema.parse(input)),d=deployment;
  const valid=()=>{const now=BigInt(Math.floor(Date.now()/1000));return d.chainId==='10143'&&eq(q.asset,d.asset)&&eq(q.seller,q.payee)&&q.amount==='10'&&eq(q.serviceTermsHash,termsHash(q.serviceTerms))&&BigInt(q.expiresAt)>now&&BigInt(q.expiresAt)<=now+86400n;};
  if(!valid())throw Error('DEMO_QUOTE_SCOPE_INVALID');let closed=false,reserved=false,timer:ReturnType<typeof setTimeout>|undefined,dispose=()=>{};
  const guard=()=>{active();if(closed||!valid())throw Error('SESSION_CHANGED');};
  const work=withWalletOperation(sdk,async()=>{
    guard();const {user}=await sdk.user.get();guard();if(user.id!==subject)throw Error('SESSION_CHANGED');const wallets=getAllUserEmbeddedEthereumWallets(user).filter(w=>eq(w.address,q.seller));if(wallets.length!==1)throw Error('DEMO_QUOTE_SELLER_WALLET_UNAVAILABLE');
    const bridge=bridgeFactory(sdk,appId);let disposed=false;dispose=()=>{if(!disposed){disposed=true;bridge.dispose();}};
    try{
      if(!await walletFrameReady(sdk,guard,Math.min(timeout,15000)))throw Error('WALLET_FRAME_UNAVAILABLE');guard();const provider=await sdk.embeddedWallet.getProvider(wallets[0]);
      const assertWallet=async()=>{guard();const [chain,accounts]=await Promise.all([provider.request({method:'eth_chainId'}),provider.request({method:'eth_accounts'})]);guard();if(typeof chain!=='string'||!/^0x[0-9a-fA-F]+$/.test(chain)||BigInt(chain)!==10143n||!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&eq(a,q.seller)))throw Error('DEMO_QUOTE_WALLET_MISMATCH');};
      await assertWallet();reserved=await reserve();guard();if(!reserved)throw Error('DEMO_QUOTE_ORIGINAL_SIGNATURE_REQUIRED');
      const signature=await createWalletClient({transport:custom(provider,{retryCount:0})}).signTypedData({...quoteTypedData(q,{chainId:d.chainId,arbiter:d.arbiter}),account:q.seller as Address});guard();await assertWallet();
      if(!await verifyQuoteSignature({...q,signature},{chainId:d.chainId,arbiter:d.arbiter}))throw Error('DEMO_QUOTE_SIGNATURE_INVALID');guard();return signature;
    }finally{dispose();}
  });
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('DEMO_QUOTE_SIGNATURE_OUTCOME_UNKNOWN')),timeout);})]);}
  catch(error){if(reserved)throw Error('DEMO_QUOTE_SIGNATURE_OUTCOME_UNKNOWN');if(error instanceof Error&&/^(?:DEMO_QUOTE|WALLET_FRAME|WALLET_SIGNATURE|SESSION_CHANGED)/.test(error.message))throw error;throw Error('DEMO_QUOTE_WALLET_UNAVAILABLE');}
  finally{closed=true;if(timer)clearTimeout(timer);dispose();}
}
