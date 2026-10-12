import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {PrivyClient} from '@privy-io/node';
import {encodeFunctionData,type Hex} from 'viem';
import {PrivyAuthenticator,AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {PrivyRestrictedSender,SubmissionRejected,escrowPolicy} from '../packages/adapters/src/privy-sender.js';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Hex,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwt=(overrides:Record<string,unknown>={})=>{
  const head=Buffer.from(JSON.stringify({alg:'ES256',typ:'JWT'})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:'privy.io',aud:'test-app',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,sid:'test-session',sub:'did:privy:test-user',...overrides})).toString('base64url');
  const data=`${head}.${body}`;return `${data}.${sign('sha256',Buffer.from(data),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
};
function authHarness(userId='did:privy:test-user') {
  let lookups=0;
  // Real Privy JWT verification; HTTP response is an explicitly local provider fixture.
  const client=new PrivyClient({appId:'test-app',appSecret:'local-test-only',jwtVerificationKey:publicKey.export({type:'spki',format:'pem'}).toString(),maxRetries:0,logLevel:'off',fetch:async(input)=>{
    assert.equal(decodeURIComponent(new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname),'/v1/users/did:privy:test-user');lookups++;
    return new Response(JSON.stringify({id:userId,linked_accounts:[{type:'wallet',chain_type:'ethereum',address:a(1)},{type:'wallet',chain_type:'solana',address:'not-ethereum'}]}),{status:200,headers:{'content-type':'application/json'}});
  }});
  return {auth:new PrivyAuthenticator(client),lookups:()=>lookups};
}
test('real Privy SDK verifies ephemeral ES256 access token and binds user lookup',async()=>{
  const x=authHarness();assert.deepEqual(await x.auth.authenticate(jwt()),{subject:'did:privy:test-user',wallets:[a(1)]});assert.equal(x.lookups(),1);
});
test('wrong audience/issuer, expiry, future issue time, missing session and tampered JWT fail before provider lookup',async()=>{
  const x=authHarness();
  for(const token of [jwt({aud:'another-app'}),jwt({iss:'attacker'}),jwt({exp:1}),jwt({iat:Math.floor(Date.now()/1000)+100}),jwt({sid:null}),jwt().replace(/.$/,'!')])await assert.rejects(x.auth.authenticate(token),AuthenticationRejected);
  assert.equal(x.lookups(),0);
});
test('provider subject substitution is rejected',async()=>{await assert.rejects(authHarness('did:privy:other').auth.authenticate(jwt()),AuthenticationRejected);});
function senderHarness() {
  const config={chainId:'10143',arbiter:a(2),address:a(1),walletId:'test-wallet',policyId:'test-policy',signerId:'server-signer',authorizationPrivateKey:['fixture-neve','r-used-to-sign'].join(''),gasLimit:'2000000'};
  const wallet={id:config.walletId,address:a(1),chain_type:'ethereum',owner_id:config.signerId,policy_ids:[config.policyId],additional_signers:[] as {signer_id:string;override_policy_ids:string[]}[]};
  const policy={...escrowPolicy(config.chainId,config.arbiter),id:config.policyId};let sends=0,last:unknown;
  // Provider methods are TEST DOUBLES, not a real Privy policy acceptance test.
  const client={wallets:()=>({get:async()=>wallet,ethereum:()=>({sendTransaction:async(_id:string,input:unknown)=>{sends++;last=input;return {hash:h(8),caip2:'eip155:10143'};}})}),policies:()=>({get:async()=>policy})} as unknown as PrivyClient;
  const input={chainId:config.chainId,from:a(1),to:a(2),value:'0' as const,data:encodeFunctionData({abi:escrowAbi,functionName:'settle',args:[h(1)]}),idempotencyKey:'one-attempt'};
  return {sender:new PrivyRestrictedSender(client,config),config,wallet,policy,input,sends:()=>sends,last:()=>last};
}
test('restricted sender carries fixed chain, target, zero value, gas cap and idempotency key',async()=>{
  const x=senderHarness();assert.equal(await x.sender.send(x.input),h(8));assert.equal(x.sends(),1);
  const sent=x.last() as {idempotency_key:string;params:{transaction:{gas_limit:string;value:string;to:string}}};
  assert.equal(sent.idempotency_key,'one-attempt');assert.equal(sent.params.transaction.gas_limit,'0x1e8480');assert.equal(sent.params.transaction.value,'0x0');assert.equal(sent.params.transaction.to,a(2));
});
test('wrong chain, sender, target, value, unrelated selector or appended calldata never sends',async()=>{
  const x=senderHarness();for(const override of [{chainId:'1'},{from:a(9)},{to:a(9)},{value:'1'},{data:encodeFunctionData({abi:escrowAbi,functionName:'withdraw',args:[h(1)]})},{data:`${x.input.data}00`}])await assert.rejects(x.sender.send({...x.input,...override} as typeof x.input),SubmissionRejected);
  assert.equal(x.sends(),0);
});
test('remote policy drift or signer override cannot broaden transaction permissions',async()=>{
  const x=senderHarness();x.policy.rules[0].conditions[0].value='1';await assert.rejects(x.sender.send(x.input),SubmissionRejected);assert.equal(x.sends(),0);
  const y=senderHarness();y.wallet.owner_id='other';y.wallet.additional_signers=[{signer_id:y.config.signerId,override_policy_ids:[]}];await assert.rejects(y.sender.send(y.input),SubmissionRejected);assert.equal(y.sends(),0);
  y.wallet.additional_signers[0].override_policy_ids=[y.config.policyId];assert.equal(await y.sender.send(y.input),h(8));
});
test('real Privy SDK signs and serializes restricted RPC once; connection loss never retries',async()=>{
  const config={chainId:'10143',arbiter:a(2),address:a(1),walletId:'test-wallet',policyId:'test-policy',signerId:'server-signer',authorizationPrivateKey:privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),gasLimit:'2000000'};
  const policy={...escrowPolicy(config.chainId,config.arbiter),id:config.policyId};let rpcCalls=0,loseResponse=false;
  const client=new PrivyClient({appId:'test-app',appSecret:'local-test-only',maxRetries:0,logLevel:'off',fetch:async(input,init)=>{
    const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
    let body:unknown;
    if(path==='/v1/wallets/test-wallet')body={id:config.walletId,address:a(1),chain_type:'ethereum',owner_id:config.signerId,policy_ids:[config.policyId],additional_signers:[]};
    else if(path==='/v1/policies/test-policy')body=policy;
    else {
      assert.equal(path,'/v1/wallets/test-wallet/rpc');rpcCalls++;
      const headers=new Headers(init?.headers);assert.equal(headers.get('privy-idempotency-key'),'sdk-attempt');assert.ok(headers.get('privy-authorization-signature'));
      const request=JSON.parse(String(init?.body));assert.equal(request.method,'eth_sendTransaction');assert.equal(request.caip2,'eip155:10143');assert.equal(request.params.transaction.to,a(2));assert.equal(request.params.transaction.value,'0x0');
      if(loseResponse)throw new Error('local simulated connection loss');
      body={method:'eth_sendTransaction',data:{hash:h(9),caip2:'eip155:10143'}};
    }
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  }});
  const sender=new PrivyRestrictedSender(client,config),input={chainId:config.chainId,from:a(1),to:a(2),value:'0' as const,data:encodeFunctionData({abi:escrowAbi,functionName:'timeout',args:[h(1)]}),idempotencyKey:'sdk-attempt'};
  assert.equal(await sender.send(input),h(9));assert.equal(rpcCalls,1);loseResponse=true;await assert.rejects(sender.send(input));assert.equal(rpcCalls,2);
});
