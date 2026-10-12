import test from 'node:test';
import assert from 'node:assert/strict';
import {PrivyClient} from '@privy-io/node';
import {keccak256,toHex,type Address,type Hex} from 'viem';
import {escrowPolicy} from '../packages/adapters/src/privy-sender.js';
import {inspectPrivyOrigin} from '../packages/adapters/src/privy-origin.js';
import {privyOriginPort} from '../packages/adapters/src/privy-origin-port.js';
import {PrivyOriginProofSchema,type PrivyOriginPort} from '../packages/protocol/src/day4-origin-types.js';

const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const rejection=(code:string)=>(error:unknown)=>error instanceof Error&&error.message===`PRIVY_ORIGIN_${code}`;

/** Synthetic local provider objects. They never authenticate to or query Privy. */
function fixture(){
  const now=1_800_000_000_000;
  const config={chainId:'10143' as const,arbiter:a(2),address:a(1),walletId:'synthetic-wallet',policyId:'synthetic-policy',signerId:'synthetic-signer'};
  const request={schemaVersion:1 as const,transactions:{funding:{recordId:'synthetic-funding',hash:h(11)},allocation:{recordId:'synthetic-allocation',hash:h(12)}}};
  const wallet={id:config.walletId,address:config.address,chain_type:'ethereum',created_at:now-1000,exported_at:null,imported_at:null,
    archived_at:null as number|null,owner_id:config.signerId as string|null,policy_ids:[config.policyId],
    additional_signers:[] as {signer_id:string;override_policy_ids?:string[]}[]};
  const policy={...escrowPolicy(config.chainId,config.arbiter),id:config.policyId,created_at:now-1000,owner_id:null,
    rules:escrowPolicy(config.chainId,config.arbiter).rules.map((rule,index)=>({...rule,id:`synthetic-rule-${index}`}))};
  const records:Record<'funding'|'allocation',Record<string,unknown>>={funding:{id:request.transactions.funding.recordId,caip2:'eip155:10143',
    created_at:now-500,status:'finalized',transaction_hash:request.transactions.funding.hash,wallet_id:config.walletId},
    allocation:{id:request.transactions.allocation.recordId,caip2:'eip155:10143',created_at:now-100,status:'finalized',
      transaction_hash:request.transactions.allocation.hash,wallet_id:config.walletId}};
  const calls:string[]=[];
  const hooks:{wallet?:(count:number)=>unknown;policy?:(count:number)=>unknown;transaction?:(step:'funding'|'allocation')=>unknown}={};
  let walletReads=0,policyReads=0;
  const port:PrivyOriginPort={wallet:async id=>{assert.equal(id,config.walletId);calls.push(`wallet:${id}`);return hooks.wallet?await hooks.wallet(++walletReads):(walletReads++,wallet);},
    policy:async id=>{assert.equal(id,config.policyId);calls.push(`policy:${id}`);return hooks.policy?await hooks.policy(++policyReads):(policyReads++,policy);},
    transaction:async id=>{const step=id===request.transactions.funding.recordId?'funding':'allocation';assert.equal(id,request.transactions[step].recordId);
      calls.push(`transaction:${id}`);return hooks.transaction?await hooks.transaction(step):records[step];}};
  return {now,config,request,wallet,policy,records,calls,hooks,port,inspect:()=>inspectPrivyOrigin(request,config,port,{now})};
}

