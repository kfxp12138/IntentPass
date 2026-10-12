import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {PrivyClient} from '@privy-io/node';
import {encodeFunctionData,keccak256,type Address,type Hex} from 'viem';
import {PrivyRestrictedSender,SubmissionRejected,escrowPolicy,type PrivySenderConfig} from '../packages/adapters/src/privy-sender.js';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';
import {RecordedBroadcastSchema} from '../packages/protocol/src/provider-submission.js';

const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const settle=()=>encodeFunctionData({abi:escrowAbi,functionName:'settle',args:[h(1)]});
const withdrawal=()=>encodeFunctionData({abi:escrowAbi,functionName:'withdraw',args:[h(1)]});
const unknown=(error:unknown)=>error instanceof Error&&!(error instanceof SubmissionRejected)&&error.message==='SUBMISSION_OUTCOME_UNKNOWN';
const scope='SDK_SEND_RESPONSE_ASSOCIATION_NOT_FINALIZED_OR_POLICY_PROVENANCE';

function fixture(options:{sensitiveValues?:string[];response?:unknown}={}){
  // All provider state, identifiers and responses below are explicit local doubles.
  const config:PrivySenderConfig={chainId:'10143',address:a(1),arbiter:a(2),walletId:'synthetic-wallet',policyId:'synthetic-policy',
    signerId:'synthetic-signer',authorizationPrivateKey:'synthetic-authorizer',gasLimit:'2000000',sensitiveValues:options.sensitiveValues};
  const wallet={id:config.walletId,chain_type:'ethereum',address:config.address,owner_id:config.signerId,policy_ids:[config.policyId],
    additional_signers:[] as {signer_id:string;override_policy_ids?:string[]}[],archived_at:null as number|null};
  const policy={id:config.policyId,...escrowPolicy(config.chainId,config.arbiter)};
  let response:unknown=options.response??{hash:h(8),caip2:'eip155:10143',transaction_id:'synthetic-original-id'};
  let walletReads=0,policyReads=0,sends=0,last:{id:string;request:unknown}|undefined;
  const hooks:{wallet?:()=>void|Promise<void>;policy?:()=>void|Promise<void>;send?:()=>void|Promise<void>}={};
  const ethereum={sendTransaction:async(id:string,request:unknown)=>{sends++;last={id,request};await hooks.send?.();return response;}};
  const wallets={get:async()=>{walletReads++;await hooks.wallet?.();return wallet;},ethereum:()=>ethereum};
  const policies={get:async()=>{policyReads++;await hooks.policy?.();return policy;}};
  const client={wallets:()=>wallets,policies:()=>policies} as unknown as PrivyClient;
  const sender=new PrivyRestrictedSender(client,config);
  const input={chainId:'10143',from:a(1),to:a(2),value:'0' as const,data:settle(),idempotencyKey:'synthetic-once'};
  return {config,wallet,policy,client,wallets,policies,ethereum,sender,input,hooks,counts:()=>({walletReads,policyReads,sends}),last:()=>last,
    response:(value:unknown)=>{response=value;}};
}

test('recorded Privy broadcast preserves only original SDK ID and exact fixed call association',async()=>{
  const f=fixture(),result=await f.sender.sendRecorded(f.input);
  assert.deepEqual(result,{hash:h(8),providerSubmission:{provider:'PRIVY',scope,transactionId:'synthetic-original-id',walletId:f.config.walletId,
    chainId:'10143',from:a(1),to:a(2),calldataHash:keccak256(settle())}});
  assert.equal(RecordedBroadcastSchema.safeParse(result).success,true);
  assert.deepEqual(f.counts(),{walletReads:1,policyReads:1,sends:1});
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.providerSubmission));
});

test('missing optional SDK transaction ID remains null without deriving an ID from hash',async()=>{
  const f=fixture({response:{hash:h(8),caip2:'eip155:10143',reference_id:'synthetic-reference'}});
  assert.deepEqual(await f.sender.sendRecorded(f.input),{hash:h(8),providerSubmission:null});
  assert.equal(f.counts().sends,1);
});

test('legacy Privy send uses one recorded path and still returns a transaction hash',async()=>{
  const f=fixture();assert.equal(await f.sender.send(f.input),h(8));assert.equal(f.counts().sends,1);
});

test('SDK response extras and reference ID are never persisted as provider provenance',async()=>{
  const f=fixture({response:{hash:h(8),caip2:'eip155:10143',transaction_id:'synthetic-original-id',reference_id:'another-reference',
    authorization_private_key:'local-provider-extra',arbitrary:{secret:'synthetic-extra'}}});
  const result=await f.sender.sendRecorded(f.input);
  assert.deepEqual(Object.keys(result).sort(),['hash','providerSubmission']);
  assert.deepEqual(Object.keys(result.providerSubmission!).sort(),['calldataHash','chainId','from','provider','scope','to','transactionId','walletId']);
  assert.ok(!JSON.stringify(result).includes('local-provider-extra'));
});

