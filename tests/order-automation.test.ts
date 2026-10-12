import test from 'node:test';
import assert from 'node:assert/strict';
import {CompleteOrderAutomation} from '../packages/automation/src/index.js';
import type {BrowserSession} from '../apps/web/src/browser-session.js';
import {originalAuthorizationFixture,readTestAddress} from './support/original-authorization.js';

test('complete order automation requires distinct fixed members and explicit confirmation before any actor access',async()=>{
  const f=await originalAuthorizationFixture('10143');let reads=0;
  const session={verified:async()=>{reads++;throw Error('UNEXPECTED_ROLE_ACCESS');}} as unknown as BrowserSession;
  const input={payload:f.payload,dataset:f.dataset};assert.throws(()=>new CompleteOrderAutomation(input,'http://localhost:3000',{seller:session,members:[{index:0,session},{index:0,session}],settler:session,payee:session}),/DISTINCT_MEMBERS/);
  const run=new CompleteOrderAutomation(input,'http://localhost:3000',{seller:session,members:[{index:0,session},{index:1,session}],settler:session,payee:session});await assert.rejects(run.run(false),/CONFIRMATION_REQUIRED/);assert.equal(reads,0);
});
test('missing seller or member authority stops before any transaction or signing capability is invoked',async()=>{
  const f=await originalAuthorizationFixture('10143');let walletCalls=0;
  const session=(wallet:string)=>({verified:async()=>({subject:'local-role',wallets:[wallet]}),configuration:async()=>({recoveryDeployment:f.deployment}),token:async()=>{walletCalls++;throw Error('UNEXPECTED_TOKEN_USE');}} as unknown as BrowserSession);
  const seller=session(f.seller.address),buyer=session(f.buyer.address),wrong=session(readTestAddress(78));
  for(const missing of ['seller','member'] as const){const run=new CompleteOrderAutomation({payload:f.payload,dataset:f.dataset},'http://localhost:3000',{seller:missing==='seller'?wrong:seller,members:[{index:0,session:buyer},{index:1,session:wrong}],settler:buyer,payee:seller});await assert.rejects(run.run(true),missing==='seller'?/SELLER_AUTHORITY_REQUIRED/:/MEMBER_AUTHORITY_REQUIRED/);await assert.rejects(run.run(true),/RECONCILIATION_REQUIRED/);}
  assert.equal(walletCalls,0);
});

test('unfunded and expired delivery states stop before reserving any wallet operation',async()=>{
  const f=await originalAuthorizationFixture('10143'),before=globalThis.fetch;let walletCalls=0,reservations=0;
  const session=(wallet:string)=>({verified:async()=>({subject:'local-role',wallets:[wallet]}),configuration:async()=>({recoveryDeployment:f.deployment}),token:async()=>'local-only-token',deliverOrder:async()=>{walletCalls++;throw Error('UNEXPECTED_WALLET');}} as unknown as BrowserSession),seller=session(f.seller.address),buyer=session(f.buyer.address),memberOne=session(f.deployment.committee[0]),memberTwo=session(f.deployment.committee[1]);
  try{for(const state of ['UNREGISTERED','FUNDED'] as const){globalThis.fetch=async(input)=>{const url=new URL(String(input));if(url.pathname.startsWith('/api/orders/'))return new Response(JSON.stringify(f.snapshot(state)));reservations++;throw Error('UNEXPECTED_RESERVATION');};
    const run=new CompleteOrderAutomation({payload:f.payload,dataset:f.dataset},'http://localhost:3000',{seller,members:[{index:0,session:memberOne},{index:1,session:memberTwo}],settler:buyer,payee:seller},()=>BigInt(f.payload.intent.deliveryDeadline)+1n);
    await assert.rejects(run.run(true),state==='UNREGISTERED'?/FUNDED_ORDER_REQUIRED/:/DELIVERY_EXPIRED/);
  }}finally{globalThis.fetch=before;}assert.equal(walletCalls,0);assert.equal(reservations,0);
});
