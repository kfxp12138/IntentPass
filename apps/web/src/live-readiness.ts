import {createPublicClient,erc20Abi,parseAbi,type Address} from 'viem';
import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {verifyQuoteSignature} from '../../../packages/protocol/src/typed-data.js';
import {FileQuoteCatalog} from './catalog-api.js';
import type {GeneralRuntimeConfiguration} from '../../worker/src/intentpass-workflows.js';
import {loadActivatedReviewPolicy} from '../../../packages/adapters/src/review-policy.js';
import {liveGasReserves} from './live-gas-reserve.js';
/** Read-only, preliminary readiness. The original worker rechecks every authority
 * and exact transaction preflight immediately before use. */
export async function inspectLiveReadiness(c:GeneralRuntimeConfiguration,env:NodeJS.ProcessEnv,now=BigInt(Math.floor(Date.now()/1000))){
  const p=c.profile,d=p.deployment,blockers:string[]=[];
  if(!p.enabled||!c.walletDelegationApproved||!c.localPlaintextProcessingApproved)blockers.push('WALLET_CONNECTION_REQUIRED');
  if(p.expiresAt!==null&&BigInt(p.expiresAt)<=now)blockers.push('AUTOMATION_AUTHORITY_EXPIRED');
  for(const [name,keys] of Object.entries({PLANNER:['PLANNER_API_URL','PLANNER_API_KEY','PLANNER_MODEL'],JEV:['TYPESAFE_API_KEY','JEV_MODEL','REVIEW_POLICY_PATH'],PRIVY:['PRIVY_APP_ID','PRIVY_APP_SECRET']}))if(keys.some(k=>!env[k]))blockers.push(`${name}_CONFIGURATION_REQUIRED`);
  try{if(!env.REVIEW_POLICY_PATH||!env.JEV_MODEL||(loadActivatedReviewPolicy(env.REVIEW_POLICY_PATH,env.JEV_MODEL).questionVersion??1)!==1)blockers.push('LIVE_INTENT_REVIEW_REQUIRED');}catch{blockers.push('LIVE_INTENT_REVIEW_REQUIRED');}
  let entries:Awaited<ReturnType<FileQuoteCatalog['list']>>['entries']=[];
  try{if(!env.QUOTE_CATALOG_PATH)throw Error();const all=(await new FileQuoteCatalog(env.QUOTE_CATALOG_PATH).list()).entries;
    for(const e of all)if(BigInt(e.quote.expiresAt)>now&&e.quote.asset.toLowerCase()===d.asset.toLowerCase()&&e.quote.seller.toLowerCase()===p.seller.toLowerCase()&&e.quote.payee.toLowerCase()===p.seller.toLowerCase()&&await verifyQuoteSignature(e.quote,{chainId:d.chainId,arbiter:d.arbiter}))entries.push(e);
    if(!entries.length)blockers.push(all.length?'SIGNED_OFFERS_EXPIRED_OR_INVALID':'SIGNED_OFFERS_REQUIRED');
  }catch{blockers.push('CATALOGUE_UNAVAILABLE');}
  let balance:string|null=null,observedBlock:string|null=null;
  try{if(!env.MONAD_RPC_URL)throw Error();const client=createPublicClient({transport:pacedHttp(env.MONAD_RPC_URL,{timeout:12000})});
    if(await client.getChainId()!==10143)throw Error();const block=await client.getBlock({blockTag:'finalized'}),blockNumber=block.number;
    if(blockNumber===null)throw Error();observedBlock=String(blockNumber);
    const decimals=await client.readContract({address:d.asset as Address,abi:parseAbi(['function decimals() view returns(uint8)']),functionName:'decimals',blockNumber});if(decimals!==6)throw Error();
    balance=String(await client.readContract({address:d.asset as Address,abi:erc20Abi,functionName:'balanceOf',args:[p.buyer as Address],blockNumber}));
    if(balance==='0')blockers.push('BUYER_TEST_TOKENS_REQUIRED');
    const reserves=liveGasReserves(await client.getGasPrice(),env.PRIVY_GAS_LIMIT);
    for(const [role,address] of [['BUYER',p.buyer],['SELLER',p.seller],['EXECUTOR',d.executor]] as const)if(await client.getBalance({address:address as Address,blockNumber})<reserves[role])blockers.push(`${role}_GAS_REQUIRED`);
  }catch{blockers.push('CHAIN_READ_UNAVAILABLE');}
  return {context:{chainId:d.chainId,buyer:p.buyer,seller:p.seller,asset:d.asset,arbiter:d.arbiter},catalogue:{entries},balance,observedBlock,blockers,checkedAt:new Date().toISOString(),authorityRecheckedOnExecution:true};
}
