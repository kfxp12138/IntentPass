import type Privy from '@privy-io/js-sdk-core';
import {GeneralConnectionPlanSchema,type GeneralConnectionPlan} from '../../../packages/protocol/src/general-connection.js';
import {createWalletBridge,walletFrameReady,type WalletBridgeFactory} from './privy-grant-wallet.js';
import {withWalletOperation} from './privy-wallet-operation.js';
import type {BrowserConfiguration} from '../../../packages/capsule/src/session-schema.js';
/** One initial owner update. Plan comes from the authenticated server and a fresh
 * durable reservation. Never creates wallets, removes other signers or pays. */
export function connectGeneralWallet(input:unknown,role:'buyer'|'seller',configuration:BrowserConfiguration,client:Privy,active:()=>void,bridgeFactory:WalletBridgeFactory=createWalletBridge){return withWalletOperation(client,async()=>{
  const plan:GeneralConnectionPlan=GeneralConnectionPlanSchema.parse(input),d=configuration.recoveryDeployment,r=plan.roles.find(r=>r.role===role)!;
  if(!d||d.chainId!==plan.chainId||d.asset.toLowerCase()!==plan.asset.toLowerCase()||d.arbiter.toLowerCase()!==plan.arbiter.toLowerCase())throw Error('GENERAL_CONNECTION_DEPLOYMENT_CHANGED');
  active();const {getAllUserEmbeddedEthereumWallets,addSessionSigners}=await import('@privy-io/js-sdk-core'),{user}=await client.user.get();active();const wallets=getAllUserEmbeddedEthereumWallets(user).filter(w=>w.address.toLowerCase()===r.address.toLowerCase());if(wallets.length!==1)throw Error('GENERAL_CONNECTION_OWNER_REQUIRED');
  const bridge=bridgeFactory(client,configuration.privyAppId);let dispatched=false,closed=false,timer:ReturnType<typeof setTimeout>|undefined;const guard=()=>{active();if(closed)throw Error('SESSION_CHANGED');};
  try{return await Promise.race([(async()=>{if(!await walletFrameReady(client,guard))throw Error('GENERAL_CONNECTION_FRAME_UNAVAILABLE');guard();dispatched=true;const returned=await addSessionSigners({client,wallet:wallets[0],signers:[{signer_id:r.signerId,override_policy_ids:[r.policyId]}]});guard();if(returned.user.id!==user.id)throw Error('GENERAL_CONNECTION_OWNER_CHANGED');return {status:'OWNER_REQUEST_COMPLETED' as const};})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{closed=true;reject(Error('GENERAL_CONNECTION_OUTCOME_UNKNOWN'));},60000);})]);}
  catch{throw Error(dispatched?'GENERAL_CONNECTION_OUTCOME_UNKNOWN':'GENERAL_CONNECTION_OWNER_REQUEST_UNAVAILABLE');}finally{closed=true;if(timer)clearTimeout(timer);bridge.dispose();}
});}
