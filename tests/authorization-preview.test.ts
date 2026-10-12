import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {authorizationDeadline,grantPreview,preflightPreview} from '../apps/web/src/authorization-preview.js';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
// Schema-only display fixtures: these are not signed PASS evidence or real judgments.
function fixture(){
  const v=JSON.parse(readFileSync('fixtures/dev/authorization-vector.json','utf8')),intent=JSON.parse(readFileSync('fixtures/dev/hash-vector.json','utf8')).envelope;
  const signature='0x'+'1'.repeat(130),answer={type:'choice',choice:'SUPPORTED',confidence:1,probabilities:{SUPPORTED:1,CONTRADICTED:0,INSUFFICIENT:0}};
  const draft={status:'DRAFT',modelId:'LOCAL_DISPLAY_FIXTURE',citations:[],policy:v.policy,intent,quote:{...v.quote,signature},evidence:{schemaVersion:1,taskText:'LOCAL_DISPLAY_FIXTURE',documents:[]}};
  const review={source:'JEV',decision:'PASS',modelId:v.receipt.modelId,questionConfigHash:v.receipt.questionConfigHash,executable:true,receipt:{...v.receipt,signature},answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:1,output_tokens:1}};
  return {draft,review,grant:v.grant};
}
test('authorization UI duration is integer bounded and cannot extend quote, receipt or delivery validity',()=>{
  const {draft,review}=fixture();
  assert.equal(authorizationDeadline(draft,review,'120',1000n),'1120');
  assert.equal(authorizationDeadline({...draft,quote:{...draft.quote,expiresAt:'1100'}},review,'120',1000n),'1100');
  assert.equal(authorizationDeadline(draft,{...review,receipt:{...review.receipt,expiresAt:'1050'}},'120',1000n),'1050');
  assert.equal(authorizationDeadline({...draft,intent:{...draft.intent,deliveryDeadline:'1030'}},review,'120',1000n),'1030');
  for(const duration of ['0','301','1e2','120.0','-1',' 120','001','Infinity'])assert.throws(()=>authorizationDeadline(draft,review,duration,1000n),/AUTHORIZATION_WINDOW_INVALID/);
  assert.throws(()=>authorizationDeadline(draft,review,'120',-1n));
  assert.throws(()=>authorizationDeadline(draft,{...review,receipt:{...review.receipt,expiresAt:'1000'}},'120',1000n),/AUTHORIZATION_EXPIRED/);
  const {receipt,...base}=review;assert.throws(()=>authorizationDeadline(draft,{...base,executable:false},'120',1000n),/EXECUTABLE_PASS_REQUIRED/);
});
test('authorization preview preserves uint256 amounts and rejects claiming latest or inconsistent preflight as finalized',()=>{
  const {grant}=fixture(),maximum=(2n**256n-1n).toString();
  const text=grantPreview({...grant,amount:maximum,deadline:maximum});assert.ok(text.includes(`准确金额：${maximum}`));assert.ok(text.includes(`${maximum} 秒（Unix 时间）`));
  const snapshot={chainId:grant.chainId,arbiter:grant.arbiter,asset:grant.asset,buyer:grant.owner,orderId:grant.orderId,contextHash:grant.contextHash,nonce:grant.nonce,amount:grant.amount,deadline:'1500',state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:true,balance:'100',allowance:grant.amount,blockers:[],block:{number:'100',hash:h(1),timestamp:'1000',finality:'finalized'},canSubmitPayment:false};
  assert.ok(preflightPreview(snapshot).includes('已最终确认区块：100'));
  assert.throws(()=>preflightPreview({...snapshot,block:{...snapshot.block,finality:'latest'}}),/PREFLIGHT_FINALITY_REQUIRED/);
  assert.throws(()=>preflightPreview({...snapshot,consumed:true,blockers:[]}));
});
