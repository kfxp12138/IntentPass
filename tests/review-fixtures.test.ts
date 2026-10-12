import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
test('frozen dev/holdout inputs retain 12/24 cases and independent expected-label counts',()=>{
  const manifest=JSON.parse(readFileSync('fixtures/review-manifest.json','utf8')),seen=new Set<string>();
  for(const file of manifest.files){const content=readFileSync(file.path,'utf8');assert.equal(createHash('sha256').update(content).digest('hex'),file.sha256);const cases=JSON.parse(content);assert.equal(cases.length,file.path.includes('/holdout/')?24:12);
    for(const decision of ['PASS','ABSTAIN','REJECT'])assert.equal(cases.filter((c:{expected:string})=>c.expected===decision).length,file.path.includes('/holdout/')?8:4);
    for(const c of cases){assert.equal(seen.has(c.id),false);seen.add(c.id);assert.equal('expected' in c.state,false);assert.equal('rationale' in c.state,false);assert.equal('id' in c.state,false);assert.equal(c.state.policy.purpose,'commercial');assert.deepEqual(c.state.policy.metrics,['count','sum','min','max']);}
  }
});
