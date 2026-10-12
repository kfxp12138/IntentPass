import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createApp} from '../apps/web/src/server.js';
import {configuredWorkflowApi} from '../apps/web/src/workflow-api.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';
import {GeneralAutomationProfileSchema,generalProfileHash} from '../packages/automation/src/general-profile.js';
import {writePrivateServiceJsonOnce} from '../scripts/create-privy-service-wallets.js';
const address=`0x${'11'.repeat(20)}` as `0x${string}`;
test('general task API authenticates owners, isolates jobs and output, and exposes no runtime credentials',async()=>{
  const directory=mkdtempSync(resolve(realpathSync(tmpdir()),'intentpass-workflow-api-')),browser={configuration:{privyAppId:'local-test',meraRpId:null,recoveryDeployment:null},auth:{authenticate:async(token:string)=>{if(!['first','second'].includes(token))throw new AuthenticationRejected();return {subject:token,wallets:[address]};}}};
  const api=configuredWorkflowApi({AUTOMATION_DATA_DIRECTORY:directory},browser)!,app=await createApp({dependencyPrebundling:false,workflowApi:api});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const bound=app.server.address();assert.ok(bound&&typeof bound==='object');
  const call=(body:unknown,token='first')=>fetch(`http://127.0.0.1:${bound.port}/api/automation/workflows`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await call({action:'list'},'invalid')).status,401);
    const submitted=await (await call({action:'submit',submission:{idempotencyKey:'shared-key',workflow:{name:'自动报告',version:'1',steps:[{id:'report',handler:'intentpass.report',effect:'READ'}]},input:{dataset:[1,5,9]},runAt:0}})).json();
    assert.equal(typeof submitted.id,'string');await api.worker.tick();
    const state=await (await call({action:'list'})).json();assert.equal(state.mode,'general');assert.deepEqual(state.limits,{jobCount:null,amountPerOrder:null,expiresAt:null});assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].status,'SUCCEEDED');assert.equal(JSON.stringify(state).includes('authorizationPrivateKey'),false);
    const other=await (await call({action:'list'},'second')).json();assert.equal(other.jobs.length,0);
    assert.equal((await call({action:'output',jobId:submitted.id},'second')).status,503);
    const output=await (await call({action:'output',jobId:submitted.id})).json();assert.equal(output.outputs.report.sum,'15');
    const a=(n:string)=>`0x${n.repeat(40)}`,profile=GeneralAutomationProfileSchema.parse({version:1,mode:'general',enabled:true,name:'Local fixture',buyer:address,seller:a('2'),deployment:{chainId:'10143',arbiter:a('3'),asset:a('4'),reviewer:a('5'),committee:[address,a('2'),a('6')],executor:a('7')}});
    const profileHash=generalProfileHash(profile),planId='d25b0906-9d26-4cb7-995f-f4d48d3ecbc9';
    writePrivateServiceJsonOnce(resolve(directory,'runtime.json'),{profile,profileHash,actors:[{role:'buyer',walletId:'buyer-wallet',signerId:'buyer-signer',policyId:'buyer-policy',subject:'process-buyer-role-not-privy-user',authorizationPrivateKey:'x'.repeat(32)},{role:'seller',walletId:'seller-wallet',signerId:'seller-signer',policyId:'seller-policy',subject:'process-seller-role',authorizationPrivateKey:'y'.repeat(32)}],walletDelegationApproved:false,localPlaintextProcessingApproved:false});
    assert.equal((await(await call({action:'context'})).json()).code,'WORKFLOW_BUYER_CONTEXT_UNAVAILABLE');
    const {mkdirSync}=await import('node:fs');mkdirSync(resolve(directory,'connection-consents'),{mode:0o700});
    writePrivateServiceJsonOnce(resolve(directory,'connection-plan.json'),{version:1,planId,profileHash,mode:'general',chainId:'10143',asset:profile.deployment.asset,arbiter:profile.deployment.arbiter,amountLimit:null,expiresAt:null,roles:[{role:'buyer',address,walletId:'buyer-wallet',signerId:'buyer-signer',policyId:'buyer-policy'},{role:'seller',address:profile.seller,walletId:'seller-wallet',signerId:'seller-signer',policyId:'seller-policy'}]});
    writePrivateServiceJsonOnce(resolve(directory,'connection-consents/buyer.json'),{planId,profileHash,role:'buyer',confirmGeneralAuthority:true,localPlaintextProcessingApproved:true,subject:'first',address});
    const context=await(await call({action:'context'})).json();assert.equal(context.status,'CONFIGURED_CONTEXT');assert.equal(context.buyer,address);assert.equal(context.asset,profile.deployment.asset);assert.equal(context.configurationOnly,true);assert.ok(!/authorizationPrivateKey|walletId|signerId|subject/.test(JSON.stringify(context)));
    const denied=await(await call({action:'context'},'second')).json();assert.equal(denied.code,'WORKFLOW_BUYER_CONTEXT_UNAVAILABLE');
  }finally{await app.close();await api.close();rmSync(directory,{recursive:true,force:true});}
});
