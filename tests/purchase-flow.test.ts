import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {ProposalService} from '../apps/web/src/services/propose.js';
import {ReviewService} from '../apps/web/src/services/review.js';
import {PurchaseFlow,type PurchasePort} from '../apps/web/src/purchase-flow.js';
import {PurchaseClient} from '../packages/protocol/src/purchase-client.js';
import {prepareAuthorization} from '../packages/capsule/src/authorization.js';
import {OrderPrepareRequestSchema} from '../packages/protocol/src/order-preparation.js';
import {BrowserSession,type BrowserAuthPort} from '../apps/web/src/browser-session.js';
import {FileQuoteCatalog} from '../apps/web/src/catalog-api.js';
import {configuredPurchaseApis} from '../apps/web/src/configured-purchase-api.js';
import {createApp} from '../apps/web/src/server.js';
import {PreflightRequestSchema} from '../packages/protocol/src/purchase-preflight.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {loadReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {questionConfigHash,type JevResult} from '../packages/adapters/src/jev-review.js';
import {quoteTypedData,receiptTypedData,grantTypedData,termsHash} from '../packages/protocol/src/typed-data.js';
import {committeeHash} from '../packages/protocol/src/escrow.js';
import {createReport} from '../packages/protocol/src/report.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as `0x${string}`;
const model='jev-1.13.0';
function judgments(choice:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'='SUPPORTED'):JevResult {
  const answer={type:'choice' as const,choice,confidence:1,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0}};
  return {model,answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:10,output_tokens:3}};
}
const authPort:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-token',logout:async()=>{}};
async function harness() {
  const buyer=privateKeyToAccount(generatePrivateKey()),seller=privateKeyToAccount(generatePrivateKey()),reviewer=privateKeyToAccount(generatePrivateKey()),members=[a(1),a(2),a(3)] as [string,string,string];
  const deployment={chainId:'31337',arbiter:a(99),asset:a(88),gate:a(87),reviewer:reviewer.address,committeeHash:committeeHash(members)},domain={chainId:deployment.chainId,arbiter:deployment.arbiter};
  const dataset=[3,7,11,19],policy={schemaVersion:1,taskId:h(1),datasetHash:createReport(dataset).datasetHash,action:'dataset-report',metrics:['count','sum','min','max'],purpose:'commercial',budget:'15',allowedAsset:deployment.asset,requiredFacts:['service-matches-task','commercial-use-permitted','evidence-belongs-to-service'],version:'1'};
  const uq={schemaVersion:1,quoteId:h(3),service:'dataset-report',seller:seller.address,payee:seller.address,asset:deployment.asset,amount:'10',serviceTerms:'Commercial report use permitted.',serviceTermsHash:termsHash('Commercial report use permitted.'),expiresAt:'3000'};
  const quote={...uq,signature:await seller.signTypedData(quoteTypedData(uq,domain))},documents=[{id:'license',subjectQuoteId:quote.quoteId,text:'Current report has commercial rights.'},{id:'limitation',subjectQuoteId:quote.quoteId,text:'All limitations must be retained for review.'}],entry={quote,documents},principal={subject:'local-test-owner',wallets:[buyer.address]};
  const configuration={privyAppId:'local-test-app',meraRpId:null,recoveryDeployment:{chainId:deployment.chainId,arbiter:deployment.arbiter,asset:deployment.asset,reviewer:reviewer.address,committee:members,executor:a(77)},purchaseRule:{model,minConfidence:.9,questionConfigHash:questionConfigHash(.9)}};
  let plannerCalls=0,jevCalls=0;
  const proposal=new ProposalService({model:'LOCAL_PLANNER_TEST_DOUBLE',select:async()=>{plannerCalls++;return {quoteId:quote.quoteId,evidenceIds:['license']};}},{get:async id=>id===quote.quoteId?entry:undefined},deployment,{bond:'5',deliverySeconds:'1000',settlementSeconds:'2000'},()=>1000n);
  const review=new ReviewService({model,evaluate:async()=>{jevCalls++;return judgments();}},deployment,.9,undefined,()=>1000n);
  const session=new BrowserSession(async()=>authPort,async url=>new Response(JSON.stringify(url==='/api/config'?configuration:principal)));
  const task={policy,taskInput:{dataset,buyer:buyer.address,seller:seller.address}};
  const port:PurchasePort={catalog:async()=>({entries:[entry]}),propose:input=>proposal.propose(input,principal),review:input=>review.review(input,principal)};
  return {task,entry,principal,configuration,session,proposal,review,port,buyer,reviewer,plannerCalls:()=>plannerCalls,jevCalls:()=>jevCalls};
}
test('authenticated HTTP SDK connects signed catalog, bounded planner and JEV review without funding capability',async()=>{
  const x=await harness(),auth={authenticate:async(token:string)=>{if(token!=='local-token')throw new AuthenticationRejected();return x.principal;}};
  const app=await createApp({dependencyPrebundling:false,browserApi:{configuration:x.configuration,auth},catalogApi:{auth,list:async()=>({entries:[x.entry]})},proposeApi:{auth,service:x.proposal},reviewApi:{auth,service:x.review}});
  try {
    await new Promise<void>((ready,reject)=>{const failed=(error:Error)=>reject(error);app.server.once('error',failed);app.server.listen(0,'127.0.0.1',()=>{app.server.off('error',failed);ready();});});
    const address=app.server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
    const session=new BrowserSession(async()=>authPort,(url,init)=>fetch(new URL(String(url),base),init)),client=new PurchaseClient(base,()=>session.token()),flow=new PurchaseFlow(()=>x.task,session,client,()=>1000n);
    assert.equal((await fetch(base+'/api/catalog')).status,401);assert.equal(x.plannerCalls(),0);
    await flow.catalog();const draft=await flow.propose([x.entry.quote.quoteId]);assert.equal(draft.status,'DRAFT');assert.deepEqual(flow.draft?.evidence.documents,x.entry.documents);
    const result=await flow.review();assert.equal(result.decision,'PASS');assert.equal(result.source,'JEV');assert.ok('executable'in result);assert.equal(result.executable,false);assert.ok(!('receipt'in result));
    await assert.rejects(flow.prepare('0','1200'),/EXECUTABLE_PASS_REQUIRED/);assert.equal(flow.authorization,undefined);
    assert.equal(x.plannerCalls(),1);assert.equal(x.jevCalls(),1);assert.equal((await(await fetch(base+'/health')).json()).ready,false);
  }finally{await app.close();}
});
test('browser rejects changed original policy, price, payee or omitted catalog evidence in a draft',async()=>{
  const x=await harness();
  for(const mutate of [
    (d:any)=>({...d,policy:{...d.policy,budget:'16'}}),
    (d:any)=>({...d,intent:{...d.intent,price:'11'}}),
    (d:any)=>({...d,intent:{...d.intent,payee:a(55)}}),
    (d:any)=>({...d,evidence:{...d.evidence,documents:[d.evidence.documents[0]]}}),
  ]) {
    const flow=new PurchaseFlow(()=>x.task,x.session,{...x.port,propose:async input=>mutate(await x.port.propose(input))},()=>1000n);await flow.catalog();await assert.rejects(flow.propose([x.entry.quote.quoteId]));assert.equal(flow.draft,undefined);
  }
  const badTask={...x.task,taskInput:{...x.task.taskInput,dataset:[0]}};const flow=new PurchaseFlow(()=>badTask,x.session,x.port,()=>1000n);await flow.catalog();const before=x.plannerCalls();await assert.rejects(flow.propose([x.entry.quote.quoteId]),/DATASET_MISMATCH/);assert.equal(x.plannerCalls(),before);assert.equal(x.jevCalls(),0);
});
test('browser reuses a frozen task salt and refuses a substituted salt even with a recomputed commitment',async()=>{
  const x=await harness(),salts:string[]=[],task={...x.task,evidence:{schemaVersion:2,salt:h(55),taskText:'Original private task',documents:[]}};let substitute=false;
  const flow=new PurchaseFlow(()=>task,x.session,{...x.port,propose:async(input:any)=>{salts.push(input.evidenceSalt);const r=await x.port.propose(input) as any;if(substitute){r.evidence.salt=h(66);r.intent.purchaseEvidenceCommitment=purchaseEvidenceHash(r.evidence);}return r;}},()=>1000n);
  await flow.catalog();await flow.propose([x.entry.quote.quoteId]);await flow.propose([x.entry.quote.quoteId]);assert.deepEqual(salts,[h(55),h(55)]);substitute=true;await assert.rejects(flow.propose([x.entry.quote.quoteId]),/DRAFT_CONTEXT_INVALID/);assert.equal(flow.draft,undefined);
  const legacy=new PurchaseFlow(()=>({...x.task,evidence:{schemaVersion:1,taskText:'Old unsigned task',documents:[]}}),x.session,x.port,()=>1000n);await legacy.catalog();const before=x.plannerCalls();await assert.rejects(legacy.propose([x.entry.quote.quoteId]),/LEGACY_TASK_RECONFIRM_REQUIRED/);assert.equal(x.plannerCalls(),before);
});
test('browser rejects inconsistent PASS, changed review rule or model, and forged executable receipt',async()=>{
  const x=await harness();
  for(const reply of [
    {...judgments('CONTRADICTED'),decision:'PASS',source:'JEV',modelId:model,questionConfigHash:questionConfigHash(.9),executable:false},
    {decision:'PASS',source:'JEV',modelId:'jev-9.9.9',questionConfigHash:questionConfigHash(.9),answers:judgments().answers,usage:judgments().usage,executable:false},
    {decision:'PASS',source:'JEV',modelId:model,questionConfigHash:h(99),answers:judgments().answers,usage:judgments().usage,executable:false},
  ]) {
    const {model:_model,...clean}=reply as any;const flow=new PurchaseFlow(()=>x.task,x.session,{...x.port,review:async()=>clean},()=>1000n);await flow.catalog();await flow.propose([x.entry.quote.quoteId]);await assert.rejects(flow.review(),/REVIEW_CONTEXT_INVALID/);assert.equal(flow.reviewResult,undefined);
  }
  const flow=new PurchaseFlow(()=>x.task,x.session,{...x.port,review:async()=>({decision:'PASS',source:'JEV',modelId:model,questionConfigHash:questionConfigHash(.9),answers:judgments().answers,usage:judgments().usage,executable:true,receipt:{schemaVersion:1,contextHash:h(9),purchaseEvidenceCommitment:h(9),policyHash:h(9),reviewer:a(9),modelId:model,questionConfigHash:questionConfigHash(.9),decision:'PASS',expiresAt:'1300',signature:'0x'+'0'.repeat(130)}})},()=>1000n);await flow.catalog();await flow.propose([x.entry.quote.quoteId]);await assert.rejects(flow.review(),/REVIEW_CONTEXT_INVALID/);
});
test('task change or candidate reset while model response is pending discards the old result',async()=>{
  const x=await harness();let current:unknown=x.task,release!:()=>void,started!:()=>void;
  let wait=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{started=r;});
  const flow=new PurchaseFlow(()=>current,x.session,{...x.port,propose:async input=>{started();await wait;return x.port.propose(input);}},()=>1000n);await flow.catalog();const pending=flow.propose([x.entry.quote.quoteId]);await reached;current={...x.task,policy:{...x.task.policy,budget:'16'}};release();await assert.rejects(pending,/CONTEXT_CHANGED/);assert.equal(flow.draft,undefined);
  current=x.task;const reviewFlow=new PurchaseFlow(()=>current,x.session,{...x.port,review:async input=>{started();await wait;return x.port.review(input);}},()=>1000n);await reviewFlow.catalog();await reviewFlow.propose([x.entry.quote.quoteId]);wait=new Promise<void>(r=>{release=r;});reached=new Promise<void>(r=>{started=r;});const reviewing=reviewFlow.review();await reached;reviewFlow.reset();release();await assert.rejects(reviewing,/CONTEXT_CHANGED/);assert.equal(reviewFlow.reviewResult,undefined);
});
test('explicit quote file validates finite catalog and does not accept relative paths or duplicate evidence',async()=>{
  const x=await harness(),dir=mkdtempSync(join(tmpdir(),'intentpass-catalog-')),path=join(dir,'quotes.json');
  try{writeFileSync(path,JSON.stringify({entries:[x.entry]}));const catalog=new FileQuoteCatalog(path);assert.deepEqual(await catalog.get(x.entry.quote.quoteId),x.entry);assert.equal(await catalog.get(h(99)),undefined);assert.throws(()=>new FileQuoteCatalog('quotes.json'));
    writeFileSync(path,JSON.stringify({entries:[{...x.entry,documents:[x.entry.documents[0],x.entry.documents[0]]}]}));assert.throws(()=>new FileQuoteCatalog(path));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('review policy loader rejects blocked or tampered results; consistent local report double is not a real evaluation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'intentpass-rule-')),reportPath=join(dir,'dev.json'),policyPath=join(dir,'policy.json'),cases=JSON.parse(readFileSync('fixtures/dev/review-cases.json','utf8')),manifest=JSON.parse(readFileSync('fixtures/review-manifest.json','utf8'));
  const report={scope:'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',status:'PASS',split:'dev',model,minConfidence:.9,questionConfigHash:questionConfigHash(.9),fixtureSha256:manifest.files[0].sha256,summary:{planned:12,attempted:12,evaluated:12,matches:12,errors:0,falsePass:0},results:cases.map((c:any)=>({id:c.id,input:c.state,expected:c.expected,actual:c.expected,error:null,matches:true,raw:judgments(c.expected==='PASS'?'SUPPORTED':c.expected==='REJECT'?'CONTRADICTED':'INSUFFICIENT')}))};
  const write=(value:unknown)=>{const raw=JSON.stringify(value);writeFileSync(reportPath,raw);writeFileSync(policyPath,JSON.stringify({version:1,model,minConfidence:.9,questionConfigHash:questionConfigHash(.9),developmentReportPath:reportPath,developmentReportSha256:createHash('sha256').update(raw).digest('hex')}));};
  try{write(report);assert.equal(loadReviewPolicy(policyPath,model).minConfidence,.9);assert.throws(()=>loadReviewPolicy(policyPath,'jev-9.9.9'));
    for(const changed of [{...report,status:'BLOCKED'},{...report,scope:'NO_REAL_MODEL_REQUESTS'},{...report,results:report.results.slice(1)},{...report,results:report.results.map((r:any,i:number)=>i===0?{...r,error:'JEV_UNAVAILABLE_OR_INVALID'}:r)}]){write(changed);assert.throws(()=>loadReviewPolicy(policyPath,model));}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('purchase configuration wires real ports only with explicit resources and leaves financial signing disabled',async()=>{
  const x=await harness(),dir=mkdtempSync(join(tmpdir(),'intentpass-purchase-')),path=join(dir,'quotes.json'),browserApi={configuration:{...x.configuration,purchaseRule:null},auth:{authenticate:async()=>x.principal}};
  try{writeFileSync(path,JSON.stringify({entries:[x.entry]}));assert.deepEqual(configuredPurchaseApis({},undefined),{});
    const apis=configuredPurchaseApis({QUOTE_CATALOG_PATH:path,ELIGIBILITY_GATE_ADDRESS:a(87),PLANNER_API_URL:'https://planner.example/v1/chat/completions',PLANNER_API_KEY:['LOCAL_CONFIG','URATION_TEST_ONLY'].join(''),PLANNER_MODEL:'model-2026-09-01',PURCHASE_BOND:'5',DELIVERY_SECONDS:'1800',SETTLEMENT_SECONDS:'3600',TYPESAFE_API_KEY:['LOCAL_CONFIG','URATION_TEST_ONLY'].join(''),JEV_MODEL:model},browserApi);
    assert.ok(apis.catalogApi);assert.ok(apis.proposeApi);assert.equal(apis.reviewApi,undefined);assert.equal(browserApi.configuration.purchaseRule,null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('purchase SDK validates response, forbids credential endpoints and never retries uncertain model requests',async()=>{
  const x=await harness();
  for(const base of ['http://remote.example',['https://','user:secret','@example.com'].join(''),'https://example.com?key=secret'])assert.throws(()=>new PurchaseClient(base,async()=>'local'));
  let requests=0;const client=new PurchaseClient('https://intentpass.example',async()=>'local',async()=>{requests++;throw new Error('unknown request outcome');});
  await assert.rejects(client.catalog());assert.equal(requests,1);
  await assert.rejects(client.propose({policy:x.task.policy,taskText:'Current task',buyer:x.task.taskInput.buyer,quoteRefs:[x.entry.quote.quoteId]}));assert.equal(requests,2);
  await assert.rejects(new PurchaseClient('https://intentpass.example',async()=>'local',async()=>new Response('x'.repeat(1500001))).catalog(),/TOO_LARGE/);
  await assert.rejects(new PurchaseClient('https://intentpass.example',async()=>'local',async()=>new Response(JSON.stringify({entries:[],privateKey:'forbidden'}))).catalog());
});

test('browser preparation invokes shared order API and rejects a substituted server Grant before presenting it',async()=>{
  const x=await harness(),d=x.configuration.recoveryDeployment;let calls=0,swap=false;
  const review=new ReviewService({model,evaluate:async()=>judgments()},{chainId:d.chainId,arbiter:d.arbiter,asset:d.asset,gate:a(87),reviewer:d.reviewer,committeeHash:committeeHash(d.committee)},.9,{address:x.reviewer.address,sign:async(r,domain)=>x.reviewer.signTypedData(receiptTypedData(r,domain))},()=>1000n);
  const flow=new PurchaseFlow(()=>x.task,x.session,{...x.port,review:input=>review.review(input,x.principal),prepareOrder:async input=>{calls++;const r=await prepareAuthorization(OrderPrepareRequestSchema.parse(input),{authenticatedWallets:x.principal.wallets,deployment:d,rule:{model,minConfidence:.9,questionConfigHash:questionConfigHash(.9)},now:1000n});return swap?{...r,payload:{...r.payload,grant:{...r.payload.grant,nonce:'999'}}}:r;}},()=>1000n);
  await flow.catalog();await flow.propose([x.entry.quote.quoteId]);await flow.review();assert.equal((await flow.prepare('0','1200')).canSubmitPayment,false);assert.equal(calls,1);
  swap=true;await assert.rejects(flow.prepare('0','1200'),/PREPARATION_MISMATCH/);assert.equal(calls,2);assert.equal(flow.authorization,undefined);
});
test('browser permission preparation preserves original candidate and discards a reset while account verification waits',async()=>{
  const x=await harness(),d=x.configuration.recoveryDeployment;
  const review=new ReviewService({model,evaluate:async()=>judgments()},{chainId:d.chainId,arbiter:d.arbiter,asset:d.asset,gate:a(87),reviewer:d.reviewer,committeeHash:committeeHash(d.committee)},.9,{address:x.reviewer.address,sign:async(receipt,domain)=>x.reviewer.signTypedData(receiptTypedData(receipt,domain))},()=>1000n);
  const flow=new PurchaseFlow(()=>x.task,x.session,{...x.port,review:input=>review.review(input,x.principal),preflight:async input=>{
    const {intent,grant}=PreflightRequestSchema.parse(input);return {chainId:grant.chainId,arbiter:grant.arbiter,asset:grant.asset,buyer:grant.owner,orderId:grant.orderId,contextHash:grant.contextHash,nonce:grant.nonce,amount:grant.amount,deadline:grant.deadline,state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:true,balance:'100',allowance:grant.amount,blockers:[],block:{number:'100',hash:h(1),timestamp:'1000',finality:'finalized'},canSubmitPayment:false};
  }},()=>1000n);
  await flow.catalog();await flow.propose([x.entry.quote.quoteId]);await flow.review();const prepared=await flow.prepare('0','1200');
  assert.equal(prepared.payload.intent.orderId,flow.draft!.intent.orderId);assert.equal(prepared.payload.grant.amount,'15');assert.equal(prepared.payload.grant.executor,d.executor);assert.equal(prepared.canSubmitPayment,false);assert.equal(prepared.chainStatusChecked,false);
  const observation=await flow.preflight();assert.ok(!('status'in observation));assert.equal(observation.nonce,'0');assert.equal(observation.canSubmitPayment,false);assert.equal(flow.preflightSnapshot?.orderId,prepared.payload.intent.orderId);
  x.task.policy.budget='16';await assert.rejects(flow.prepare('0','1200'),/PURCHASE_TASK_CHANGED/);assert.equal(flow.authorization,undefined);x.task.policy.budget='15';
  let release!:(value:typeof x.principal)=>void;
  const verified=x.session.verified.bind(x.session);
  x.session.verified=()=>new Promise(resolve=>{release=resolve;});
  const windowChanged=flow.prepare('0','1200');flow.invalidateAuthorization();release(x.principal);
  await assert.rejects(windowChanged,/PURCHASE_CONTEXT_CHANGED/);assert.equal(flow.authorization,undefined);assert.equal(flow.preflightSnapshot,undefined);assert.ok(flow.draft);assert.ok(flow.reviewResult);
  x.session.verified=verified;
  x.session.verified=()=>new Promise(resolve=>{release=resolve;});
  const pending=flow.prepare('0','1200');flow.reset();release(x.principal);
  await assert.rejects(pending,/PURCHASE_CONTEXT_CHANGED/);assert.equal(flow.authorization,undefined);
});

async function signedFlowHarness(){
  const x=await harness(),d=x.configuration.recoveryDeployment,state={blocked:false,signatures:0};
  const review=new ReviewService({model,evaluate:async()=>judgments()},{chainId:d.chainId,arbiter:d.arbiter,asset:d.asset,gate:a(87),reviewer:d.reviewer,committeeHash:committeeHash(d.committee)},.9,{address:x.reviewer.address,sign:async(receipt,domain)=>x.reviewer.signTypedData(receiptTypedData(receipt,domain))},()=>1000n);
  const port:PurchasePort={...x.port,review:input=>review.review(input,x.principal),preflight:async input=>{
    const {grant}=PreflightRequestSchema.parse(input);return {chainId:grant.chainId,arbiter:grant.arbiter,asset:grant.asset,buyer:grant.owner,orderId:grant.orderId,contextHash:grant.contextHash,nonce:grant.nonce,amount:grant.amount,deadline:grant.deadline,state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:!state.blocked,balance:'100',allowance:'0',blockers:state.blocked?['BUYER_INELIGIBLE','EXACT_ALLOWANCE_REQUIRED']:['EXACT_ALLOWANCE_REQUIRED'],block:{number:'100',hash:h(1),timestamp:'1000',finality:'finalized'},canSubmitPayment:false};
  }};
  x.session.signGrant=async grant=>{state.signatures++;return x.buyer.signTypedData(grantTypedData(grant));};
  const flow=new PurchaseFlow(()=>x.task,x.session,port,()=>1000n);await flow.catalog();await flow.propose([x.entry.quote.quoteId]);await flow.review();await flow.prepare('0','1200');
  return {...x,flow,port,state};
}
test('purchase owner signing refreshes preflight and preserves one immutable original authorization without approving or paying',async()=>{
  const x=await signedFlowHarness(),original=x.flow.authorization!.payload.grant;
  const signed=await x.flow.sign();assert.deepEqual(signed.payload.grant,original);assert.equal(signed.canSubmitPayment,false);assert.equal(x.state.signatures,1);
  assert.ok(Object.isFrozen(signed.payload));assert.equal(x.flow.preflightSnapshot?.allowance,'0');
  await assert.rejects(x.flow.sign(),/ORIGINAL_AUTHORIZATION_ALREADY_SIGNED/);
  x.flow.invalidateAuthorization();assert.equal(x.flow.signedAuthorization,signed);
  await assert.rejects(x.flow.prepare('1','1250'),/ORIGINAL_AUTHORIZATION_ALREADY_SIGNED/);assert.equal(x.state.signatures,1);
});
test('purchase signing blocks before wallet on ineligible or detached view and discards reset during a pending signature',async()=>{
  const x=await signedFlowHarness();x.state.blocked=true;await assert.rejects(x.flow.sign(),/AUTHORIZATION_CHAIN_BLOCKED/);assert.equal(x.state.signatures,0);x.state.blocked=false;
  x.port.preflight=async input=>{const {grant}=PreflightRequestSchema.parse(input);return {chainId:grant.chainId,arbiter:grant.arbiter,asset:grant.asset,buyer:grant.owner,orderId:grant.orderId,contextHash:grant.contextHash,nonce:grant.nonce,amount:grant.amount,deadline:grant.deadline,state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:true,balance:'100',allowance:'0',blockers:['EXACT_ALLOWANCE_REQUIRED'],block:{number:'100',hash:h(1),timestamp:'1000',finality:'finalized'},canSubmitPayment:false};};
  await assert.rejects(x.flow.sign(()=>{throw new Error('VIEW_CHANGED');}),/VIEW_CHANGED/);assert.equal(x.state.signatures,0);
  let release!:(sig:string)=>void,reached!:()=>void;const started=new Promise<void>(resolve=>{reached=resolve;});
  x.session.signGrant=()=>{reached();return new Promise(resolve=>{release=resolve;});};
  const grant=x.flow.authorization!.payload.grant,pending=x.flow.sign();await started;
  await assert.rejects(x.flow.sign(),/WALLET_SIGNATURE_PENDING/);x.flow.invalidateAuthorization();release(await x.buyer.signTypedData(grantTypedData(grant)));
  await assert.rejects(pending,/PURCHASE_CONTEXT_CHANGED/);assert.equal(x.flow.signedAuthorization,undefined);
});
