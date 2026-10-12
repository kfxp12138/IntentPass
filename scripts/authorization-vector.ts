import { writeFileSync } from 'node:fs';
import { hashStruct } from 'viem';
import { policyHash, termsHash, quoteTypedData, receiptTypedData, grantTypedData, quoteSigningHash,
  receiptHash, grantSigningHash } from '../packages/protocol/src/index.js';
const d=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const deployment={chainId:'31337',arbiter:a(1)};
const policy={schemaVersion:1,taskId:d(1),datasetHash:d(2),action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'10',allowedAsset:a(2),requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
const quote={schemaVersion:1,quoteId:d(3),service:'dataset-report',seller:a(4),payee:a(4),asset:a(2),amount:'10',serviceTerms:'Commercial use of this report is permitted.',serviceTermsHash:termsHash('Commercial use of this report is permitted.'),expiresAt:'2000000000'};
const receipt={schemaVersion:1,contextHash:d(5),purchaseEvidenceCommitment:d(6),policyHash:policyHash(policy),reviewer:a(7),modelId:'local-crypto-fixture-only',questionConfigHash:d(8),decision:'PASS',expiresAt:'2000000000'};
const grant={schemaVersion:1,owner:a(9),executor:a(10),chainId:deployment.chainId,arbiter:deployment.arbiter,orderId:d(11),asset:a(2),amount:'10',contextHash:d(5),preparationHash:d(12),receiptHash:receiptHash(receipt,deployment),nonce:'0',deadline:'2000000000',maxUses:1};
const q=quoteTypedData(quote,deployment),r=receiptTypedData(receipt,deployment),g=grantTypedData(grant);
writeFileSync('fixtures/dev/authorization-vector.json',JSON.stringify({kind:'LOCAL_ENCODING_FIXTURE_NOT_REAL_AUTHORIZATION',deployment,policy,quote,receipt,grant,
  hashes:{policy:policyHash(policy),quoteStruct:hashStruct({data:q.message,types:q.types,primaryType:q.primaryType}),quoteSigning:quoteSigningHash(quote,deployment),
    receiptStruct:hashStruct({data:r.message,types:r.types,primaryType:r.primaryType}),receiptSigning:receiptHash(receipt,deployment),
    grantStruct:hashStruct({data:g.message,types:g.types,primaryType:g.primaryType}),grantSigning:grantSigningHash(grant)}},null,2)+'\n');
