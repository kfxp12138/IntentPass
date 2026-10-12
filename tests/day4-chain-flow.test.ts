import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters,encodeEventTopics,parseAbi,parseAbiParameters,keccak256,
  TransactionNotFoundError,TransactionReceiptNotFoundError,type Address,type Hex,type PublicClient} from 'viem';
import {originalAuthorizationFixture,readTestAddress as a,readTestHash as h} from './support/original-authorization.js';
import {inspectDay4ChainFlow} from '../packages/protocol/src/day4-chain-flow.js';
import {day4ChainFlowPort} from '../packages/protocol/src/day4-chain-flow-port.js';
import {Day4ChainFlowDeploymentSchema,Day4ChainFlowRequestSchema,Day4ChainFlowProofSchema,type Day4ChainFlowRequest,
  type Day4ChainTransaction,type Day4ChainReceipt,type Day4ChainFlowPort} from '../packages/protocol/src/day4-chain-flow-types.js';
import {OrderSnapshotSchema} from '../packages/protocol/src/escrow-read.js';
import {fundingCalldata} from '../packages/protocol/src/funding.js';
import {allocationCalldata} from '../packages/protocol/src/allocation.js';
import {withdrawalCalldata} from '../packages/protocol/src/withdrawal.js';
import {reportDelivery} from '../packages/protocol/src/fulfillment.js';
import {createReport} from '../packages/protocol/src/report.js';
import {AuthorizationPayloadSchema} from '../packages/capsule/src/format.js';
import {contextHash,compileGrant,preparationHash,quoteTypedData,receiptTypedData,grantTypedData} from '../packages/protocol/src/index.js';