test('synthetic Privy origin verifies both original finalized IDs and hashes with six reads and bounded scope',async()=>{
  const f=fixture(),proof=await f.inspect();assert.ok(PrivyOriginProofSchema.safeParse(proof).success);
  assert.deepEqual(f.calls,[`wallet:${f.config.walletId}`,`policy:${f.config.policyId}`,`transaction:${f.request.transactions.funding.recordId}`,
    `transaction:${f.request.transactions.allocation.recordId}`,`wallet:${f.config.walletId}`,`policy:${f.config.policyId}`]);
  assert.equal(proof.signerRole,'OWNER');assert.equal(proof.records.funding.hash,f.request.transactions.funding.hash);
  assert.equal(proof.policyRulesHash,keccak256(toHex(JSON.stringify(escrowPolicy(f.config.chainId,f.config.arbiter).rules.map(({method,action,conditions})=>({method,action,conditions}))))));
  assert.equal(proof.historicalPolicyAtSendVerified,false);assert.equal(proof.withdrawalProviderOriginVerified,false);
  assert.equal(proof.canExecute,false);assert.equal(proof.signaturesRequested,0);assert.equal(proof.transactionsSent,0);assert.equal(proof.financialAcceptanceStatus,'BLOCKED');
  assert.equal(proof.observedAtUnixMs,f.now);assert.equal(proof.providerTimestampUnitVerified,false);
  assert.ok(Object.isFrozen(proof)&&Object.isFrozen(proof.records.funding));
});
test('synthetic delegated signer requires exactly its fixed override policy',async()=>{
  const f=fixture();f.wallet.owner_id='synthetic-user';f.wallet.policy_ids=['unrelated-owner-policy'];
  f.wallet.additional_signers=[{signer_id:f.config.signerId,override_policy_ids:[f.config.policyId]}];
  assert.equal((await f.inspect()).signerRole,'DELEGATED');
});
test('synthetic owner accepts an unrelated signer without an override permitted by installed Wallet type',async()=>{
  const f=fixture();f.wallet.additional_signers=[{signer_id:'unrelated-signer'}];assert.equal((await f.inspect()).signerRole,'OWNER');
});
for(const status of ['broadcasted','confirmed','execution_reverted','failed','replaced','provider_error','pending']){
  test(`synthetic original ${status} is not finalized provider provenance`,async()=>{
    const f=fixture();f.records.funding.status=status;await assert.rejects(f.inspect(),rejection('NOT_FINALIZED'));
  });
}
test('synthetic finalized record with null hash remains blocked',async()=>{
  const f=fixture();f.records.allocation.transaction_hash=null;await assert.rejects(f.inspect(),rejection('NOT_FINALIZED'));
});
test('synthetic unknown status and malformed response cannot be promoted to finalized',async()=>{
  for(const value of ['success','FINALIZED','reverted',null,{},0]){
    const f=fixture();f.records.funding.status=value;await assert.rejects(f.inspect(),rejection('RECORD_INVALID'));
  }
  for(const value of [null,[],{},'finalized']){const f=fixture();f.hooks.transaction=()=>value;await assert.rejects(f.inspect(),rejection('RECORD_INVALID'));}
});
test('synthetic original record ID, chain, wallet and hash mismatches are rejected',async()=>{
  for(const change of [{id:'another-record'},{caip2:'eip155:1'},{wallet_id:'another-wallet'},
    {transaction_hash:h(99)}]){
    const f=fixture();Object.assign(f.records.allocation,change);await assert.rejects(f.inspect(),rejection('RECORD_MISMATCH'));
  }
});
test('synthetic provider timestamps retain unknown units and cannot assert historical event timing',async()=>{
  const f=fixture();f.records.funding.created_at=1_800_000_000;f.records.allocation.created_at=f.now+1000;
  const proof=await f.inspect();assert.equal(proof.records.funding.createdAt,1_800_000_000);
  assert.equal(proof.records.allocation.createdAt,f.now+1000);assert.equal(proof.providerTimestampUnitVerified,false);assert.equal(proof.observedAtUnixMs,f.now);
});
test('synthetic original creation time is a positive safe integer rather than coerced metadata',async()=>{
  for(const value of [0,-1,0.5,Number.MAX_SAFE_INTEGER+1,'1800000000000',NaN,Infinity]){
    const f=fixture();f.records.funding.created_at=value;await assert.rejects(f.inspect(),rejection('RECORD_INVALID'));
  }
});
test('synthetic duplicate original IDs or hashes fail before any remote read',async()=>{
  for(const field of ['recordId','hash'] as const){const f=fixture();
    if(field==='recordId')f.request.transactions.allocation.recordId=f.request.transactions.funding.recordId;
    else f.request.transactions.allocation.hash=f.request.transactions.funding.hash;
    await assert.rejects(f.inspect(),rejection('INPUT_INVALID'));assert.equal(f.calls.length,0);}
});
test('synthetic invalid config, request extras and private configuration cannot cross the input boundary',async()=>{
  const f=fixture();for(const config of [{...f.config,chainId:'1'},{...f.config,address:a(0)},{...f.config,walletId:'../escape'},
    {...f.config,walletId:'apikey_synthetic-id'},{...f.config,policyId:'sk-synthetic-id'},
    {...f.config,authorizationPrivateKey:'synthetic-private-input'}])await assert.rejects(inspectPrivyOrigin(f.request,config,f.port,{now:f.now}),rejection('INPUT_INVALID'));
  await assert.rejects(inspectPrivyOrigin({...f.request,withdrawal:{recordId:'not-supported',hash:h(13)}},f.config,f.port,{now:f.now}),rejection('INPUT_INVALID'));
  assert.equal(f.calls.length,0);
});
test('synthetic invalid observation clock fails before provider reads',async()=>{
  const f=fixture();for(const now of [0,-1,0.25,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    await assert.rejects(inspectPrivyOrigin(f.request,f.config,f.port,{now}),rejection('CLOCK_INVALID'));
  }assert.equal(f.calls.length,0);
});
test('synthetic current wallet and policy identifiers and address must match configured source',async()=>{
  for(const field of ['id','address'] as const){const f=fixture();if(field==='id')f.wallet.id='another-wallet';else f.wallet.address=a(99);
    await assert.rejects(f.inspect(),rejection('CURRENT_CONFIGURATION_MISMATCH'));}
  const f=fixture();f.policy.id='another-policy';await assert.rejects(f.inspect(),rejection('CURRENT_CONFIGURATION_MISMATCH'));
});
test('synthetic any non-null archive timestamp, including zero, rejects current wallet',async()=>{
  for(const archivedAt of [0,1,1_700_000_000_000]){const f=fixture();f.wallet.archived_at=archivedAt;
    await assert.rejects(f.inspect(),rejection('CURRENT_CONFIGURATION_MISMATCH'));}
});
test('synthetic unsupported wallet chain and policy version fail shape checks',async()=>{
  const f=fixture();f.wallet.chain_type='solana';await assert.rejects(f.inspect(),rejection('CURRENT_CONFIGURATION_INVALID'));
  const g=fixture();g.hooks.policy=()=>({...g.policy,version:'2.0'});await assert.rejects(g.inspect(),rejection('CURRENT_CONFIGURATION_INVALID'));
});
test('synthetic owner or selected delegation cannot inherit, duplicate or broaden effective policy IDs',async()=>{
  for(const ids of [[],['another-policy'],['synthetic-policy','extra-policy']]){const f=fixture();f.wallet.policy_ids=ids;
    await assert.rejects(f.inspect(),rejection('SIGNER_POLICY_MISMATCH'));}
  for(const signers of [[],[{signer_id:'synthetic-signer'}],[{signer_id:'synthetic-signer',override_policy_ids:[]}],
    [{signer_id:'synthetic-signer',override_policy_ids:['synthetic-policy']},{signer_id:'synthetic-signer',override_policy_ids:['synthetic-policy']}]]){
    const f=fixture();f.wallet.owner_id='another-owner';f.wallet.additional_signers=signers;await assert.rejects(f.inspect(),rejection('SIGNER_POLICY_MISMATCH'));
  }
});
test('synthetic policy must retain complete fixed chain, contract, zero value and calldata rules',async()=>{
  for(const mutation of [
    (f:ReturnType<typeof fixture>)=>{f.policy.rules[0].conditions[0].value='1';},
    (f:ReturnType<typeof fixture>)=>{f.policy.rules[0].conditions[1].value=a(99);},
    (f:ReturnType<typeof fixture>)=>{f.policy.rules[0].conditions[2].value='1';},
    (f:ReturnType<typeof fixture>)=>{f.policy.rules[0].conditions[3].value='withdraw';},
    (f:ReturnType<typeof fixture>)=>{f.policy.rules[0].conditions.pop();},
    (f:ReturnType<typeof fixture>)=>{f.policy.rules.pop();},
    (f:ReturnType<typeof fixture>)=>{f.policy.rules.push(structuredClone(f.policy.rules[0]));},
  ]){const f=fixture();mutation(f);await assert.rejects(f.inspect(),rejection('POLICY_SCOPE_MISMATCH'));}
  for(const change of [{method:'*'},{action:'DENY'},{conditions:[]}]){const f=fixture();f.hooks.policy=()=>({...f.policy,rules:f.policy.rules.map((rule,index)=>index?rule:{...rule,...change})});
    await assert.rejects(f.inspect(),rejection('POLICY_SCOPE_MISMATCH'));}
});
test('synthetic provider errors expose only a fixed read error for each of six reads',async()=>{
  for(const slot of ['wallet1','policy1','funding','allocation','wallet2','policy2']){
    const f=fixture(),raw='synthetic-provider-body-and-private-header';
    f.hooks.wallet=count=>{if(slot===`wallet${count}`)throw Error(raw);return f.wallet;};
    f.hooks.policy=count=>{if(slot===`policy${count}`)throw Error(raw);return f.policy;};
    f.hooks.transaction=step=>{if(slot===step)throw Error(raw);return f.records[step];};
    await assert.rejects(f.inspect(),rejection('READ_UNAVAILABLE'));
  }
});
test('synthetic raw response alias changes do not alter already captured original record metadata',async()=>{
  const f=fixture();f.hooks.transaction=step=>{if(step==='allocation')Object.assign(f.records.funding,{id:'substituted-id',transaction_hash:h(99),created_at:f.now+1});return f.records[step];};
  const proof=await f.inspect();assert.equal(proof.records.funding.id,'synthetic-funding');assert.equal(proof.records.funding.hash,h(11));
});
test('synthetic provider response identity drift between current reads fails despite both views being individually valid',async()=>{
  const f=fixture();f.hooks.wallet=count=>count===1?f.wallet:{...f.wallet,owner_id:'another-owner',
    additional_signers:[{signer_id:f.config.signerId,override_policy_ids:[f.config.policyId]}]};
  await assert.rejects(f.inspect(),rejection('CURRENT_CONFIGURATION_CHANGED'));
});
test('synthetic second-read policy broadening is rejected and cannot attest unchanged policy',async()=>{
  const f=fixture();f.hooks.policy=count=>count===1?f.policy:{...f.policy,rules:[]};await assert.rejects(f.inspect(),rejection('POLICY_SCOPE_MISMATCH'));
});
test('synthetic request, config, clock options and port method mutation cannot redirect reads after first await',async()=>{
  const f=fixture(),options={now:f.now};let swapped=0;
  const original={request:structuredClone(f.request),config:structuredClone(f.config)};
  f.hooks.wallet=()=>{f.request.transactions.funding.recordId='substituted-record';f.request.transactions.allocation.hash=h(99);
    f.config.address=a(99);options.now=f.now-10000;f.port.transaction=async()=>{swapped++;throw Error('must-not-run');};return f.wallet;};
  // Resolve using the original captured ID rather than this deliberately mutated fixture request.
  f.port.transaction=async id=>{const step=id===original.request.transactions.funding.recordId?'funding':'allocation';
    assert.equal(id,original.request.transactions[step].recordId);f.calls.push(`transaction:${id}`);return f.records[step];};
  const proof=await inspectPrivyOrigin(f.request,f.config,f.port,options);
  assert.equal(swapped,0);assert.equal(proof.executor,original.config.address);assert.equal(proof.records.allocation.hash,original.request.transactions.allocation.hash);
  assert.equal(proof.observedAtUnixMs,f.now);
});
test('synthetic extra provider metadata and display names are never copied into public proof or policy hash',async()=>{
  const f=fixture(),extra='synthetic-sensitive-provider-extra';
  Object.assign(f.wallet,{private_metadata:extra});Object.assign(f.policy,{private_metadata:extra,name:extra});
  f.policy.rules.forEach(rule=>{rule.name=extra;Object.assign(rule,{private_metadata:extra});});
  Object.assign(f.records.funding,{reference_id:extra,user_operation_hash:extra,sponsored:true,authorizationPrivateKey:extra});
  const proof=await f.inspect();assert.equal(JSON.stringify(proof).includes(extra),false);
  assert.deepEqual(Object.keys(proof.records.funding).sort(),['caip2','createdAt','hash','id','status','walletId']);
});
test('synthetic uncloneable provider response maps to fixed error without disclosing raw body',async()=>{
  const f=fixture();f.hooks.transaction=()=>({callback:()=>{},secret:'synthetic-unpublishable'});await assert.rejects(f.inspect(),rejection('READ_UNAVAILABLE'));
});
test('Privy read-only adapter freezes its surface, binds service receivers and rejects invalid IDs before SDK reads',async()=>{
  const calls:string[]=[];
  const transactionService={tag:'transaction',get:async function(id:string){calls.push(`${this.tag}:${id}`);return {id};}};
  const walletService={tag:'wallet',get:async function(id:string){calls.push(`${this.tag}:${id}`);return {id};}};
  const policyService={tag:'policy',get:async function(id:string){calls.push(`${this.tag}:${id}`);return {id};}};
  const client={transactions:()=>transactionService,wallets:()=>walletService,policies:()=>policyService} as unknown as PrivyClient;
  const port=privyOriginPort(client);assert.deepEqual(Object.keys(port).sort(),['policy','transaction','wallet']);assert.ok(Object.isFrozen(port));
  await port.transaction('synthetic-tx');await port.wallet('synthetic-wallet');await port.policy('synthetic-policy');assert.equal(calls.length,3);
  for(const id of ['', '../escape','a/b','a?token=private','apikey_synthetic-id','sk-synthetic-id','x'.repeat(129)])for(const read of [port.transaction,port.wallet,port.policy])await assert.rejects(read(id),rejection('ID_INVALID'));
  assert.equal(calls.length,3);
});
test('Privy read-only adapter captures original SDK services and methods before method swaps',async()=>{
  let originals=0,swapped=0;
  const service={get:async()=>{originals++;return {};}};
  const client={transactions:()=>service,wallets:()=>service,policies:()=>service} as unknown as PrivyClient;
  const port=privyOriginPort(client);service.get=async()=>{swapped++;return {};};
  client.transactions=()=>{swapped++;throw Error('substituted-service');};
  client.wallets=()=>{swapped++;throw Error('substituted-service');};client.policies=()=>{swapped++;throw Error('substituted-service');};
  await port.transaction('synthetic-tx');await port.wallet('synthetic-wallet');await port.policy('synthetic-policy');assert.equal(originals,3);assert.equal(swapped,0);
});
test('Privy read-only adapter malformed client exposes a fixed construction error',()=>{
  assert.throws(()=>privyOriginPort({transactions:()=>({}),wallets:()=>({}),policies:()=>({})} as unknown as PrivyClient),rejection('CLIENT_INVALID'));
});

function sdkFixture(status=200){
  const f=fixture(),calls:{path:string;method:string}[]=[];
  // The installed SDK executes solely against this local fetch double. No real HTTP, keys or signatures.
  const client=new PrivyClient({appId:'synthetic-app',appSecret:'synthetic-only',apiUrl:'https://synthetic-privy.invalid',maxRetries:0,logLevel:'off',
    fetch:async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
      assert.equal(url.origin,'https://synthetic-privy.invalid');assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);
      const headers=new Headers(init?.headers);assert.equal(headers.has('privy-authorization-signature'),false);
      calls.push({path:url.pathname,method:String(init?.method)});
      let body:unknown;
      if(url.pathname===`/v1/wallets/${f.config.walletId}`)body=f.wallet;
      else if(url.pathname===`/v1/policies/${f.config.policyId}`)body=f.policy;
      else if(url.pathname===`/v1/transactions/${f.request.transactions.funding.recordId}`)body=f.records.funding;
      else if(url.pathname===`/v1/transactions/${f.request.transactions.allocation.recordId}`)body=f.records.allocation;
      else throw Error('SDK attempted an unsupported endpoint');
      return new Response(JSON.stringify(status===200?body:{error:'synthetic-private-provider-error'}),{status,headers:{'content-type':'application/json'}});
    }});
  return {...f,client,calls};
}
test('installed Privy 0.35.0 SDK serializes exactly the six read-only origin GETs against a local fetch double',async()=>{
  const f=sdkFixture();const proof=await inspectPrivyOrigin(f.request,f.config,privyOriginPort(f.client),{now:f.now});
  assert.equal(proof.status,'PROVIDER_RECORDS_VERIFIED');assert.deepEqual(f.calls.map(call=>call.path),[
    `/v1/wallets/${f.config.walletId}`,`/v1/policies/${f.config.policyId}`,`/v1/transactions/${f.request.transactions.funding.recordId}`,
    `/v1/transactions/${f.request.transactions.allocation.recordId}`,`/v1/wallets/${f.config.walletId}`,`/v1/policies/${f.config.policyId}`]);
});
for(const status of [401,404,429,500])test(`installed SDK local HTTP ${status} never substitutes missing provider origin or leaks response`,async()=>{
  const f=sdkFixture(status);await assert.rejects(inspectPrivyOrigin(f.request,f.config,privyOriginPort(f.client),{now:f.now}),rejection('READ_UNAVAILABLE'));
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.method==='GET'));
});
