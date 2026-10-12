import {z} from 'zod';
import {encodeFunctionData,type Hex} from 'viem';
import {AuthorizationPayloadSchema} from '../../capsule/src/format.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from '../../capsule/src/recovery.js';
import {OrderSnapshotSchema,type OrderSnapshot} from './escrow-read.js';
import {assertFulfillmentOrder} from './fulfillment.js';
import {address,digest,uint,positiveUint} from './schemas.js';
import {escrowAbi} from './escrow-abi.js';
export const WithdrawalRequestSchema=z.object({payload:AuthorizationPayloadSchema,beneficiary:address}).strict();
export const WithdrawalReconcileRequestSchema=WithdrawalRequestSchema.extend({hash:digest}).strict();
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function request(input:unknown){return z.union([WithdrawalRequestSchema,WithdrawalReconcileRequestSchema]).parse(input);}
export async function verifyWithdrawalRequest(input:unknown,wallets:readonly string[],deployment:RecoveryDeployment){const r=request(input);if(![r.payload.intent.buyer,r.payload.intent.payee].some(a=>eq(a,r.beneficiary))||!wallets.some(a=>eq(a,r.beneficiary)))throw new Error('WITHDRAWAL_ROLE_MISMATCH');await verifyOriginalAuthorization(r.payload,[r.payload.intent.buyer],deployment);return r;}
export function withdrawalCalldata(input:unknown):Hex{const r=request(input);if(![r.payload.intent.buyer,r.payload.intent.payee].some(a=>eq(a,r.beneficiary)))throw new Error('WITHDRAWAL_ROLE_MISMATCH');return encodeFunctionData({abi:escrowAbi,functionName:'withdraw',args:[r.payload.intent.orderId as Hex]});}
export function allocatedAmount(order:{buyer:string;payee:string;price:string;bond:string;state:OrderSnapshot['state']},beneficiary:string){const buyer=eq(order.buyer,beneficiary),payee=eq(order.payee,beneficiary);if(!buyer&&!payee)throw new Error('WITHDRAWAL_ROLE_MISMATCH');const p=BigInt(order.price),b=BigInt(order.bond);if(!order.state.startsWith('ALLOCATED_'))return 0n;const [toBuyer,toPayee]=order.state==='ALLOCATED_PAID'?[b,p]:order.state==='ALLOCATED_REFUND'?[p+b,0n]:[p,b];return (buyer?toBuyer:0n)+(payee?toPayee:0n);}
export function withdrawalLedger(input:unknown,snapshot:unknown){const r=request(input),o=OrderSnapshotSchema.parse(snapshot) as OrderSnapshot;assertFulfillmentOrder(r.payload,o);withdrawalCalldata(r);
  if(eq(o.buyer,o.payee)&&(o.credits.buyer!==o.credits.payee||o.withdrawn.buyer!==o.withdrawn.payee))throw new Error('WITHDRAWAL_LEDGER_MISMATCH');
  let totalCredit=0n;for(const [actor,slot] of [[o.buyer,'buyer'],[o.payee,'payee']] as const){if(slot==='payee'&&eq(o.buyer,o.payee))continue;const allocated=allocatedAmount(o,actor),credit=BigInt(o.credits[slot]),withdrawn=BigInt(o.withdrawn[slot]);if(credit+withdrawn!==allocated||withdrawn!==0n&&withdrawn!==allocated)throw new Error('WITHDRAWAL_LEDGER_MISMATCH');totalCredit+=credit;}
  if(totalCredit>BigInt(o.accounting.outstanding))throw new Error('WITHDRAWAL_LEDGER_MISMATCH');const slot=eq(o.buyer,r.beneficiary)?'buyer':'payee';return {order:o,amount:o.credits[slot],withdrawn:o.withdrawn[slot]};
}
export const withdrawalBlockers=['ORDER_NOT_ALLOCATED','NO_CREDIT','IDENTITY_BLOCKED'] as const;
export const WithdrawalPreparationSchema=z.object({kind:z.literal('WITHDRAWAL_PREPARED'),order:OrderSnapshotSchema,beneficiary:address,amount:uint,withdrawn:uint,beneficiaryBalance:uint,transferEligible:z.boolean().nullable(),blockers:z.array(z.enum(withdrawalBlockers)),finality:z.literal('finalized'),chainId:positiveUint,target:address,data:z.string().regex(/^0x[0-9a-fA-F]+$/),value:z.literal('0'),canExecute:z.literal(false)}).strict();
/** Validate a read-only snapshot; it never grants execution or another withdrawal. */
export function checkWithdrawalPreparation(input:unknown,response:unknown){const r=WithdrawalRequestSchema.parse(input),p=WithdrawalPreparationSchema.parse(response),ledger=withdrawalLedger(r,p.order),blockers:string[]=[];if(!p.order.state.startsWith('ALLOCATED_'))blockers.push('ORDER_NOT_ALLOCATED');if(ledger.amount==='0')blockers.push('NO_CREDIT');else if(p.transferEligible===false)blockers.push('IDENTITY_BLOCKED');
  if(!eq(p.beneficiary,r.beneficiary)||p.chainId!==r.payload.intent.chainId||!eq(p.target,r.payload.intent.arbiter)||!eq(p.data,withdrawalCalldata(r))||p.amount!==ledger.amount||p.withdrawn!==ledger.withdrawn||(p.amount==='0')!==(p.transferEligible===null)||JSON.stringify(p.blockers)!==JSON.stringify(blockers))throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');return p;
}
export const WithdrawalReceiptSchema=z.union([z.object({status:z.literal('PENDING'),hash:digest,canExecute:z.literal(false)}).strict(),z.object({status:z.enum(['CONFIRMED','REVERTED']),hash:digest,beneficiary:address,transferredAmount:uint,beneficiaryBalance:uint,order:OrderSnapshotSchema,receiptBlock:z.object({number:uint,hash:digest}).strict(),finality:z.literal('finalized'),canExecute:z.literal(false)}).strict()]);
export function checkWithdrawalReceipt(input:unknown,response:unknown){const r=WithdrawalReconcileRequestSchema.parse(input),p=WithdrawalReceiptSchema.parse(response);withdrawalCalldata(r);if(!eq(r.hash,p.hash))throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');if(p.status==='PENDING')return p;const ledger=withdrawalLedger(r,p.order);
  if(!eq(p.beneficiary,r.beneficiary)||BigInt(p.receiptBlock.number)>BigInt(p.order.block.number)||p.receiptBlock.number===p.order.block.number&&!eq(p.receiptBlock.hash,p.order.block.hash))throw new Error('WITHDRAWAL_RESPONSE_MISMATCH');
  if(p.status==='REVERTED'){if(p.transferredAmount!=='0')throw new Error('WITHDRAWAL_EFFECT_UNPROVEN');}else{const amount=allocatedAmount(ledger.order,r.beneficiary);if(amount===0n||p.transferredAmount!==String(amount)||ledger.amount!=='0'||ledger.withdrawn!==String(amount))throw new Error('WITHDRAWAL_EFFECT_UNPROVEN');}return p;
}
