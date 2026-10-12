import { z } from 'zod';

export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const digest = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/)
  .pipe(z.string().refine(v => BigInt(v) < 2n ** 256n, 'uint256 overflow'));
export const positiveUint = uint.pipe(z.string().refine(v => BigInt(v) > 0n));
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export const TaskPolicySchema = z.object({
  schemaVersion: z.literal(1), taskId: digest, datasetHash: digest,
  action: z.literal('dataset-report'), metrics: z.tuple([z.literal('count'), z.literal('sum'), z.literal('min'), z.literal('max')]),
  purpose: z.literal('commercial'), budget: positiveUint, allowedAsset: address,
  requiredFacts: z.tuple([z.literal('service-matches-task'), z.literal('commercial-use-permitted'), z.literal('evidence-belongs-to-service')]),
  version: positiveUint,
}).strict();
export const SignedQuoteSchema = z.object({
  schemaVersion: z.literal(1), quoteId: digest, service: z.literal('dataset-report'),
  seller: address, payee: address, asset: address, amount: positiveUint,
  serviceTerms: z.string().min(1).max(16000), serviceTermsHash: digest,
  expiresAt: positiveUint, signature,
}).strict();
const envelopeShape = {
  schemaVersion: z.literal(1), chainId: positiveUint, arbiter: address,
  orderId: digest, taskId: digest, attempt: positiveUint, buyer: address, seller: address,
  payee: address, asset: address, price: positiveUint, bond: uint, datasetHash: digest,
  serviceTermsHash: digest, purchaseEvidenceCommitment: digest, policyHash: digest,
  reviewer: address, committeeHash: digest, threshold: z.literal(2), deliverySchemaHash: digest,
  deliveryDeadline: positiveUint, settlementDeadline: positiveUint,
  allocationPolicyHash: digest, intentReleasePolicyHash: digest, pactPaymentPublicKeyHash: digest,
};
export const IntentEnvelopeSchema = z.object(envelopeShape).strict().refine(
  e => /^[0-9]+$/.test(e.settlementDeadline) && /^[0-9]+$/.test(e.deliveryDeadline)
    && BigInt(e.settlementDeadline) > BigInt(e.deliveryDeadline), 'settlement must follow delivery',
);
export type IntentEnvelope = z.infer<typeof IntentEnvelopeSchema>;
export const DecisionReceiptSchema = z.object({
  schemaVersion: z.literal(1), contextHash: digest, purchaseEvidenceCommitment: digest,
  policyHash: digest, reviewer: address, modelId: z.string().min(1).max(128),
  questionConfigHash: digest, decision: z.literal('PASS'), expiresAt: positiveUint, signature,
}).strict();
export const CapabilityGrantSchema = z.object({
  schemaVersion: z.literal(1), owner: address, executor: address, chainId: positiveUint,
  arbiter: address, orderId: digest, asset: address, amount: positiveUint,
  contextHash: digest, preparationHash: digest, receiptHash: digest,
  nonce: uint, deadline: positiveUint, maxUses: z.literal(1),
}).strict();
export const DeliveryRecordSchema = z.object({
  schemaVersion: z.literal(1), orderId: digest, datasetHash: digest,
  reportHash: digest, serviceTermsHash: digest,
}).strict();
export const IntentCapsuleSchema = z.object({
  schemaVersion: z.literal(1), objectId: digest, revision: positiveUint,
  namespace: z.array(z.string().min(1).max(128)).min(4).max(8),
  iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/), ciphertext: z.string().min(24).max(1_400_000),
}).strict();

