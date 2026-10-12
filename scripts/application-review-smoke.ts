import {randomBytes} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {type Address,type Hex} from 'viem';
import {ReviewRequestSchema} from '../packages/protocol/src/draft.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
import {policyHash,termsHash,quoteTypedData,receiptTypedData} from '../packages/protocol/src/typed-data.js';
import {ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from '../packages/protocol/src/escrow.js';
import type {ReceiptSigner} from '../apps/web/src/services/review.js';

const hash=()=>`0x${randomBytes(32).toString('hex')}` as Hex;
const address=()=>`0x${randomBytes(20).toString('hex')}` as Address;
/** New public application smoke inputs, separate from both frozen evaluation cohorts. */
export async function applicationReviewSmokeCases(now:bigint){
  const seller=privateKeyToAccount(generatePrivateKey()),reviewer=privateKeyToAccount(generatePrivateKey());
  const deployment={chainId:'10143',arbiter:address(),asset:address(),gate:address(),reviewer:reviewer.address,committeeHash:hash()};
  const domain={chainId:deployment.chainId,arbiter:deployment.arbiter};
  const buyer=address(),dataset=hash(),task=hash();
  const policy={schemaVersion:1,taskId:task,datasetHash:dataset,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'10',allowedAsset:deployment.asset,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
  const specifications=[
    {id:'application-complete',expected:'PASS' as const,rights:'The license for this exact report explicitly permits the buyer to use the report commercially, including commercial redistribution.'},
    {id:'application-license-missing',expected:'ABSTAIN' as const,rights:'The analysis software source code has an MIT license. No license or permission for use of the resulting report is stated.'},
    {id:'application-commercial-forbidden',expected:'REJECT' as const,rights:'This exact report is licensed for personal, non-commercial use only. Commercial use and commercial redistribution of this report are explicitly prohibited.'},
  ];
  const cases=[];
  for(const spec of specifications){
    const quoteId=hash(),serviceTerms=`Seller ${seller.address} offers the current dataset-report under quote ${quoteId}. This report computes count, sum, min and max for the exact dataset ${dataset}. ${spec.rights}`;
    const unsigned={schemaVersion:1,quoteId,service:'dataset-report',seller:seller.address,payee:seller.address,asset:deployment.asset,amount:'10',serviceTerms,serviceTermsHash:termsHash(serviceTerms),expiresAt:String(now+3600n)};
    const quote={...unsigned,signature:await seller.signTypedData(quoteTypedData(unsigned,domain))};
    const evidence={schemaVersion:2,salt:hash(),taskText:`Buy a count, sum, min and max report for the exact dataset ${dataset}. The report license must explicitly permit commercial use. The budget is 10 units of the designated asset.`,documents:[{id:'current-quote-terms',subjectQuoteId:quoteId,text:serviceTerms}]};
    const input=ReviewRequestSchema.parse({policy,quote,evidence,intent:{schemaVersion:1,chainId:deployment.chainId,arbiter:deployment.arbiter,asset:deployment.asset,reviewer:deployment.reviewer,committeeHash:deployment.committeeHash,orderId:hash(),taskId:task,attempt:'1',buyer,seller:seller.address,payee:seller.address,price:'10',bond:'0',datasetHash:dataset,serviceTermsHash:quote.serviceTermsHash,purchaseEvidenceCommitment:purchaseEvidenceHash(evidence),policyHash:policyHash(policy),threshold:2,deliverySchemaHash:DELIVERY_SCHEMA,deliveryDeadline:String(now+3600n),settlementDeadline:String(now+7200n),allocationPolicyHash:ALLOCATION_POLICY,intentReleasePolicyHash:RELEASE_POLICY,pactPaymentPublicKeyHash:ZERO_HASH}});
    cases.push({id:spec.id,expected:spec.expected,input});
  }
  const signer:ReceiptSigner={address:reviewer.address,sign:(receipt,domain)=>reviewer.signTypedData(receiptTypedData(receipt,domain))};
  return {deployment,principal:{subject:'public-smoke-local-principal',wallets:[buyer]},signer,cases};
}
