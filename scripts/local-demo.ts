import {verifyDeploymentCreation} from '../packages/protocol/src/deployment-proof.js';
import {deploymentProofPort} from '../packages/protocol/src/deployment-proof-port.js';
import {AllocationReader} from '../packages/capsule/src/allocation-read.js';
import {prepareVote} from '../packages/protocol/src/vote.js';
import {WithdrawalReader} from '../packages/capsule/src/withdrawal-read.js';
import {WithdrawalStore} from '../packages/storage/src/withdrawal-store.js';
import {WithdrawalReconcileRequestSchema} from '../packages/protocol/src/withdrawal.js';
import {voteRecord,type VoteRecord} from '../packages/protocol/src/vote-api.js';
import {VoteStore} from '../packages/storage/src/vote-store.js';
import {VoteReader} from '../packages/capsule/src/vote-read.js';
import {AcceptanceStore} from '../packages/storage/src/acceptance-store.js';
import {acceptanceRecord,verifyAcceptanceSignature,type AcceptanceRecord} from '../packages/protocol/src/acceptance-api.js';
import {DeliveryReader} from '../packages/capsule/src/delivery-read.js';
import {prepareDelivery,prepareAcceptance} from '../packages/protocol/src/fulfillment.js';
import {FundingStore} from '../packages/storage/src/funding-store.js';
import {FundingWorker} from '../apps/worker/src/funding.js';
import {viemFundingPort} from '../apps/worker/src/funding-port.js';
import type {RecoveryDeployment} from '../packages/capsule/src/recovery.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
import {nativeFoundryBinary} from './foundry-runtime.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
/** Local EVM end-to-end proof only. Never uses a real CVA, JEV, wallet or Monad RPC. */
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,keccak256,toHex,hashTypedData,decodeFunctionData,type Address,type Hex} from 'viem';
import {foundry} from 'viem/chains';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {contextHash,intentMessage,policyHash,quoteTypedData,receiptTypedData,grantTypedData,termsHash} from '../packages/protocol/src/index.js';
import {committeeHash,compileGrant,preparationHash,deliveryHash,acceptanceTypedData,ALLOCATION_POLICY,RELEASE_POLICY,DELIVERY_SCHEMA,ZERO_HASH} from '../packages/protocol/src/escrow.js';
import {EscrowReader} from '../packages/protocol/src/escrow-read.js';
import {PurchasePreflightReader} from '../packages/protocol/src/purchase-preflight.js';
import {SettlementStore} from '../packages/storage/src/settlement-store.js';
import {SettlementWorker} from '../apps/worker/src/settlement.js';
import {viemSettlementPort} from '../apps/worker/src/viem-port.js';
import {createReport,reportHash,verifyReport} from '../packages/protocol/src/report.js';
const monadNative=process.argv[2]==='--monad-local';
if(process.argv[2]!=='--local'&&!monadNative)throw new Error('Requires explicit --local or --monad-local: TEST_DOUBLE only');
const port=45000+Math.floor(Math.random()*10000),url=`http://127.0.0.1:${port}`;
const processHandle=spawn(monadNative?nativeFoundryBinary('anvil'):'anvil',['--host','127.0.0.1','--port',String(port),'--silent',...(monadNative?['--network','monad','--chain-id','31337']:[])],{stdio:'ignore'});
const exited=once(processHandle,'exit');
const dataDir=mkdtempSync(join(tmpdir(),'intentpass-local-demo-')),databasePath=join(dataDir,'settlements.db');
let store:SettlementStore|undefined,fundingStore:FundingStore|undefined,acceptanceStore:AcceptanceStore|undefined,voteStore:VoteStore|undefined,withdrawalStore:WithdrawalStore|undefined;
try {
  const rpc=createPublicClient({chain:foundry,transport:http(url,{retryCount:0}),pollingInterval:10});
  let ready=false;for(let i=0;i<100;i++){try{await rpc.getChainId();ready=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}
  if(!ready) throw new Error('LOCAL_NODE_UNAVAILABLE');
  const accounts=Array.from({length:7},()=>privateKeyToAccount(generatePrivateKey()));
  const [operator,buyer,seller,reviewer,...members]=accounts;
  for(const account of accounts) await rpc.request({method:'anvil_setBalance' as never,params:[account.address,toHex(10n**20n)] as never});
  const wallet=(account:typeof buyer)=>createWalletClient({account,chain:foundry,transport:http(url)});
  const transactions: {step:string;hash:Hex;block:string;status?:string}[]=[];
  async function confirmed(step:string,hash:Hex){const r=await rpc.waitForTransactionReceipt({hash});assert.equal(r.status,'success',step);transactions.push({step,hash,block:String(r.blockNumber),status:r.status});return r;}
  const artifact=(name:string,file:string=name)=>JSON.parse(readFileSync(`contracts/out/${file}.sol/${name}.json`,'utf8'));
  async function deploy(name:string,file:string,args:unknown[]=[]){const c=artifact(name,file);const r=await confirmed(`deploy:${name}`,await wallet(operator).deployContract({abi:c.abi,bytecode:c.bytecode.object,args}));assert.ok(r.contractAddress);return {address:r.contractAddress,abi:c.abi};}
  const token=await deploy('TestAsset','TestDoubles'),gate=await deploy('TestEligibility','TestDoubles');
  const escrow=await deploy('ContextVoteEscrow','ContextVoteEscrow',[token.address,gate.address,reviewer.address,members.map(m=>m.address)]);
  const creationHash=transactions.find(t=>t.step==='deploy:ContextVoteEscrow')!.hash;
  const deploymentProof=await verifyDeploymentCreation({chainId:'31337',deployer:operator.address,asset:token.address,gate:gate.address,reviewer:reviewer.address,committee:members.map(m=>m.address)},artifact('ContextVoteEscrow'),creationHash,deploymentProofPort(rpc,'latest'),{local:true});assert.equal(deploymentProof.status,'CONFIRMED');
  mkdirSync('artifacts/acceptance',{recursive:true});writeFileSync('artifacts/acceptance/local-deployment-proof.json',JSON.stringify(deploymentProof,null,2)+'\n');
  const read=(c:typeof escrow,functionName:string,args:unknown[]=[])=>rpc.readContract({...c,functionName,args});
  const send=async(account:typeof buyer,c:typeof escrow,functionName:string,args:unknown[]=[])=>confirmed(functionName,await wallet(account).writeContract({...c,functionName,args}));
  await send(operator,token,'mint',[buyer.address,1000n]);await send(buyer,token,'approve',[escrow.address,15n]);
  const dataset=[3,5,-2,9],report=createReport(dataset);assert.ok(verifyReport(dataset,report));
  const now=(await rpc.getBlock()).timestamp,deliveryDeadline=String(now+1000n),settlementDeadline=String(now+2000n),expiresAt=String(now+500n);
  const hash=(v:string)=>keccak256(toHex(v));
  const domain={chainId:'31337',arbiter:escrow.address};
  const deployment={...domain,reviewer:reviewer.address,committee:members.map(m=>m.address)};
  const policy={schemaVersion:1,taskId:hash('LOCAL_TASK'),datasetHash:report.datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'15',allowedAsset:token.address,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
  const q={schemaVersion:1,quoteId:hash('LOCAL_QUOTE'),service:'dataset-report',seller:seller.address,payee:seller.address,asset:token.address,amount:'10',serviceTerms:'LOCAL TEST: Commercial use permitted.',serviceTermsHash:termsHash('LOCAL TEST: Commercial use permitted.'),expiresAt};
  const purchaseEvidence={schemaVersion:1,taskText:'LOCAL TEST: Purchase a licensed commercial report.',documents:[{id:'license',subjectQuoteId:q.quoteId,text:q.serviceTerms}]};
  const e={schemaVersion:1,...domain,orderId:hash('LOCAL_ORDER'),taskId:policy.taskId,attempt:'1',buyer:buyer.address,seller:seller.address,payee:seller.address,asset:token.address,price:'10',bond:'5',datasetHash:report.datasetHash,serviceTermsHash:q.serviceTermsHash,purchaseEvidenceCommitment:purchaseEvidenceHash(purchaseEvidence),policyHash:policyHash(policy),reviewer:reviewer.address,committeeHash:committeeHash(deployment.committee),threshold:2,deliverySchemaHash:DELIVERY_SCHEMA,deliveryDeadline,settlementDeadline,allocationPolicyHash:ALLOCATION_POLICY,intentReleasePolicyHash:RELEASE_POLICY,pactPaymentPublicKeyHash:ZERO_HASH};
  const r={schemaVersion:1,contextHash:contextHash(e),purchaseEvidenceCommitment:e.purchaseEvidenceCommitment,policyHash:e.policyHash,reviewer:reviewer.address,modelId:'LOCAL_TEST_ONLY_NOT_JEV',questionConfigHash:hash('LOCAL_QUESTIONS'),decision:'PASS',expiresAt};
  const quoteSignature=await seller.signTypedData(quoteTypedData(q,domain)),reviewSignature=await reviewer.signTypedData(receiptTypedData(r,domain));
  const g=await compileGrant({policy,intent:e,receipt:{...r,signature:reviewSignature},quote:{...q,signature:quoteSignature},authenticatedOwner:buyer.address,deployment,executor:operator.address,nonce:'0',deadline:expiresAt,now});
  const ownerSignature=await buyer.signTypedData(grantTypedData(g));
  const fundingDeployment={...deployment,committee:deployment.committee as [Address,Address,Address],asset:token.address,executor:operator.address} satisfies RecoveryDeployment;
  const firstPayload={schemaVersion:1,kind:'authorization',policy,evidence:purchaseEvidence,intent:e,receipt:{...r,signature:reviewSignature},quote:{...q,signature:quoteSignature},grant:g,ownerSignature,preparationHash:preparationHash(contextHash(e),e.committeeHash)};
  const reader=new EscrowReader(rpc,{...domain,asset:token.address,gate:gate.address,reviewer:reviewer.address,committeeHash:e.committeeHash},'latest');
  const fulfillmentRead=async(id:string)=>({snapshot:await reader.read(id),finality:'latest'});
  const fulfillmentProofs:unknown[]=[];
  const preflightReader=new PurchasePreflightReader(rpc,{...domain,asset:token.address,gate:gate.address,reviewer:reviewer.address,committeeHash:e.committeeHash},operator.address,'latest');
  const beforeFunding=await preflightReader.read({intent:e,grant:g});assert.deepEqual(beforeFunding.blockers,[]);assert.equal(beforeFunding.canSubmitPayment,false);
  assert.equal(await read(escrow,'preparationHash',[contextHash(e)]),preparationHash(contextHash(e),e.committeeHash));
  const rSol={...r,schemaVersion:1n,expiresAt:BigInt(expiresAt),modelIdHash:hash(r.modelId),decisionHash:hash(r.decision)};
  const qSol={...q,schemaVersion:1n,amount:10n,expiresAt:BigInt(expiresAt),serviceHash:hash(q.service)};
  const args=[intentMessage(e),rSol,reviewSignature,grantTypedData(g).message,ownerSignature,qSol,quoteSignature];
  // Two actual queued transactions consume one grant; one must revert on the same nonce/order.
  const txNonce=await rpc.getTransactionCount({address:operator.address});
  const race=await Promise.all([0,1].map(i=>wallet(operator).writeContract({...escrow,functionName:'submit',args,nonce:txNonce+i,gas:2000000n})));
  await confirmed('submit',race[0]);
  const rejected=await rpc.waitForTransactionReceipt({hash:race[1]});assert.equal(rejected.status,'reverted');
  transactions.push({step:'submit:concurrent-replay-rejected',hash:race[1],block:String(rejected.blockNumber),status:rejected.status});
  assert.equal(await read(token,'balanceOf',[buyer.address]),985n);assert.equal(await read(escrow,'consumed',[buyer.address,0n]),true);
  const afterFunding=await preflightReader.read({intent:e,grant:g});
  assert.equal(afterFunding.state,'FUNDED');assert.equal(afterFunding.consumed,true);assert.equal(afterFunding.allowance,'0');
  assert.ok(afterFunding.blockers.includes('ORDER_ALREADY_REGISTERED'));assert.ok(afterFunding.blockers.includes('NONCE_CONSUMED'));
  await assert.rejects(()=>rpc.simulateContract({...escrow,account:operator.address,functionName:'submit',args}));
  const d={schemaVersion:1,orderId:e.orderId,datasetHash:report.datasetHash,reportHash:reportHash(report),serviceTermsHash:e.serviceTermsHash};
  const deliveryPrepared=await prepareDelivery({payload:firstPayload,dataset},[seller.address],fundingDeployment,fulfillmentRead,()=>BigInt(Math.floor(Date.now()/1000)),true);
  assert.deepEqual(deliveryPrepared.delivery,d);fulfillmentProofs.push(deliveryPrepared);
  const deliveryTransaction=await send(seller,escrow,'deliver',[{...deliveryPrepared.delivery,schemaVersion:1n}]);
  const finalizedOrderReader=new EscrowReader(rpc,reader.deployment);
  const deliveryProofReader=new DeliveryReader(rpc,fundingDeployment,finalizedOrderReader),deliveryProofRequest={payload:firstPayload,dataset,hash:deliveryTransaction.transactionHash};
  const deliveryBeforeFinality=await deliveryProofReader.read(deliveryProofRequest,[seller.address]);
  // This local executor delays its finalized tag. Advance local blocks, never relax the reader.
  if(deliveryBeforeFinality.status==='PENDING')for(let i=0;i<65;i++)await rpc.request({method:'evm_mine' as never,params:[] as never});
  const deliveryProof=await deliveryProofReader.read(deliveryProofRequest,[seller.address]);assert.equal(deliveryProof.status,'CONFIRMED');
  const evidence=deliveryHash(d),vote=acceptanceTypedData({orderId:e.orderId,contextHash:contextHash(e),evidenceHash:evidence,committeeHash:e.committeeHash,expiresAt:settlementDeadline},domain);
  assert.equal(await read(escrow,'voteDigest',[e.orderId,evidence,BigInt(settlementDeadline)]),hashTypedData(vote));
  await assert.rejects(()=>rpc.simulateContract({...escrow,account:operator.address,functionName:'settle',args:[e.orderId]}));
  const voteRequests:unknown[]=[],acceptanceDatabase=join(dataDir,'acceptance.db'),acceptanceRecords:AcceptanceRecord[]=[];acceptanceStore=new AcceptanceStore(acceptanceDatabase);
  const voteDatabase=join(dataDir,'votes.db'),voteReservations:VoteRecord[]=[],voteRecords:VoteRecord[]=[];voteStore=new VoteStore(voteDatabase);
  for(let i=0;i<2;i++){
    const prepared=await prepareAcceptance({payload:firstPayload,dataset,report,memberIndex:i,expiresAt:settlementDeadline},[members[i].address],fundingDeployment,fulfillmentRead,()=>BigInt(Math.floor(Date.now()/1000)),true);
    assert.equal(prepared.voteDigest,hashTypedData(vote));fulfillmentProofs.push(prepared);
    const request={payload:firstPayload,dataset,report,memberIndex:i,expiresAt:settlementDeadline},record=acceptanceRecord(request,deployment.committee),subject=`local-member-${i}`;
    assert.equal(record.voteDigest,prepared.voteDigest);assert.equal(acceptanceStore!.reserve(subject,record).created,true);
    const signature=await members[i].signTypedData(vote),signed=await verifyAcceptanceSignature({...request,signature},deployment.committee);
    acceptanceStore!.signed(subject,signed);acceptanceStore!.close();acceptanceStore=new AcceptanceStore(acceptanceDatabase);
    assert.equal(acceptanceStore.reserve(subject,record).created,false);assert.equal(acceptanceStore.get(subject,record)?.signatureHash,signed.signatureHash);acceptanceRecords.push(signed);
    const preparedVote=await prepareVote({...request,signature},[members[i].address],fundingDeployment,fulfillmentRead,()=>BigInt(Math.floor(Date.now()/1000)),true);
    assert.equal(preparedVote.record.signatureHash,signed.signatureHash);
    const reservation=await voteRecord({...request,signature},deployment.committee);assert.equal(voteStore.reserve(subject,reservation).created,true);voteReservations.push(reservation);
    const voteTx=await confirmed('accept',await wallet(members[i]).sendTransaction({to:escrow.address,data:preparedVote.data,value:0n}));
    voteRequests.push({...request,signature,hash:voteTx.transactionHash});
    // An original send may have succeeded without a usable response. Restarting
    // the journal must never grant another send while its hash is still unknown.
    voteStore.close();voteStore=new VoteStore(voteDatabase);const resumed=voteStore.reserve(subject,reservation);assert.equal(resumed.created,false);assert.equal(resumed.record.status,'RESERVED');assert.equal(resumed.record.hash,null);
  }
  assert.equal((await reader.read(e.orderId)).state,'CERTIFIED');
  const voteReader=new VoteReader(rpc,fundingDeployment,finalizedOrderReader),voteBeforeFinality=await voteReader.read(voteRequests[1],[members[1].address]);
  if(voteBeforeFinality.status==='PENDING')for(let i=0;i<65;i++)await rpc.request({method:'evm_mine' as never,params:[] as never});
  const voteProofs=await Promise.all(voteRequests.map((request,i)=>voteReader.read(request,[members[i].address])));
  assert.ok(voteProofs.every(proof=>proof.status==='CONFIRMED'&&proof.quorumReached));assert.ok(voteProofs[0].status==='CONFIRMED'&&!voteProofs[0].certifiedInReceipt);assert.ok(voteProofs[1].status==='CONFIRMED'&&voteProofs[1].certifiedInReceipt);
  for(let i=0;i<2;i++){const proof=voteProofs[i];assert.equal(proof.status,'CONFIRMED');if(proof.status!=='CONFIRMED')throw new Error('LOCAL_VOTE_PROOF_REQUIRED');const subject=`local-member-${i}`,reservation=voteReservations[i];voteStore.resolve(subject,{...reservation,status:'CONFIRMED',hash:proof.hash});voteStore.close();voteStore=new VoteStore(voteDatabase);const resumed=voteStore.reserve(subject,reservation);assert.equal(resumed.created,false);assert.equal(resumed.record.status,'CONFIRMED');assert.equal(resumed.record.hash,proof.hash);voteRecords.push(resumed.record);}
  await assert.rejects(()=>new EscrowReader(rpc,{...reader.deployment,chainId:'1'},'latest').read(e.orderId),/CHAIN_MISMATCH/);
  await assert.rejects(()=>new EscrowReader(rpc,{...reader.deployment,asset:gate.address},'latest').read(e.orderId),/DEPLOYMENT_MISMATCH/);
  const tracked=(intent:typeof e)=>({chainId:intent.chainId,arbiter:intent.arbiter,orderId:intent.orderId,contextHash:contextHash(intent),buyer:intent.buyer,seller:intent.seller,payee:intent.payee});
  store=new SettlementStore(databasePath);const key=store.register(tracked(e)).key;
  const allocationReader=new AllocationReader(rpc,fundingDeployment,finalizedOrderReader),allocationTransactions:{orderId:string;action:'settle'|'timeout';hash:Hex}[]=[],allocationPrepared=await allocationReader.prepare({payload:firstPayload},[buyer.address]);assert.equal(allocationPrepared.action,'settle');assert.deepEqual(allocationPrepared.blockers,[]);assert.deepEqual([allocationPrepared.buyerAmount,allocationPrepared.payeeAmount],['5','10']);
  const settlementPort=viemSettlementPort(reader,{address:operator.address,send:async tx=>{
    assert.equal(tx.from,operator.address);assert.equal(tx.to,escrow.address);assert.equal(tx.value,'0');
    const decoded=decodeFunctionData({abi:escrow.abi,data:tx.data});assert.ok(decoded.functionName==='settle'||decoded.functionName==='timeout');const txHash=await wallet(operator).sendTransaction({to:tx.to,data:tx.data,value:0n});await confirmed('worker:settle-or-timeout',txHash);allocationTransactions.push({orderId:String(decoded.args?.[0]),action:decoded.functionName as 'settle'|'timeout',hash:txHash});return txHash;
  }});
  let worker=new SettlementWorker(store,settlementPort);
  assert.equal((await worker.runOnce(key)).status,'SUBMITTED');
  store.close();store=undefined;store=new SettlementStore(databasePath);worker=new SettlementWorker(store,settlementPort);
  assert.equal((await worker.runOnce(key)).status,'CONFIRMED');assert.equal((await worker.runOnce(key)).status,'CONFIRMED');
  assert.equal(transactions.filter(t=>t.step==='worker:settle-or-timeout').length,1);
  assert.equal(await read(escrow,'credits',[e.orderId,buyer.address]),5n);assert.equal(await read(escrow,'credits',[e.orderId,seller.address]),10n);
  const withdrawalReader=new WithdrawalReader(rpc,fundingDeployment,reader,true),withdrawalProofReader=new WithdrawalReader(rpc,fundingDeployment,finalizedOrderReader),withdrawalPayloads=new Map<string,unknown>([[e.orderId,firstPayload]]),withdrawalRequests:unknown[]=[],withdrawalPreparations:unknown[]=[];
  const withdrawalDatabase=join(dataDir,'withdrawals.db'),withdrawalAttempts:{input:unknown;attempt:string;subject:string;hash:Hex}[]=[],withdrawalRecords:unknown[]=[];withdrawalStore=new WithdrawalStore(withdrawalDatabase);const withdrawalSubject=(actor:string)=>`local-withdrawal-${actor.toLowerCase()}`;
  // Advance only local test blocks. Reservations always use a true finalized
  // snapshot; gate changes after reservation exercise the real on-chain guard.
  for(let i=0;i<65;i++)await rpc.request({method:'evm_mine' as never,params:[] as never});const buyerWithdrawal={payload:firstPayload,beneficiary:buyer.address},firstWithdrawalPrepared=await withdrawalProofReader.prepare(buyerWithdrawal,[buyer.address]);assert.equal(withdrawalStore.reserve(withdrawalSubject(buyer.address),buyerWithdrawal,firstWithdrawalPrepared).created,true);
  await send(operator,gate,'deny',[buyer.address,true]);const identityBlockedWithdrawal=await withdrawalReader.prepare(buyerWithdrawal,[buyer.address]);assert.deepEqual(identityBlockedWithdrawal.blockers,['IDENTITY_BLOCKED']);assert.equal(identityBlockedWithdrawal.amount,'5');
  const failedWithdrawalHash=await wallet(buyer).sendTransaction({to:escrow.address,data:identityBlockedWithdrawal.data,value:0n,gas:300000n}),failedWithdrawalReceipt=await rpc.waitForTransactionReceipt({hash:failedWithdrawalHash});assert.equal(failedWithdrawalReceipt.status,'reverted');transactions.push({step:'withdraw:identity-reverted',hash:failedWithdrawalHash,block:String(failedWithdrawalReceipt.blockNumber),status:failedWithdrawalReceipt.status});withdrawalRequests.push({...buyerWithdrawal,hash:failedWithdrawalHash});
  const afterFailedWithdrawal=await reader.read(e.orderId);assert.equal(afterFailedWithdrawal.credits.buyer,'5');assert.equal(afterFailedWithdrawal.withdrawn.buyer,'0');assert.equal(await read(token,'balanceOf',[buyer.address]),985n);withdrawalStore.close();withdrawalStore=new WithdrawalStore(withdrawalDatabase);assert.equal(withdrawalStore.reserve(withdrawalSubject(buyer.address),buyerWithdrawal).created,false);assert.throws(()=>withdrawalStore!.reserve(withdrawalSubject(buyer.address),buyerWithdrawal,firstWithdrawalPrepared,failedWithdrawalHash),/RETRY_NOT_ALLOWED/);
  for(let i=0;i<65;i++)await rpc.request({method:'evm_mine' as never,params:[] as never});const failedWithdrawalProof=await withdrawalProofReader.read({...buyerWithdrawal,hash:failedWithdrawalHash},[buyer.address]);assert.equal(failedWithdrawalProof.status,'REVERTED');withdrawalStore.resolve(withdrawalSubject(buyer.address),buyerWithdrawal,'1',failedWithdrawalHash,failedWithdrawalProof);assert.equal(withdrawalStore.reserve(withdrawalSubject(buyer.address),buyerWithdrawal).created,false);await send(operator,gate,'deny',[buyer.address,false]);for(let i=0;i<65;i++)await rpc.request({method:'evm_mine' as never,params:[] as never});
  async function originalWithdrawal(account:typeof buyer,orderId:string){for(let i=0;i<65;i++)await rpc.request({method:'evm_mine' as never,params:[] as never});const input={payload:withdrawalPayloads.get(orderId),beneficiary:account.address},prepared=await withdrawalProofReader.prepare(input,[account.address]);assert.deepEqual(prepared.blockers,[]);assert.ok(BigInt(prepared.amount)>0n);withdrawalPreparations.push(prepared);const subject=withdrawalSubject(account.address),old=withdrawalStore!.get(subject,input),retryOf=old?.status==='REVERTED'?old.hash!:undefined;if(retryOf){const proof=await withdrawalProofReader.read({...input,hash:retryOf},[account.address]);assert.equal(proof.status,'REVERTED');}const reserved=withdrawalStore!.reserve(subject,input,prepared,retryOf);assert.equal(reserved.created,true);const tx=await confirmed('withdraw',await wallet(account).sendTransaction({to:escrow.address,data:prepared.data,value:0n}));withdrawalRequests.push({...input,hash:tx.transactionHash});withdrawalAttempts.push({input,attempt:reserved.record.attempt,subject,hash:tx.transactionHash});withdrawalStore!.close();withdrawalStore=new WithdrawalStore(withdrawalDatabase);assert.equal(withdrawalStore.reserve(subject,input,undefined,retryOf).created,false);}
  await originalWithdrawal(buyer,e.orderId);await originalWithdrawal(seller,e.orderId);
  assert.equal(await read(token,'balanceOf',[buyer.address]),990n);assert.equal(await read(token,'balanceOf',[seller.address]),10n);
  assert.equal(await read(token,'balanceOf',[escrow.address]),0n);assert.equal(await read(escrow,'locked'),0n);assert.equal(await read(escrow,'outstanding'),0n);
  const firstFinal=await reader.read(e.orderId);assert.equal(firstFinal.withdrawn.payee,'10');assert.equal(firstFinal.accounting.outstanding,'0');

  const fundingDatabasePath=join(dataDir,'funding.db');fundingStore=new FundingStore(fundingDatabasePath);
  let fundingSends=0;
  const fundingPort=viemFundingPort(reader,preflightReader,{address:operator.address,send:async tx=>{fundingSends++;assert.equal(tx.from,operator.address);assert.equal(tx.to,escrow.address);assert.equal(tx.value,'0');const txHash=await wallet(operator).sendTransaction({to:tx.to,data:tx.data,value:0n});await confirmed('worker:fund-original',txHash);return txHash;}});
  const fundingProofs:unknown[]=[];
  async function fundAnother(name:string,nonce:string) {
    const next={...e,orderId:hash(name)};
    const nextR={...r,contextHash:contextHash(next)};
    const rs=await reviewer.signTypedData(receiptTypedData(nextR,domain));
    const grant=await compileGrant({policy,intent:next,receipt:{...nextR,signature:rs},quote:{...q,signature:quoteSignature},authenticatedOwner:buyer.address,deployment,executor:operator.address,nonce,deadline:expiresAt,now:(await rpc.getBlock()).timestamp});
    await send(buyer,token,'approve',[escrow.address,15n]);
    const payload={schemaVersion:1,kind:'authorization',policy,evidence:purchaseEvidence,intent:next,receipt:{...nextR,signature:rs},quote:{...q,signature:quoteSignature},grant,ownerSignature:await buyer.signTypedData(grantTypedData(grant)),preparationHash:preparationHash(contextHash(next),next.committeeHash)};
    withdrawalPayloads.set(next.orderId,payload);
    const useLostResponse=nonce==='2',selectedPort=useLostResponse?{...fundingPort,send:async(p:Parameters<typeof fundingPort.send>[0],id:string)=>{await fundingPort.send(p,id);throw new Error('LOCAL TEST: funding response lost after transaction');}}:fundingPort;
    let fundingWorker=new FundingWorker(fundingStore!,selectedPort,fundingDeployment,Date.now,true);const submitted=await fundingWorker.submit(payload,[buyer.address]);assert.equal(submitted.record.status,useLostResponse?'UNKNOWN':'SUBMITTED');
    fundingStore!.close();fundingStore=new FundingStore(fundingDatabasePath);fundingWorker=new FundingWorker(fundingStore,selectedPort,fundingDeployment,Date.now,true);
    let reconciled=await fundingWorker.reconcile(payload,[buyer.address]);assert.equal(reconciled.record.status,useLostResponse?'RECONCILED':'CONFIRMED');
    if(useLostResponse){assert.equal(reconciled.record.hash,null);const txHash=transactions.filter(t=>t.step==='worker:fund-original').at(-1)!.hash;reconciled=await fundingWorker.reconcile(payload,[buyer.address],txHash);assert.equal(reconciled.record.status,'CONFIRMED');}
    const proofHash=reconciled.record.hash as Hex,[proofReceipt,proofTransaction]=await Promise.all([rpc.getTransactionReceipt({hash:proofHash}),rpc.getTransaction({hash:proofHash})]);
    fundingProofs.push({orderId:next.orderId,initial:submitted.record,confirmed:reconciled.record,scope:'LOCAL_TEMPORARY_KEYS_NOT_PRIVY',transaction:{hash:proofHash,from:proofTransaction.from,to:proofTransaction.to,chainId:proofTransaction.chainId,value:String(proofTransaction.value),calldataHash:keccak256(proofTransaction.input)},receipt:{status:proofReceipt.status,blockNumber:String(proofReceipt.blockNumber),blockHash:proofReceipt.blockHash,logs:proofReceipt.logs.map(log=>({address:log.address,data:log.data,topics:log.topics,removed:log.removed}))}});
    await fundingWorker.submit(payload,[buyer.address]);
    return next;
  }
  const refundOrder=await fundAnother('LOCAL_REFUND_ORDER','1'),lostOrder=await fundAnother('LOCAL_LOST_RESPONSE_ORDER','2');
  const refundKey=store.register(tracked(refundOrder)).key,lostKey=store.register(tracked(lostOrder)).key;
  const lostDelivery={...d,orderId:lostOrder.orderId};await send(seller,escrow,'deliver',[{...lostDelivery,schemaVersion:1n}]);
  const lostEvidence=deliveryHash(lostDelivery),lostVote=acceptanceTypedData({orderId:lostOrder.orderId,contextHash:contextHash(lostOrder),evidenceHash:lostEvidence,committeeHash:e.committeeHash,expiresAt:settlementDeadline},domain);
  for(let i=1;i<3;i++)await send(operator,escrow,'accept',[lostOrder.orderId,lostEvidence,BigInt(settlementDeadline),BigInt(i),await members[i].signTypedData(lostVote)]);
  let lostSends=0;
  const lostPort={...settlementPort,send:async(action:'settle'|'timeout',id:string,key:string)=>{
    lostSends++;await settlementPort.send(action,id,key);throw new Error('LOCAL_TEST: response lost after successful broadcast');
  }};
  assert.equal((await new SettlementWorker(store,lostPort).runOnce(lostKey)).status,'UNKNOWN');
  store.close();store=undefined;store=new SettlementStore(databasePath);
  assert.equal((await new SettlementWorker(store,lostPort).runOnce(lostKey)).status,'RECONCILED');assert.equal(lostSends,1);
  await originalWithdrawal(buyer,lostOrder.orderId);await originalWithdrawal(seller,lostOrder.orderId);
  await rpc.request({method:'evm_setNextBlockTimestamp' as never,params:[Number(BigInt(settlementDeadline)+1n)] as never});
  await rpc.request({method:'evm_mine' as never,params:[] as never});
  worker=new SettlementWorker(store,settlementPort);assert.equal((await worker.runOnce(refundKey)).status,'SUBMITTED');
  assert.equal((await worker.runOnce(refundKey)).status,'CONFIRMED');await originalWithdrawal(buyer,refundOrder.orderId);
  const refundFinal=await reader.read(refundOrder.orderId),lostFinal=await reader.read(lostOrder.orderId);
  assert.equal(refundFinal.state,'ALLOCATED_REFUND');assert.equal(refundFinal.withdrawn.buyer,'15');assert.equal(lostFinal.state,'ALLOCATED_PAID');
  assert.equal(await read(token,'balanceOf',[buyer.address]),980n);assert.equal(await read(token,'balanceOf',[seller.address]),20n);assert.equal(lostFinal.accounting.balance,'0');
  const withdrawalBeforeFinality=await Promise.all(withdrawalRequests.map(input=>withdrawalProofReader.read(input,[WithdrawalReconcileRequestSchema.parse(input).beneficiary])));if(withdrawalBeforeFinality.some(p=>p.status==='PENDING'))for(let i=0;i<65;i++)await rpc.request({method:'evm_mine' as never,params:[] as never});
  const withdrawalProofs=await Promise.all(withdrawalRequests.map(input=>withdrawalProofReader.read(input,[WithdrawalReconcileRequestSchema.parse(input).beneficiary])));assert.ok(withdrawalProofs[0].status==='REVERTED'&&withdrawalProofs[0].transferredAmount==='0');assert.ok(withdrawalProofs.slice(1).every(p=>p.status==='CONFIRMED'));assert.deepEqual(withdrawalProofs.slice(1).map(p=>p.status==='CONFIRMED'?p.transferredAmount:null),['5','10','5','10','15']);
  const allocationProofs=await Promise.all(allocationTransactions.map(t=>allocationReader.read({payload:withdrawalPayloads.get(t.orderId),action:t.action,hash:t.hash},[buyer.address])));assert.equal(allocationProofs.length,3);assert.ok(allocationProofs.every(p=>p.status==='CONFIRMED'));assert.deepEqual(allocationProofs.map(p=>p.status==='CONFIRMED'?[p.buyerAmount,p.payeeAmount]:[]),[['5','10'],['5','10'],['15','0']]);
  for(let i=0;i<withdrawalAttempts.length;i++){const a=withdrawalAttempts[i];withdrawalStore.resolve(a.subject,a.input,a.attempt,a.hash,withdrawalProofs[i+1]);withdrawalStore.close();withdrawalStore=new WithdrawalStore(withdrawalDatabase);const old=withdrawalStore.get(a.subject,a.input);assert.equal(old?.status,'CONFIRMED');assert.equal(old?.hash,a.hash);assert.equal(withdrawalStore.reserve(a.subject,a.input).created,false);withdrawalRecords.push(old);}
  const originalFailure=withdrawalStore.get(withdrawalSubject(buyer.address),buyerWithdrawal,'1'),originalRetry=withdrawalStore.get(withdrawalSubject(buyer.address),buyerWithdrawal,'2');assert.equal(originalFailure?.status,'REVERTED');assert.equal(originalRetry?.status,'CONFIRMED');assert.equal(originalRetry?.retryOf,failedWithdrawalHash);withdrawalRecords.unshift(originalFailure);
  const result={scope:monadNative?'LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES_NOT_PUBLIC_MONAD_OR_CVA':'LOCAL_EVM_TEST_DOUBLES_ONLY_NOT_MONAD_OR_CVA',status:'PASS',timestamp:new Date().toISOString(),orderId:e.orderId,contextHash:contextHash(e),evidenceHash:evidence,
    firstOrderBalances:{buyerBefore:'1000',buyerAfter:'990',sellerAfter:'10',escrowAfter:'0'},finalBalances:{buyer:'980',seller:'20',escrow:'0'},
    orders:[firstFinal,refundFinal,lostFinal],allocation:{scope:'LOCAL_TEST_ASSET_GATE_TEMPORARY_KEYS_NOT_PRIVY_OR_CVI_CVA',preparation:allocationPrepared,proofs:allocationProofs},withdrawal:{scope:'LOCAL_TEST_ASSET_GATE_TEMPORARY_KEYS_NOT_PRIVY_OR_CVI_CVA',identityBlockedWithdrawal,afterFailedWithdrawal,preparations:withdrawalPreparations,records:withdrawalRecords,withdrawalBeforeFinality,proofs:withdrawalProofs},fulfillment:{scope:'LOCAL_TEST_KEYS_NOT_PRIVY_OR_PUBLIC_FINALITY',preparations:fulfillmentProofs,deliveryBeforeFinality,deliveryProof,acceptanceRecords,voteRecords,voteBeforeFinality,voteProofs},funding:{sends:fundingSends,proofs:fundingProofs},preflight:{beforeFunding,afterFunding},worker:{restart:'CONFIRMED',lostResponse:'RECONCILED',lostResponseSends:lostSends},
    checks:['original withdrawal same-block identity preparation, identity-reverted credit preservation, exact Withdrawn and token Transfer finalized proofs','fixed member vote send journal survives unknown response and restart without granting another send','fixed member accept calldata and canonical Accepted receipts separate first vote from certification','fixed acceptance reservations and verified signature digests survive restart and match actual member votes','fixed finalized-tag DeliveryReader proves actual local delivery transaction and EvidenceFrozen','shared original delivery and acceptance preparations accepted by native executor','funding worker complete original signatures, canonical submit, exact Transfer and Funded logs','funding worker restart and lost response without resend','TS/Solidity preparation and vote digests','signed inputs accepted on chain','report recomputation','two concurrent submits: one success and one reverted receipt','replay rejected','settle before quorum rejected','2/3 quorum','exact credits and withdrawals','same-block authoritative reads','deployment/chain mismatch rejected','worker restart without resend','lost broadcast response reconciled without resend','timeout refund via worker'],transactions};
  assert.equal(fundingSends,2);
  mkdirSync('artifacts/acceptance',{recursive:true});writeFileSync(`artifacts/acceptance/${monadNative?'local-monad-demo':'local-escrow-demo'}.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {
  store?.close();fundingStore?.close();acceptanceStore?.close();voteStore?.close();withdrawalStore?.close();rmSync(dataDir,{recursive:true,force:true});
  processHandle.kill('SIGTERM');await exited;
}
