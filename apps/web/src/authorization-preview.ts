import {DraftSchema,ReviewResultSchema} from '../../../packages/protocol/src/purchase-api.js';
import {CapabilityGrantSchema} from '../../../packages/protocol/src/schemas.js';
import {PreflightSnapshotSchema} from '../../../packages/protocol/src/purchase-preflight.js';
/** Display/window helpers only. Signature and policy checks remain in PurchaseFlow. */
export function authorizationDeadline(draft:unknown,review:unknown,duration:string,now:bigint):string {
  const d=DraftSchema.parse(draft),r=ReviewResultSchema.parse(review);
  if(r.source!=='JEV'||r.decision!=='PASS'||!r.executable)throw new Error('EXECUTABLE_PASS_REQUIRED');
  if(!/^[1-9][0-9]{0,2}$/.test(duration)||BigInt(duration)>300n||now<0n)throw new Error('AUTHORIZATION_WINDOW_INVALID');
  const deadline=[now+BigInt(duration),BigInt(d.quote.expiresAt),BigInt(r.receipt.expiresAt),BigInt(d.intent.deliveryDeadline)].reduce((a,b)=>a<b?a:b);
  if(deadline<=now)throw new Error('AUTHORIZATION_EXPIRED');return String(deadline);
}
export function candidateNonce():string {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return BigInt('0x'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')).toString();
}
function time(seconds:string):string {
  const n=BigInt(seconds);return n<=8640000000000n?`${new Date(Number(n)*1000).toISOString()}（UTC，${seconds} 秒）`:`${seconds} 秒（Unix 时间）`;
}
export function grantPreview(input:unknown):string {
  const g=CapabilityGrantSchema.parse(input);
  return `原订单：${g.orderId}\n授权账户：${g.owner}\n指定执行者：${g.executor}\n网络 ID：${g.chainId}\n固定托管合约：${g.arbiter}\n资产：${g.asset}\n准确金额：${g.amount}（资产最小单位，价格与保证金之和）\n有效截止：${time(g.deadline)}\n使用次数：仅一次\n候选 nonce：${g.nonce}\n上下文摘要：${g.contextHash}\n授权准备摘要：${g.preparationHash}\n审核回执摘要：${g.receiptHash}\n\n尚未签署、批准资产或付款。nonce 未被预留，链上状态仍需核对。`;
}
const reasons={ORDER_ALREADY_REGISTERED:'原订单已登记，应查看原订单，不能再次入金。',NONCE_CONSUMED:'该账户的 nonce 已消费，不能重复使用。',NONCE_REVOKED:'该账户已撤销此 nonce。',AUTHORIZATION_EXPIRED:'授权或交付期限已到。',BUYER_INELIGIBLE:'当前资格 gate 不允许买方向托管合约转移本单金额。',INSUFFICIENT_BALANCE:'买方资产余额不足。',EXACT_ALLOWANCE_REQUIRED:'资产授权额度须准确等于本单总金额；更小或更大的额度都需调整。'} as const;
export function preflightPreview(input:unknown):string {
  const p=PreflightSnapshotSchema.parse(input);
  if(p.block.finality!=='finalized')throw new Error('PREFLIGHT_FINALITY_REQUIRED');
  return `原订单：${p.orderId}\n已最终确认区块：${p.block.number}\n区块摘要：${p.block.hash}\n区块时间：${time(p.block.timestamp)}\n资产余额：${p.balance}\n当前资产授权额度：${p.allowance}\n本单总金额：${p.amount}\n金额均为资产最小单位。\n\n${p.blockers.length?p.blockers.map(r=>reasons[r]).join('\n'):'该区块未观察到上述阻塞。'}\n\n这是只读快照，不预留 nonce，也不保证之后状态不变。尚未签署、批准资产或付款。`;
}