test('malformed present optional IDs after a send fail UNKNOWN without fallback or retry',async()=>{
  for(const transaction_id of [null,'','bad/id','../record','https://example.invalid/id','x'.repeat(129),42,{},['synthetic-id'],'apikey_synthetic','sk-synthetic']){
    const f=fixture({response:{hash:h(8),caip2:'eip155:10143',transaction_id}});
    await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.counts().sends,1);
  }
});

test('legacy send cannot downgrade a malformed optional original ID into a successful hash',async()=>{
  const f=fixture({response:{hash:h(8),caip2:'eip155:10143',transaction_id:null}});
  await assert.rejects(f.sender.send(f.input),unknown);assert.equal(f.counts().sends,1);
});

test('known sensitive ID and authorization key substrings cannot become persisted metadata',async()=>{
  const secret='synthetic-sensitive-value-72931';
  for(const transaction_id of [secret,`original-${secret}-record`,'synthetic-authorizer']){
    const f=fixture({sensitiveValues:[secret],response:{hash:h(8),caip2:'eip155:10143',transaction_id}});
    await assert.rejects(f.sender.sendRecorded(f.input),error=>unknown(error)&&!(error as Error).message.includes(secret));
    assert.equal(f.counts().sends,1);
  }
});

test('known sensitive hash is rejected even when SDK optional transaction ID is absent',async()=>{
  const f=fixture({sensitiveValues:[h(8)]});f.response({hash:h(8),caip2:'eip155:10143'});
  await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.counts().sends,1);
});

test('sensitive fixed provider IDs fail before any GET or send and emit only UNKNOWN',async()=>{
  const f=fixture();
  const config={...f.config,walletId:'synthetic-app-secret',sensitiveValues:['synthetic-app-secret']};
  const sender=new PrivyRestrictedSender(f.client,config);
  await assert.rejects(sender.sendRecorded({...f.input}),unknown);
  assert.deepEqual(f.counts(),{walletReads:0,policyReads:0,sends:0});
});

test('sensitive fixed from/to values cannot be persisted in the successful association',async()=>{
  for(const secret of [a(1),a(2).toUpperCase()]){
    const f=fixture({sensitiveValues:[secret]});
    await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.counts().sends,1);
  }
});

test('input mutation at first wallet await cannot replace settle with withdrawal or alter call metadata',async()=>{
  const f=fixture(),original=structuredClone(f.input);
  f.hooks.wallet=()=>{f.input.data=withdrawal();f.input.chainId='1';f.input.to=a(9);f.input.from=a(9);f.input.idempotencyKey='synthetic-substituted';};
  const result=await f.sender.sendRecorded(f.input);
  const request=f.last()!.request as {params:{transaction:{data:Hex;to:Address;from:Address;chain_id:string}};idempotency_key:string};
  assert.deepEqual(request.params.transaction,{chain_id:'0x279f',from:original.from,to:original.to,value:'0x0',data:original.data,gas_limit:'0x1e8480'});
  assert.equal(request.idempotency_key,original.idempotencyKey);
  assert.equal(result.providerSubmission!.calldataHash,keccak256(original.data));
  assert.equal(result.providerSubmission!.to,original.to);assert.equal(result.providerSubmission!.chainId,original.chainId);
  assert.equal(f.counts().sends,1);
});

test('configuration and sensitive-value array mutation after construction cannot change fixed broadcast',async()=>{
  const secret='synthetic-config-secret';const sensitive=[secret];const f=fixture({sensitiveValues:sensitive});
  f.hooks.wallet=()=>{Object.assign(f.config,{chainId:'1',address:a(9),arbiter:a(9),walletId:'other-wallet',policyId:'other-policy',
    signerId:'other-signer',authorizationPrivateKey:'synthetic-replacement',gasLimit:'21000'});sensitive.length=0;};
  const result=await f.sender.sendRecorded(f.input);
  const request=f.last()!.request as {authorization_context:{authorization_private_keys:string[]};params:{transaction:{gas_limit:string}}};
  assert.equal(f.last()!.id,'synthetic-wallet');assert.equal(result.providerSubmission!.walletId,'synthetic-wallet');
  assert.deepEqual(request.authorization_context.authorization_private_keys,['synthetic-authorizer']);
  assert.equal(request.params.transaction.gas_limit,'0x1e8480');
  f.response({hash:h(8),caip2:'eip155:10143',transaction_id:secret});
  await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.counts().sends,2);
});

