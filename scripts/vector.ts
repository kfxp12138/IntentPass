import { writeFileSync } from 'node:fs';
import { contextHash, intentSigningHash } from '../packages/protocol/src/index.js';
const d = (n: number) => `0x${n.toString(16).padStart(64,'0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
const envelope = { schemaVersion:1,chainId:'31337',arbiter:a(1),orderId:d(2),taskId:d(3),attempt:'1',
  buyer:a(4),seller:a(5),payee:a(5),asset:a(6),price:'10',bond:'0',datasetHash:d(7),
  serviceTermsHash:d(8),purchaseEvidenceCommitment:d(9),policyHash:d(10),reviewer:a(11),
  committeeHash:d(12),threshold:2,deliverySchemaHash:d(13),deliveryDeadline:'2000000000',
  settlementDeadline:'2000003600',allocationPolicyHash:d(14),intentReleasePolicyHash:d(15),pactPaymentPublicKeyHash:d(16) };
writeFileSync('fixtures/dev/hash-vector.json', JSON.stringify({kind:'LOCAL_ENCODING_FIXTURE_NOT_REAL_ORDER',envelope,contextHash:contextHash(envelope),signingHash:intentSigningHash(envelope)},null,2)+'\n');
