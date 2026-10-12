import {readFileSync} from 'node:fs';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import type {Address,Hex} from 'viem';
import {AuthorizationPayloadSchema} from '../../packages/capsule/src/format.js';
import type {RecoveryDeployment} from '../../packages/capsule/src/recovery.js';
import {contextHash,policyHash,termsHash,quoteTypedData,receiptTypedData,grantTypedData,compileGrant,committeeHash,preparationHash,ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH,purchaseEvidenceHash} from '../../packages/protocol/src/index.js';
import {createReport} from '../../packages/protocol/src/report.js';
import type {OrderSnapshot,OrderState} from '../../packages/protocol/src/escrow-read.js';
export const readTestHash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
export const readTestAddress=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
/** Generated local EOA identities and signed provider doubles; never acceptance evidence. */
export async function originalAuthorizationFixture(chainId:'31337'|'10143'='31337',options:{arbiter?:Address;singleReportBackground?:boolean}={}){
  const h=readTestHash,a=readTestAddress,buyer=privateKeyToAccount(generatePrivateKey()),seller=privateKeyToAccount(generatePrivateKey()),reviewer=privateKeyToAccount(generatePrivateKey());
  const deployment:RecoveryDeployment={chainId,arbiter:options.arbiter??a(99),asset:a(88),reviewer:reviewer.address,committee:options.singleReportBackground?[buyer.address,seller.address,a(3)]:[a(1),a(2),a(3)],executor:a(77)},domain={chainId:deployment.chainId,arbiter:deployment.arbiter},dataset=[3,7,11,19];
  const policy={schemaVersion:1,taskId:h(1),datasetHash:createReport(dataset).datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:options.singleReportBackground?'10':'15',allowedAsset:deployment.asset,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
  const evidence={schemaVersion:2,salt:h(100),taskText:'LOCAL PRIVATE TASK MUST NOT BE SENT IN ORDER READ',documents:[{id:'license',subjectQuoteId:h(3),text:'LOCAL PRIVATE EVIDENCE MUST NOT BE SENT IN ORDER READ'}]};
  const uq={schemaVersion:1,quoteId:h(3),service:'dataset-report',seller:seller.address,payee:seller.address,asset:deployment.asset,amount:'10',serviceTerms:'Commercial use permitted.',serviceTermsHash:termsHash('Commercial use permitted.'),expiresAt:'1900'},quote={...uq,signature:await seller.signTypedData(quoteTypedData(uq,domain))};
  const base=JSON.parse(readFileSync('fixtures/dev/hash-vector.json','utf8')).envelope;
  const intent={...base,...domain,buyer:buyer.address,seller:seller.address,payee:seller.address,asset:deployment.asset,taskId:policy.taskId,datasetHash:policy.datasetHash,price:'10',bond:options.singleReportBackground?'0':'5',policyHash:policyHash(policy),purchaseEvidenceCommitment:purchaseEvidenceHash(evidence),reviewer:reviewer.address,committeeHash:committeeHash(deployment.committee),serviceTermsHash:quote.serviceTermsHash,allocationPolicyHash:ALLOCATION_POLICY,intentReleasePolicyHash:RELEASE_POLICY,deliverySchemaHash:DELIVERY_SCHEMA,pactPaymentPublicKeyHash:ZERO_HASH,deliveryDeadline:'2000',settlementDeadline:'3000'};
  const ur={schemaVersion:1,contextHash:contextHash(intent),purchaseEvidenceCommitment:intent.purchaseEvidenceCommitment,policyHash:intent.policyHash,reviewer:reviewer.address,modelId:'LOCAL_SIGNED_TEST_DOUBLE',questionConfigHash:h(4),decision:'PASS',expiresAt:'1800'},receipt={...ur,signature:await reviewer.signTypedData(receiptTypedData(ur,domain))};
  const grant=await compileGrant({policy,intent,quote,receipt,deployment,authenticatedOwner:buyer.address,executor:deployment.executor,nonce:'0',deadline:'1700',now:1000n});
  const payload=AuthorizationPayloadSchema.parse({schemaVersion:1,kind:'authorization',policy,evidence,intent,quote,receipt,grant,ownerSignature:await buyer.signTypedData(grantTypedData(grant)),preparationHash:preparationHash(contextHash(intent),intent.committeeHash)});
  const snapshot=(state:OrderState):OrderSnapshot=>{
    const empty=state==='UNREGISTERED',allocated=state.startsWith('ALLOCATED_');
    return {chainId:deployment.chainId,arbiter:deployment.arbiter as Address,asset:deployment.asset as Address,orderId:payload.intent.orderId as Hex,contextHash:empty?ZERO_HASH:contextHash(payload.intent),buyer:empty?a(0):buyer.address,seller:empty?a(0):seller.address,payee:empty?a(0):seller.address,price:empty?'0':'10',bond:empty||options.singleReportBackground?'0':'5',deliveryDeadline:empty?'0':'2000',settlementDeadline:empty?'0':'3000',datasetHash:empty?ZERO_HASH:policy.datasetHash as Hex,serviceTermsHash:empty?ZERO_HASH:quote.serviceTermsHash,evidenceHash:empty||state==='FUNDED'?ZERO_HASH:h(10),voteMask:empty||state==='FUNDED'?0:3,state,credits:{buyer:allocated&&!options.singleReportBackground?'5':'0',payee:allocated?'10':'0'},withdrawn:{buyer:'0',payee:'0'},accounting:{locked:empty||allocated?'0':options.singleReportBackground?'10':'15',outstanding:allocated?(options.singleReportBackground?'10':'15'):'0',balance:empty?'0':options.singleReportBackground?'10':'15'},block:{number:'100',hash:h(11),timestamp:'4000'}};
  };
  return {payload,deployment,buyer,seller,reviewer,dataset,snapshot};
}
