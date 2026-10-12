import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {verifyOriginalAuthorization,type RecoveryDeployment} from '../../../packages/capsule/src/recovery.js';
import {PreflightSnapshotSchema,type PreflightSnapshot} from '../../../packages/protocol/src/purchase-preflight.js';

/** This can end the job, never unlock its original funding reservation. The
 * contract rejects a grant strictly AFTER its deadline (not at equality). */
export function checkExpiredUnfunded(input:unknown,observation:unknown):PreflightSnapshot|undefined {
  const p=AuthorizationPayloadSchema.parse(input),s=PreflightSnapshotSchema.parse(observation),g=p.grant;
  const expected={chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,buyer:g.owner,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,deadline:g.deadline};
  for(const [key,value] of Object.entries(expected))if(String(s[key as keyof typeof expected]).toLowerCase()!==value.toLowerCase())throw Error('EXPIRY_ORIGINAL_CONTEXT_MISMATCH');
  if(s.block.finality!=='finalized'||s.state!=='UNREGISTERED'||s.consumed||BigInt(s.block.timestamp)<=BigInt(g.deadline))return undefined;
  return s;
}

/** Historical signatures and a coherent finalized read are required. This port
 * has no sender, signer, workflow submission or retry method. */
export async function inspectExpiredUnfunded(input:unknown,deployment:RecoveryDeployment,read:(input:unknown)=>Promise<unknown>){
  const original=AuthorizationPayloadSchema.parse(structuredClone(input));
  const p=await verifyOriginalAuthorization(original,[original.intent.buyer],deployment);
  return checkExpiredUnfunded(p,await read({intent:p.intent,grant:p.grant}));
}