test('provider service method swaps at first await cannot redirect fixed wallet policy or broadcast calls',async()=>{
  const f=fixture();let swapped=0;
  f.hooks.wallet=()=>{
    f.wallets.get=async()=>{swapped++;throw Error('synthetic-swap');};
    f.policies.get=async()=>{swapped++;throw Error('synthetic-swap');};
    f.ethereum.sendTransaction=async()=>{swapped++;throw Error('synthetic-swap');};
    f.wallets.ethereum=()=>{swapped++;throw Error('synthetic-swap');};
    f.client.wallets=()=>{swapped++;throw Error('synthetic-swap');};
    f.client.policies=()=>{swapped++;throw Error('synthetic-swap');};
  };
  assert.equal((await f.sender.sendRecorded(f.input)).hash,h(8));assert.equal(swapped,0);
  assert.deepEqual(f.counts(),{walletReads:1,policyReads:1,sends:1});
});

test('remote wallet aliases mutated during policy await do not mutate the validated snapshot',async()=>{
  const f=fixture();f.hooks.policy=()=>{f.wallet.address=a(9);f.wallet.policy_ids.length=0;f.wallet.archived_at=0;};
  assert.equal((await f.sender.sendRecorded(f.input)).hash,h(8));assert.equal(f.counts().sends,1);
});

test('provider receives a deeply frozen request and cannot replace calldata before broadcasting',async()=>{
  const f=fixture();f.hooks.send=()=>{
    const request=f.last()!.request as {params:{transaction:{data:Hex}};authorization_context:{authorization_private_keys:string[]}};
    assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.params.transaction));assert.ok(Object.isFrozen(request.authorization_context.authorization_private_keys));
    assert.throws(()=>{request.params.transaction.data=withdrawal();},TypeError);
  };
  const result=await f.sender.sendRecorded(f.input);assert.equal(result.providerSubmission!.calldataHash,keccak256(settle()));assert.equal(f.counts().sends,1);
});

test('original SDK response allowlisted fields are read once and result is detached from response aliases',async()=>{
  const counts={hash:0,caip2:0,transaction_id:0};
  const raw={get hash(){assert.equal(++counts.hash,1);return h(8);},get caip2(){assert.equal(++counts.caip2,1);return 'eip155:10143';},
    get transaction_id(){assert.equal(++counts.transaction_id,1);return 'synthetic-original-id';}};
  const f=fixture({response:raw}),result=await f.sender.sendRecorded(f.input);
  assert.deepEqual(counts,{hash:1,caip2:1,transaction_id:1});assert.equal(result.providerSubmission!.transactionId,'synthetic-original-id');
  assert.throws(()=>{result.providerSubmission!.transactionId='synthetic-replacement';},TypeError);
  const mutable={hash:h(8),caip2:'eip155:10143',transaction_id:'synthetic-second-original'};
  f.response(mutable);const second=await f.sender.sendRecorded(f.input);mutable.hash=h(9);mutable.transaction_id='synthetic-changed';
  assert.equal(second.hash,h(8));assert.equal(second.providerSubmission!.transactionId,'synthetic-second-original');
});

test('post-send provider errors, getter errors and malformed hashes become fixed UNKNOWN with one send',async()=>{
  for(const response of [null,{}, {hash:'0xnope',caip2:'eip155:10143'}, {hash:h(8),caip2:'eip155:1'},
    {get hash(){throw Error('synthetic-provider-secret');},caip2:'eip155:10143'}]){
    const f=fixture();f.response(response);
    await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.counts().sends,1);
  }
  const f=fixture();f.hooks.send=()=>{throw Error('synthetic-provider-secret');};
  await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.counts().sends,1);
});

test('fixed local scope and actual policy restrictions still fail before any broadcast',async()=>{
  for(const change of [{chainId:'1'},{from:a(9)},{to:a(9)},{value:'1'},{data:withdrawal()},{data:`${settle()}00`},{idempotencyKey:7}]){
    const f=fixture();await assert.rejects(f.sender.sendRecorded({...f.input,...change} as typeof f.input),SubmissionRejected);
    assert.deepEqual(f.counts(),{walletReads:0,policyReads:0,sends:0});
  }
  const f=fixture();f.policy.rules[0].conditions[0].value='1';await assert.rejects(f.sender.sendRecorded(f.input),SubmissionRejected);assert.equal(f.counts().sends,0);
  const g=fixture();g.wallet.archived_at=0;await assert.rejects(g.sender.sendRecorded(g.input),SubmissionRejected);assert.equal(g.counts().sends,0);
});

test('owner and delegated signer policies retain exact singleton fixed-policy restrictions',async()=>{
  const f=fixture();f.wallet.owner_id='synthetic-other-owner';f.wallet.additional_signers=[{signer_id:f.config.signerId,override_policy_ids:[f.config.policyId]}];
  assert.equal((await f.sender.sendRecorded(f.input)).hash,h(8));
  for(const override_policy_ids of [undefined,[],['synthetic-other-policy'],[f.config.policyId,'synthetic-other-policy']]){
    const g=fixture();g.wallet.owner_id='synthetic-other-owner';g.wallet.additional_signers=[{signer_id:g.config.signerId,override_policy_ids}];
    await assert.rejects(g.sender.sendRecorded(g.input),SubmissionRejected);assert.equal(g.counts().sends,0);
  }
});

