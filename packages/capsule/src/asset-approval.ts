import {encodeFunctionData,type Address,type Hex} from 'viem';
import {PreflightSnapshotSchema} from '../../protocol/src/purchase-preflight.js';
import {verifyOriginalAuthorization,RecoveryDeploymentSchema,type RecoveryDeployment} from './recovery.js';
export const exactApprovalAbi=[{type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}],outputs:[{name:'',type:'bool'}]}] as const;
export type ApprovalStep='RESET'|'SET';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Canonical fixed-asset approve only. A snapshot is observation, not execution authority.
 * Whole original authorization must verify; expired history cannot set allowance.
 */
export async function prepareExactApproval(input:unknown,deployment:RecoveryDeployment,wallets:string[],observation:unknown,step:ApprovalStep,now:bigint) {
  const d=RecoveryDeploymentSchema.parse(deployment),payload=await verifyOriginalAuthorization(input,wallets,d),g=payload.grant;
  const s=PreflightSnapshotSchema.parse(observation);
  if(now>=BigInt(g.deadline)||now>=BigInt(payload.receipt.expiresAt)||now>=BigInt(payload.quote.expiresAt))throw new Error('AUTHORIZATION_EXPIRED');
  if(s.block.finality!=='finalized'||s.chainId!==g.chainId||s.nonce!==g.nonce||s.amount!==g.amount||s.deadline!==g.deadline
    ||([['arbiter',g.arbiter],['asset',g.asset],['buyer',g.owner],['orderId',g.orderId],['contextHash',g.contextHash]] as const).some(([key,value])=>!eq(s[key],value)))throw new Error('APPROVAL_PREFLIGHT_MISMATCH');
  if(s.blockers.some(reason=>reason!=='EXACT_ALLOWANCE_REQUIRED'))throw new Error('APPROVAL_CHAIN_BLOCKED');
  if(s.allowance===g.amount)throw new Error('EXACT_ALLOWANCE_ALREADY_SET');
  if(step==='RESET'&&s.allowance==='0')throw new Error('ALLOWANCE_RESET_NOT_REQUIRED');
  if(step==='SET'&&s.allowance!=='0')throw new Error('ALLOWANCE_RESET_REQUIRED');
  if(step!=='RESET'&&step!=='SET')throw new Error('APPROVAL_STEP_INVALID');
  const amount=step==='RESET'?'0':g.amount;
  return Object.freeze({chainId:g.chainId,owner:g.owner as Address,asset:g.asset as Address,spender:g.arbiter as Address,orderId:g.orderId,
    amount,step,data:encodeFunctionData({abi:exactApprovalAbi,functionName:'approve',args:[g.arbiter as Address,BigInt(amount)]}) as Hex,value:'0' as const,
    canSubmitPayment:false as const});
}
