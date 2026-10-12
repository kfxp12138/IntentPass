import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptorSalesRecording as recording} from '../../apps/web/src/generated/adaptor-sales-recording.js';
import {NativeEcdsaAdaptor} from '../../packages/adapters/src/ecdsa-adaptor.js';
import {verifyAdaptorCertificate,type AdaptorTrust} from '../../apps/web/src/services/adaptor-review-experiment.js';
import {adaptorCandidateHash} from '../../packages/protocol/src/adaptor-review.js';
test('the shipped sales replay has valid native pre-signatures and PASS completion at recorded time',async()=>{
  const native=new NativeEcdsaAdaptor(),trust=recording.trust as AdaptorTrust;
  for(const item of recording.cases){
    const c=item.preparation.candidate;
    assert.equal(native.verify(trust.preSignerPublicKey,adaptorCandidateHash(c),c.adaptorPoint,item.preparation.preSignature),true);
    if(item.certificate)assert.equal(await verifyAdaptorCertificate(item.certificate,item.request,trust,native,BigInt(item.certificate.release.evaluatedAt)),true);
    else assert.equal(item.state,'STOPPED');
  }
});