const eventAbi=parseAbi([
  'event Funded(bytes32 indexed orderId,bytes32 contextHash,address buyer,uint256 amount)',
  'event Allocated(bytes32 indexed orderId,uint8 state,uint256 buyerCredit,uint256 payeeCredit)',
  'event Withdrawn(bytes32 indexed orderId,address indexed beneficiary,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
type Step='funding'|'allocation'|'withdrawal';
type BlockQuery={blockTag?:string;blockNumber?:bigint};
type ContractQuery={address:Address;functionName:string;args?:readonly unknown[];blockNumber:bigint};
const eq=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();

/** Every account, signature, RPC response and receipt below is an explicit local
 * synthetic double. No network, wallet, provider acceptance or official CVA is used. */
async function fixture(sameBeneficiary=false){
  const original=await originalAuthorizationFixture('10143');
  let payload=original.payload;
  if(sameBeneficiary){
    const domain={chainId:original.deployment.chainId,arbiter:original.deployment.arbiter};
    const {signature:_quoteSignature,...originalQuote}=payload.quote;
    const unsignedQuote={...originalQuote,payee:original.buyer.address};
    const quote={...unsignedQuote,signature:await original.seller.signTypedData(quoteTypedData(unsignedQuote,domain))};
    const intent={...payload.intent,payee:original.buyer.address};
    const {signature:_receiptSignature,...originalReceipt}=payload.receipt;
    const unsignedReceipt={...originalReceipt,contextHash:contextHash(intent)};
    const receipt={...unsignedReceipt,signature:await original.reviewer.signTypedData(receiptTypedData(unsignedReceipt,domain))};
    const grant=await compileGrant({policy:payload.policy,intent,quote,receipt,deployment:original.deployment,
      authenticatedOwner:original.buyer.address,executor:original.deployment.executor,nonce:'0',deadline:'1700',now:1000n});
    payload=AuthorizationPayloadSchema.parse({...payload,intent,quote,receipt,grant,
      ownerSignature:await original.buyer.signTypedData(grantTypedData(grant)),preparationHash:preparationHash(contextHash(intent),intent.committeeHash)});
  }
  const deployment=Day4ChainFlowDeploymentSchema.parse({...original.deployment,gate:a(66)});
  const fixed=structuredClone(deployment),e=payload.intent,report=createReport(original.dataset),delivery=reportDelivery(payload,original.dataset,report);
  const hashes={funding:h(101),allocation:h(102),withdrawal:h(103)};
  const request:Day4ChainFlowRequest={schemaVersion:1,payload,dataset:[...original.dataset],report,transactions:{...hashes}};
  const timestamp=(number:bigint)=>1200n+number*10n;
  let finalOrder=OrderSnapshotSchema.parse({...original.snapshot('ALLOCATED_PAID'),payee:e.payee,contextHash:payload.grant.contextHash,
    evidenceHash:delivery.evidenceHash,credits:{buyer:sameBeneficiary?'0':'5',payee:'0'},
    withdrawn:{buyer:sameBeneficiary?'15':'0',payee:sameBeneficiary?'15':'10'},
    accounting:{locked:'0',outstanding:sameBeneficiary?'0':'5',balance:sameBeneficiary?'0':'5'},
    block:{number:'30',hash:h(30),timestamp:String(timestamp(30n))}});
  const transactions={} as Record<Step,Day4ChainTransaction>,receipts={} as Record<Step,Day4ChainReceipt>;
  const height:Record<Step,bigint>={funding:10n,allocation:20n,withdrawal:30n};
  const data={funding:fundingCalldata(payload),allocation:allocationCalldata({payload},'settle'),withdrawal:withdrawalCalldata({payload,beneficiary:e.payee})};
  const amount=sameBeneficiary?15n:10n;
  for(const step of ['funding','allocation','withdrawal'] as const){
    const from=(step==='withdrawal'?e.payee:deployment.executor) as Address;
    transactions[step]={hash:hashes[step],from,to:e.arbiter as Address,input:data[step],value:0n,chainId:10143,
      blockNumber:height[step],blockHash:h(Number(height[step])),transactionIndex:0};
    receipts[step]={transactionHash:hashes[step],from,to:e.arbiter as Address,status:'success',blockNumber:height[step],blockHash:h(Number(height[step])),transactionIndex:0,logs:[]};
  }
  const log=(step:Step,address:Address,topics:readonly unknown[],data:Hex,index:number)=>{
    const exactTopics=topics.map(topic=>{assert.equal(typeof topic,'string');assert.match(String(topic),/^0x[0-9a-fA-F]{64}$/);return topic as Hex;});
    return {address,topics:exactTopics as [Hex,...Hex[]],data,logIndex:index,
      transactionIndex:receipts[step].transactionIndex,transactionHash:hashes[step],blockHash:receipts[step].blockHash,blockNumber:receipts[step].blockNumber,removed:false};
  };
  receipts.funding.logs=[
    log('funding',e.arbiter as Address,encodeEventTopics({abi:eventAbi,eventName:'Funded',args:{orderId:e.orderId as Hex}}),
      encodeAbiParameters(parseAbiParameters('bytes32,address,uint256'),[payload.grant.contextHash as Hex,e.buyer as Address,15n]),0),
    log('funding',e.asset as Address,encodeEventTopics({abi:eventAbi,eventName:'Transfer',args:{from:e.buyer as Address,to:e.arbiter as Address}}),
      encodeAbiParameters(parseAbiParameters('uint256'),[15n]),1),
  ];
  receipts.allocation.logs=[log('allocation',e.arbiter as Address,encodeEventTopics({abi:eventAbi,eventName:'Allocated',args:{orderId:e.orderId as Hex}}),
    encodeAbiParameters(parseAbiParameters('uint8,uint256,uint256'),[4,5n,10n]),0)];
  receipts.withdrawal.logs=[
    log('withdrawal',e.arbiter as Address,encodeEventTopics({abi:eventAbi,eventName:'Withdrawn',args:{orderId:e.orderId as Hex,beneficiary:e.payee as Address}}),
      encodeAbiParameters(parseAbiParameters('uint256'),[amount]),0),
    log('withdrawal',e.asset as Address,encodeEventTopics({abi:eventAbi,eventName:'Transfer',args:{from:e.arbiter as Address,to:e.payee as Address}}),
      encodeAbiParameters(parseAbiParameters('uint256'),[amount]),1),
  ];
  const wholeBlockBalances=new Map<string,bigint>();
  const setBalances=(number:bigint,buyer:bigint,payee:bigint,escrow:bigint)=>{
    for(const [owner,value] of [[e.buyer,buyer],[e.payee,payee],[e.arbiter,escrow]] as const)
      wholeBlockBalances.set(`${number}:${owner.toLowerCase()}`,value);
  };
  setBalances(9n,100n,sameBeneficiary?100n:0n,0n);
  setBalances(10n,85n,sameBeneficiary?85n:0n,15n);
  setBalances(29n,85n,sameBeneficiary?85n:0n,15n);
  setBalances(30n,sameBeneficiary?100n:85n,sameBeneficiary?100n:10n,sameBeneficiary?0n:5n);
  const calls={blocks:[] as BlockQuery[],contracts:[] as ContractQuery[],transactions:[] as Hex[],receipts:[] as Hex[]};
  const control={chainId:10143,shareResponses:false,transactionError:null as unknown,receiptError:null as unknown,
    blockHook:undefined as undefined|((query:BlockQuery,count:number)=>void),
    chainHook:undefined as undefined|(()=>void),
    contractHook:undefined as undefined|((query:ContractQuery)=>void)};
  const find=(hash:Hex)=>(['funding','allocation','withdrawal'] as const).find(step=>eq(hashes[step],hash));
  const client={
    getChainId:async()=>{control.chainHook?.();return control.chainId;},
    getBlock:async(query:BlockQuery)=>{
      calls.blocks.push({...query});control.blockHook?.(query,calls.blocks.length);
      assert.ok(query.blockTag==='finalized'||query.blockNumber!==undefined,'local double only accepts finalized or fixed block');
      const number=query.blockNumber??30n;return {number,hash:h(Number(number)),timestamp:timestamp(number)};
    },
    getTransaction:async({hash}:{hash:Hex})=>{calls.transactions.push(hash);if(control.transactionError)throw control.transactionError;
      const step=find(hash);if(!step)throw new TransactionNotFoundError({hash});return control.shareResponses?transactions[step]:structuredClone(transactions[step]);},
    getTransactionReceipt:async({hash}:{hash:Hex})=>{calls.receipts.push(hash);if(control.receiptError)throw control.receiptError;
      const step=find(hash);if(!step)throw new TransactionReceiptNotFoundError({hash});return control.shareResponses?receipts[step]:structuredClone(receipts[step]);},
    readContract:async(query:ContractQuery)=>{
      calls.contracts.push(query);control.contractHook?.(query);
      assert.equal(typeof query.blockNumber,'bigint','historical getters must use explicit blockNumber');
      if(query.functionName==='balanceOf'){
        assert.ok(eq(query.address,fixed.asset));const owner=String(query.args?.[0]);
        const result=wholeBlockBalances.get(`${query.blockNumber}:${owner.toLowerCase()}`);assert.notEqual(result,undefined,'no arbitrary asset/owner read in the local double');return result!;
      }
      assert.ok(eq(query.address,fixed.arbiter),'historical getters must target the fixed escrow');
      if(query.functionName==='asset')return fixed.asset;
      if(query.functionName==='eligibility')return fixed.gate;
      if(query.functionName==='reviewer')return fixed.reviewer;
      if(query.functionName==='committeeHash')return payload.intent.committeeHash;
      if(query.functionName==='locked')return BigInt(finalOrder.accounting.locked);
      if(query.functionName==='outstanding')return BigInt(finalOrder.accounting.outstanding);
      if(query.functionName==='orders'){
        assert.equal(query.args?.[0],e.orderId);
        return [finalOrder.contextHash,finalOrder.buyer,finalOrder.seller,finalOrder.payee,BigInt(finalOrder.price),BigInt(finalOrder.bond),
          BigInt(finalOrder.deliveryDeadline),BigInt(finalOrder.settlementDeadline),finalOrder.datasetHash,finalOrder.serviceTermsHash,finalOrder.evidenceHash,
          finalOrder.voteMask,['UNREGISTERED','FUNDED','EVIDENCE_FROZEN','CERTIFIED','ALLOCATED_PAID','ALLOCATED_REFUND','ALLOCATED_COMPENSATION'].indexOf(finalOrder.state)] as const;
      }
      if(query.functionName==='credits'||query.functionName==='withdrawn'){
        assert.equal(query.args?.[0],e.orderId);const slot=eq(String(query.args?.[1]),e.buyer)?'buyer':'payee';return BigInt(finalOrder[query.functionName][slot]);
      }
      throw Error('LOCAL_DOUBLE_UNEXPECTED_GETTER');
    },
  } as unknown as PublicClient;
  const port=day4ChainFlowPort(client,deployment);
  return {request,deployment,client,port,transactions,receipts,calls,control,setBalances,hashes,
    get finalOrder(){return finalOrder;},set finalOrder(value){finalOrder=value;},
    run:()=>inspectDay4ChainFlow(request,deployment,port)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function relocate(x:Fixture,step:Step,number:bigint,index=0){
  Object.assign(x.transactions[step],{blockNumber:number,blockHash:h(Number(number)),transactionIndex:index});
  Object.assign(x.receipts[step],{blockNumber:number,blockHash:h(Number(number)),transactionIndex:index});
  for(const log of x.receipts[step].logs)Object.assign(log,{blockNumber:number,blockHash:h(Number(number)),transactionIndex:index});
}

test('local synthetic D4 flow proves original funding, allocation and withdrawal events with recomputed report and final ledger',async()=>{
  const x=await fixture(),proof=await x.run();Day4ChainFlowProofSchema.parse(proof);
  assert.equal(proof.status,'CHAIN_FLOW_VERIFIED');assert.equal(proof.deliveryEvidenceHash,reportDelivery(x.request.payload,x.request.dataset,x.request.report).evidenceHash);
  assert.equal(proof.transactions.funding.amount,'15');assert.equal(proof.transactions.allocation.amount,'10');assert.equal(proof.transactions.withdrawal.amount,'10');
  assert.equal(proof.transactions.funding.calldataHash,keccak256(fundingCalldata(x.request.payload)));
  assert.deepEqual(proof.finalOrder.credits,{buyer:'5',payee:'0'});assert.deepEqual(proof.finalOrder.withdrawn,{buyer:'0',payee:'10'});
  assert.equal(proof.officialIntegrationVerified,false);assert.equal(proof.privyOriginVerified,false);assert.equal(proof.deploymentCreationVerified,false);
  assert.equal(proof.financialAcceptanceStatus,'BLOCKED');assert.equal(proof.canExecute,false);assert.equal(proof.signaturesRequested,0);assert.equal(proof.transactionsSent,0);
  assert.ok(Object.isFrozen(proof.finalOrder));assert.deepEqual(x.calls.transactions,Object.values(x.hashes));
});

const negativeCases:[string,(x:Fixture)=>void,string][]=[
  ['wrong public chain',x=>{x.control.chainId=31337;},'CHAIN_MISMATCH'],
  ['duplicate original transaction hashes',x=>{x.request.transactions.allocation=x.hashes.funding;},'INPUT_INVALID'],
  ['changed original owner signature',x=>{x.request.payload.ownerSignature=`0x${'00'.repeat(65)}`;},'ORIGINAL_AUTHORIZATION_INVALID'],
  ['changed signed dataset',x=>{x.request.dataset[0]=4;},'REPORT_INVALID'],
  ['changed report statistics',x=>{x.request.report.sum='999';},'REPORT_INVALID'],
  ['different canonical funding calldata',x=>{x.transactions.funding.input=fundingCalldata({...x.request.payload,ownerSignature:`0x${'00'.repeat(65)}`});},'TRANSACTION_MISMATCH'],
  ['appended transaction calldata',x=>{x.transactions.allocation.input=`${x.transactions.allocation.input}00`;},'TRANSACTION_MISMATCH'],
  ['wrong transaction hash',x=>{x.transactions.funding.hash=h(999);},'TRANSACTION_MISMATCH'],
  ['wrong receipt hash',x=>{x.receipts.funding.transactionHash=h(999);},'TRANSACTION_MISMATCH'],
  ['wrong execution wallet',x=>{x.transactions.funding.from=a(55);},'TRANSACTION_MISMATCH'],
  ['wrong receipt sender',x=>{x.receipts.withdrawal.from=a(55);},'TRANSACTION_MISMATCH'],
  ['wrong fixed target',x=>{x.transactions.allocation.to=a(55);},'TRANSACTION_MISMATCH'],
  ['wrong transaction chain',x=>{x.transactions.withdrawal.chainId=1;},'TRANSACTION_MISMATCH'],
  ['nonzero native transaction value',x=>{x.transactions.funding.value=1n;},'TRANSACTION_MISMATCH'],
  ['receipt transaction index drift',x=>{x.receipts.funding.transactionIndex=1;},'TRANSACTION_MISMATCH'],
  ['transaction and receipt block hash drift',x=>{x.transactions.funding.blockHash=h(777);},'TRANSACTION_MISMATCH'],
  ['noncanonical original receipt block',x=>{x.transactions.funding.blockHash=h(777);x.receipts.funding.blockHash=h(777);},'RECEIPT_NOT_CANONICAL'],
  ['future unfinalized transaction height',x=>{relocate(x,'withdrawal',31n);},'TRANSACTION_MISMATCH'],
  ['reversed original transaction heights',x=>{relocate(x,'allocation',9n);},'TRANSACTION_ORDER_INVALID'],
  ['same height with nonincreasing transaction index',x=>{relocate(x,'allocation',10n);},'TRANSACTION_ORDER_INVALID'],
  ['reverted transaction masquerading as paid flow',x=>{x.receipts.allocation.status='reverted';},'TRANSACTION_MISMATCH'],
  ['removed original event',x=>{x.receipts.funding.logs[0].removed=true;},'LOG_LOCATION_INVALID'],
  ['original event transaction hash drift',x=>{x.receipts.withdrawal.logs[0].transactionHash=h(777);},'LOG_LOCATION_INVALID'],
  ['original event block hash drift',x=>{x.receipts.funding.logs[1].blockHash=h(777);},'LOG_LOCATION_INVALID'],
  ['original event transaction index drift',x=>{x.receipts.withdrawal.logs[1].transactionIndex=1;},'LOG_LOCATION_INVALID'],
  ['duplicate event log indexes',x=>{x.receipts.funding.logs[1].logIndex=0;},'LOG_LOCATION_INVALID'],
  ['reversed event log indexes',x=>{x.receipts.funding.logs[0].logIndex=1;x.receipts.funding.logs[1].logIndex=0;},'LOG_LOCATION_INVALID'],
  ['negative event log index',x=>{x.receipts.withdrawal.logs[0].logIndex=-1;},'LOG_LOCATION_INVALID'],
  ['refund allocation masquerading as paid settlement',x=>{x.receipts.allocation.logs[0].data=encodeAbiParameters(parseAbiParameters('uint8,uint256,uint256'),[5,15n,0n]);},'ALLOCATION_EFFECT_UNPROVEN'],
  ['missing funding token Transfer',x=>{x.receipts.funding.logs.pop();},'FUNDING_EFFECT_UNPROVEN'],
  ['missing withdrawal token Transfer',x=>{x.receipts.withdrawal.logs.pop();},'WITHDRAWAL_EFFECT_UNPROVEN'],
  ['wrong withdrawal token transfer amount',x=>{x.receipts.withdrawal.logs[1].data=encodeAbiParameters(parseAbiParameters('uint256'),[9n]);},'WITHDRAWAL_EFFECT_UNPROVEN'],
  ['allocation incorrectly contains a token transfer',x=>{const log=structuredClone(x.receipts.funding.logs[1]);Object.assign(log,{blockNumber:20n,blockHash:h(20),transactionHash:x.hashes.allocation,logIndex:1});x.receipts.allocation.logs.push(log);},'ALLOCATION_EFFECT_UNPROVEN'],
  ['wrong recomputed delivery evidence in final order',x=>{x.finalOrder={...x.finalOrder,evidenceHash:h(999)};},'FINAL_ORDER_MISMATCH'],
  ['final ledger has outstanding payee credit',x=>{x.finalOrder={...x.finalOrder,credits:{buyer:'5',payee:'10'},withdrawn:{buyer:'0',payee:'0'},accounting:{locked:'0',outstanding:'15',balance:'15'}};x.setBalances(30n,85n,0n,15n);},'WITHDRAWAL_LEDGER_UNPROVEN'],
];
for(const [name,mutate,code] of negativeCases)test(`local synthetic D4 flow rejects ${name}`,async()=>{
  const x=await fixture();mutate(x);await assert.rejects(x.run(),candidate=>candidate instanceof Error&&candidate.message===`DAY4_FLOW_${code}`);
});

test('local synthetic D4 flow refuses noncanonical event tail bytes and extra indexed topics',async()=>{
  for(const change of [(x:Fixture)=>{x.receipts.funding.logs[0].data=`${x.receipts.funding.logs[0].data}00`;},
    (x:Fixture)=>{x.receipts.withdrawal.logs[0].topics=[...x.receipts.withdrawal.logs[0].topics,h(999)] as [Hex,...Hex[]];}]){
    const x=await fixture();change(x);await assert.rejects(x.run(),/DAY4_FLOW_EVENT_ENCODING_INVALID/);
  }
});

test('local synthetic D4 flow retains the original frozen request and deployment across asynchronous reads',async()=>{
  const x=await fixture(),originalHash=x.hashes.funding,originalOrder=x.request.payload.intent.orderId;
  x.control.chainHook=()=>{x.control.chainHook=undefined;x.request.transactions.funding=h(999);x.request.dataset[0]=999;x.deployment.asset=a(999);x.deployment.committee[0]=a(999);};
  const proof=await x.run();assert.equal(proof.transactions.funding.hash,originalHash);assert.equal(proof.orderId,originalOrder);assert.equal(proof.asset,a(88));
});

test('local synthetic D4 flow snapshots provider-owned raw response objects before later awaits',async()=>{
  const x=await fixture();x.control.shareResponses=true;
  x.control.blockHook=query=>{if(query.blockNumber===10n){x.transactions.funding.from=a(999);x.receipts.funding.from=a(999);x.receipts.funding.logs[0].data='0x';x.control.blockHook=undefined;}};
  const proof=await x.run();assert.equal(proof.transactions.funding.from.toLowerCase(),x.deployment.executor.toLowerCase());
});

test('local synthetic D4 flow rejects a canonical block changing during final recheck',async()=>{
  const x=await fixture(),original=x.port.block;let repeated=0;
  const port={...x.port,block:async(number?:bigint)=>{const block=await original(number);return number===10n&&++repeated>1?{...block,hash:h(999)}:block;}};
  await assert.rejects(inspectDay4ChainFlow(x.request,x.deployment,port),candidate=>candidate instanceof Error&&candidate.message==='DAY4_FLOW_SNAPSHOT_CHANGED');
});

test('local synthetic D4 flow proves combined buyer/payee withdrawal once without double-counting ledger',async()=>{
  const x=await fixture(true),proof=await x.run();assert.equal(proof.finalOrder.buyer,proof.finalOrder.payee);
  assert.equal(proof.transactions.withdrawal.amount,'15');assert.deepEqual(proof.finalOrder.credits,{buyer:'0',payee:'0'});
  assert.deepEqual(proof.finalOrder.withdrawn,{buyer:'15',payee:'15'});assert.equal(proof.finalOrder.accounting.outstanding,'0');
});

test('local synthetic D4 flow distinguishes whole-block balance changes from exact original receipt transfer amounts',async()=>{
  const x=await fixture();x.setBalances(9n,100n,100n,50n);x.setBalances(10n,81n,103n,70n);x.setBalances(29n,80n,20n,21n);x.setBalances(30n,85n,33n,5n);
  const proof=await x.run();assert.equal(proof.transactions.funding.amount,'15');assert.equal(proof.balanceObservations.funding.wholeBlockNetChange.buyer,'-19');
  assert.equal(proof.transactions.withdrawal.amount,'10');assert.equal(proof.balanceObservations.withdrawal.wholeBlockNetChange.payee,'13');
  assert.equal(proof.balanceObservations.withdrawal.scope,'WHOLE_BLOCK_ENDPOINT_BALANCES_NOT_TRANSACTION_LEVEL_DELTAS');assert.equal(proof.financialAcceptanceStatus,'BLOCKED');
});

test('local synthetic D4 adapter uses finalized blocks and fixed-height deployment getters with no execution interface',async()=>{
  const x=await fixture();await x.run();assert.equal(x.port.blockTag,'finalized');assert.ok(Object.isFrozen(x.port));
  assert.deepEqual(Object.keys(x.port).sort(),['balance','block','blockTag','chainId','orderAt','receipt','transaction']);
  assert.ok(x.calls.blocks.some(query=>query.blockTag==='finalized'));assert.ok(x.calls.blocks.every(query=>query.blockTag==='finalized'||typeof query.blockNumber==='bigint'));
  const historical=x.calls.contracts.filter(query=>query.functionName!=='balanceOf');assert.ok(historical.length>0);
  assert.ok(historical.every(query=>query.blockNumber===30n&&eq(query.address,x.deployment.arbiter)));
  assert.ok(['asset','eligibility','reviewer','committeeHash','orders','credits','withdrawn','locked','outstanding'].every(name=>historical.some(query=>query.functionName===name)));
  const count=x.calls.contracts.length;assert.throws(()=>x.port.balance(a(999),x.request.payload.intent.buyer as Address,30n),/DAY4_FLOW_BALANCE_QUERY_INVALID/);assert.equal(x.calls.contracts.length,count);
});

test('local synthetic D4 adapter maps only transaction and receipt not-found errors to null',async()=>{
  const x=await fixture();assert.equal(await x.port.transaction(h(999)),null);assert.equal(await x.port.receipt(h(999)),null);
  const error=Error('LOCAL_DOUBLE_READ_ERROR');x.control.transactionError=error;x.control.receiptError=error;
  await assert.rejects(x.port.transaction(x.hashes.funding),candidate=>candidate===error);await assert.rejects(x.port.receipt(x.hashes.funding),candidate=>candidate===error);
  await assert.rejects(x.run(),/DAY4_FLOW_READ_UNAVAILABLE/);
});

test('local synthetic D4 adapter keeps original historical RPC methods when the client surface is swapped during an await',async()=>{
  const x=await fixture();let substitutedCalls=0;
  x.control.chainHook=()=>{
    x.control.chainHook=undefined;
    const replaced=async()=>{substitutedCalls++;throw Error('LOCAL_DOUBLE_SUBSTITUTED_RPC_MUST_NOT_RUN');};
    Object.assign(x.client,{getChainId:replaced,getBlock:replaced,readContract:replaced});
  };
  const proof=await x.run();assert.equal(proof.status,'CHAIN_FLOW_VERIFIED');assert.equal(substitutedCalls,0);
  assert.ok(x.calls.contracts.some(query=>query.functionName==='orders'&&query.blockNumber===30n));
});

test('local synthetic D4 flow distinguishes pending original receipts from provider read failures',async()=>{
  for(const kind of ['transaction','receipt'] as const){const x=await fixture();x.control[`${kind}Error`]=kind==='transaction'?new TransactionNotFoundError({hash:x.hashes.funding}):new TransactionReceiptNotFoundError({hash:x.hashes.funding});await assert.rejects(x.run(),/DAY4_FLOW_TRANSACTION_PENDING/);}
});

test('local synthetic D4 flow rejects non-finalized port tags',async()=>{
  const x=await fixture();await assert.rejects(inspectDay4ChainFlow(x.request,x.deployment,{...x.port,blockTag:'latest'} as unknown as Day4ChainFlowPort),/DAY4_FLOW_FINALIZED_PORT_REQUIRED/);
});

test('local synthetic D4 historical adapter refuses deployment getter drift',async()=>{
  const x=await fixture();x.control.contractHook=query=>{if(query.functionName==='asset')x.finalOrder={...x.finalOrder,asset:a(999)};};
  const original=x.client.readContract.bind(x.client),client={...x.client,readContract:async(query:ContractQuery)=>query.functionName==='eligibility'?a(999):original(query as never)} as unknown as PublicClient;
  await assert.rejects(day4ChainFlowPort(client,x.deployment).orderAt(x.request.payload.intent.orderId as Hex,30n),/DEPLOYMENT_MISMATCH/);
});

test('local synthetic D4 proof schemas reject malformed quantities and inconsistent public summaries without throwing',async()=>{
  const x=await fixture(),proof=await x.run();
  for(const price of ['bad-price','-1']){
    const request=structuredClone(x.request);request.payload.intent.price=price;
    assert.doesNotThrow(()=>assert.equal(Day4ChainFlowRequestSchema.safeParse(request).success,false));
    const malformed=structuredClone(proof);malformed.finalOrder.price=price;
    assert.doesNotThrow(()=>assert.equal(Day4ChainFlowProofSchema.safeParse(malformed).success,false));
  }
  const changes=[
    (value:typeof proof)=>{value.transactions.funding.amount='-1';},
    (value:typeof proof)=>{value.balanceObservations.funding.wholeBlockNetChange.buyer='-999';},
    (value:typeof proof)=>{value.transactions.withdrawal.from=a(999);},
    (value:typeof proof)=>{value.transactions.allocation.amount='11';},
    (value:typeof proof)=>{value.transactions.withdrawal.amount='9';},
    (value:typeof proof)=>{value.balanceObservations.withdrawal.before.number='31';},
  ];
  for(const change of changes){const altered=structuredClone(proof);change(altered);assert.doesNotThrow(()=>assert.equal(Day4ChainFlowProofSchema.safeParse(altered).success,false));}
  assert.equal(Day4ChainFlowProofSchema.safeParse(proof).success,true);
});