function installedFixture(responseData:unknown,options:{rpcStatus?:number;connectionLoss?:boolean}={}){
  // Installed SDK with a custom in-memory fetch. No HTTP connection or real key is used.
  const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const config:PrivySenderConfig={chainId:'10143',address:a(1),arbiter:a(2),walletId:'synthetic-wallet',policyId:'synthetic-policy',
    signerId:'synthetic-signer',authorizationPrivateKey:privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),gasLimit:'2000000',sensitiveValues:['synthetic-app-secret']};
  const policy={id:config.policyId,...escrowPolicy(config.chainId,config.arbiter)};
  let rpcCalls=0;const calls:{path:string;method:string}[]=[];
  const client=new PrivyClient({appId:'synthetic-app',appSecret:'synthetic-app-secret',apiUrl:'https://synthetic.invalid',maxRetries:0,logLevel:'off',fetch:async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    assert.equal(url.origin,'https://synthetic.invalid');const method=init?.method??'GET';calls.push({path:url.pathname,method});
    let body:unknown;
    if(url.pathname==='/v1/wallets/synthetic-wallet'){
      assert.equal(method,'GET');body={id:config.walletId,chain_type:'ethereum',address:config.address,owner_id:config.signerId,
        policy_ids:[config.policyId],additional_signers:[],archived_at:null};
    }else if(url.pathname==='/v1/policies/synthetic-policy'){assert.equal(method,'GET');body=policy;}
    else{
      assert.equal(url.pathname,'/v1/wallets/synthetic-wallet/rpc');assert.equal(method,'POST');rpcCalls++;
      const request=JSON.parse(String(init?.body)),headers=new Headers(init?.headers);
      assert.equal(request.method,'eth_sendTransaction');assert.equal(request.params.transaction.data,settle());
      assert.equal(headers.get('privy-idempotency-key'),'synthetic-sdk-once');assert.ok(headers.get('privy-authorization-signature'));
      if(options.connectionLoss)throw Error('synthetic-network-loss');
      if(options.rpcStatus)return new Response(JSON.stringify({error:'synthetic-provider-error'}),{status:options.rpcStatus,headers:{'content-type':'application/json'}});
      body={method:'eth_sendTransaction',data:responseData};
    }
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  }});
  const sender=new PrivyRestrictedSender(client,config),input={chainId:config.chainId,from:config.address,to:config.arbiter,value:'0' as const,data:settle(),idempotencyKey:'synthetic-sdk-once'};
  return {sender,input,calls,rpcCalls:()=>rpcCalls};
}

test('installed SDK original transaction_id is preserved after actual local RPC response deserialization',async()=>{
  const f=installedFixture({hash:h(8),caip2:'eip155:10143',transaction_id:'synthetic-installed-original',reference_id:'synthetic-reference'});
  const result=await f.sender.sendRecorded(f.input);
  assert.equal(result.providerSubmission!.transactionId,'synthetic-installed-original');assert.equal(f.rpcCalls(),1);
  assert.deepEqual(f.calls.map(call=>call.method),['GET','GET','POST']);
});

test('installed SDK response without transaction_id stays null and legacy entry returns only hash',async()=>{
  const f=installedFixture({hash:h(8),caip2:'eip155:10143'});assert.deepEqual(await f.sender.sendRecorded(f.input),{hash:h(8),providerSubmission:null});assert.equal(f.rpcCalls(),1);
  const g=installedFixture({hash:h(8),caip2:'eip155:10143',transaction_id:'synthetic-installed-original'});assert.equal(await g.sender.send(g.input),h(8));assert.equal(g.rpcCalls(),1);
});

test('installed SDK malformed or sensitive optional ID never causes automatic resend or legacy success',async()=>{
  for(const transaction_id of [null,'../not-an-id','apikey_synthetic','synthetic-app-secret']){
    const f=installedFixture({hash:h(8),caip2:'eip155:10143',transaction_id});
    await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.rpcCalls(),1);
  }
});

test('installed SDK configured zero retries keeps one RPC call on lost response or provider rejection',async()=>{
  for(const options of [{connectionLoss:true},{rpcStatus:401},{rpcStatus:429},{rpcStatus:500}]){
    const f=installedFixture({hash:h(8),caip2:'eip155:10143'},options);
    await assert.rejects(f.sender.sendRecorded(f.input),unknown);assert.equal(f.rpcCalls(),1);
  }
});
