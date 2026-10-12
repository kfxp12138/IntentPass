import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateReview, contextHash, intentSigningHash, IntentEnvelopeSchema, uint } from '../packages/protocol/src/index.js';
import {EvidenceBundleSchema,createEvidenceSalt,purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';
const vector = JSON.parse(readFileSync('fixtures/dev/hash-vector.json','utf8'));
test('salted evidence separates identical private text while historical v1 encoding stays exact',()=>{
  const text='short private task',legacy={schemaVersion:1,taskText:text,documents:[]},salt=createEvidenceSalt(),other=createEvidenceSalt(),v2={...legacy,schemaVersion:2,salt};
  const oldHash='0x4c0b664244bef5d9c53ac0b249d9d59eb8ac0092d413dc87cdeedef4658f6958';
  assert.equal(purchaseEvidenceHash(legacy),oldHash);assert.notEqual(salt,other);assert.notEqual(purchaseEvidenceHash(v2),oldHash);assert.notEqual(purchaseEvidenceHash(v2),purchaseEvidenceHash({...v2,salt:other}));assert.equal(purchaseEvidenceHash(JSON.parse(JSON.stringify(v2))),purchaseEvidenceHash(v2));
  for(const invalid of [{...legacy,salt},{...v2,salt:'0x'+'0'.repeat(64)},{...v2,salt:'short'},{...v2,schemaVersion:3},{...v2,extra:true}])assert.equal(EvidenceBundleSchema.safeParse(invalid).success,false);
});
test('TypeScript vector remains fixed', () => {
  assert.equal(contextHash(vector.envelope),vector.contextHash);
  assert.equal(intentSigningHash(vector.envelope),vector.signingHash);
  assert.notEqual(vector.contextHash,vector.signingHash);
});
test('each envelope field changes the commitment', () => {
  for(const [key,value] of Object.entries(vector.envelope)) {
    if(key==='schemaVersion' || key==='threshold') continue;
    const changed = typeof value==='string' && value.startsWith('0x') ? value.slice(0,-1)+(value.endsWith('f')?'e':'f') : String(BigInt(String(value))+1n);
    assert.notEqual(contextHash({...vector.envelope,[key]:changed}), vector.contextHash,key);
  }
});
test('domain, chain and verifying contract are bound',()=>{
  assert.notEqual(intentSigningHash({...vector.envelope,chainId:'1'}), vector.signingHash);
  assert.notEqual(intentSigningHash({...vector.envelope,arbiter:'0x'+'f'.repeat(40)}), vector.signingHash);
});
test('reject malformed uint, unsafe numeric JSON and overflow',()=>{
  for(const value of ['-1','1.0','1e3','01',1,2n**256n+'']) assert.equal(uint.safeParse(value).success,false);
  assert.equal(uint.parse('9007199254740993'),'9007199254740993');
});
test('unknown fields and invalid deadlines are rejected',()=>{
  assert.equal(IntentEnvelopeSchema.safeParse({...vector.envelope,calldata:'0x'}).success,false);
  assert.equal(IntentEnvelopeSchema.safeParse({...vector.envelope,settlementDeadline:vector.envelope.deliveryDeadline}).success,false);
});
test('all 27 semantic combinations obey necessary-condition rules',()=>{
  const values=['SUPPORTED','INSUFFICIENT','CONTRADICTED'];
  for(const service of values) for(const purpose of values) for(const provenance of values) {
    const result=[service,purpose,provenance];
    assert.equal(aggregateReview({service,purpose,provenance}),result.includes('CONTRADICTED')?'REJECT':result.includes('INSUFFICIENT')?'ABSTAIN':'PASS');
  }
});
test('malformed or incomplete semantics abstain',()=>{
  for(const value of [null,{}, {service:'SUPPORTED'},{service:'SUPPORTED',purpose:'SUPPORTED',provenance:'SUPPORTED',extra:true}]) assert.equal(aggregateReview(value),'ABSTAIN');
});
