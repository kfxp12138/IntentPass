import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const day4OriginSourcePaths=['package.json','pnpm-lock.yaml','.env.example','contracts/foundry.toml','contracts/src/ContextVoteEscrow.sol','contracts/src/CleanverseEligibility.sol',
  'contracts/src/IntentHash.sol','contracts/src/AuthorizationHash.sol','contracts/src/IAssetEligibility.sol','packages/protocol/src/day4-origin-types.ts','packages/protocol/src/day4-origins.ts',
  'packages/protocol/src/day4-creation-pair.ts','packages/protocol/src/day4-creation-pair-port.ts','packages/protocol/src/day4-chain-flow-types.ts',
  'packages/protocol/src/day4-chain-flow.ts','packages/protocol/src/day4-chain-flow-port.ts',
  'packages/protocol/src/day4-submit-rejection-types.ts','packages/protocol/src/day4-submit-rejections.ts','packages/protocol/src/day4-submit-rejection-port.ts',
  'packages/protocol/src/day4-policy-probe-types.ts','packages/protocol/src/day4-policy-probe.ts','packages/adapters/src/day4-policy-probe-provider.ts','packages/storage/src/policy-probe-attempt-store.ts',
  'packages/protocol/src/day4-asset-failure-types.ts','packages/protocol/src/day4-asset-failures.ts','packages/adapters/src/day4-failure-trace.ts',
  'packages/protocol/src/cleanverse-inspection.ts','packages/protocol/src/cleanverse-inspection-types.ts','packages/protocol/src/cleanverse-inspection-port.ts',
  'packages/protocol/src/escrow-read.ts','packages/protocol/src/escrow-abi.ts',
  'packages/protocol/src/deployment-proof.ts','packages/protocol/src/deployment.ts','packages/protocol/src/cleanverse-gate-proof.ts','packages/protocol/src/cleanverse-gate-proof-types.ts',
  'packages/protocol/src/funding.ts','packages/protocol/src/allocation.ts','packages/protocol/src/withdrawal.ts','packages/protocol/src/fulfillment.ts',
  'packages/protocol/src/report.ts','packages/protocol/src/schemas.ts','packages/protocol/src/index.ts','packages/protocol/src/typed-data.ts','packages/protocol/src/escrow.ts',
  'packages/protocol/src/original-order-read.ts','packages/protocol/src/review-evidence.ts','packages/protocol/src/evidence-version.ts','packages/protocol/src/route.ts',
  'packages/capsule/src/format.ts','packages/capsule/src/recovery.ts','packages/capsule/src/crypto.ts','packages/adapters/src/privy-origin.ts',
  'packages/protocol/src/provider-submission.ts','packages/adapters/src/privy-auth.ts','packages/adapters/src/privy-origin-port.ts','packages/adapters/src/privy-sender.ts','scripts/inspect-day4-origins.ts','scripts/origin-artifacts.ts',
  'scripts/foundry-runtime.ts','scripts/private-origin-input.ts','scripts/release-review.ts','scripts/day5-review-types.ts','scripts/release-evidence-types.ts','scripts/deployment-artifacts.ts',
  'scripts/inspect-day4-submit-rejections.ts','scripts/day4-submit-rejection-observation.ts','scripts/release-source.ts',
  'scripts/inspect-day4-policy-probe.ts','scripts/day4-policy-probe-observation.ts',
  'scripts/inspect-day4-asset-failures.ts','scripts/day4-asset-failure-observation.ts',
  'scripts/strict-json.ts','scripts/public-audit.ts','scripts/verification-outcome.ts','scripts/day4-origin-source.ts','scripts/day4-origin-observation.ts','scripts/origin-artifact-bindings.ts','scripts/verify-day4.ts'] as const;
/** Freeze source before either verification command writes public evidence. */
export function day4OriginSourceBindings(){return day4OriginSourcePaths.map(path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});}
