import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {applicationReviewSmokeCases} from '../scripts/application-review-smoke.js';
import {verifyQuoteSignature} from '../packages/protocol/src/typed-data.js';
import {purchaseEvidenceHash} from '../packages/protocol/src/review-evidence.js';

test('application live smoke uses signed new report quotes while preserving the same fixed buyer policy',async()=>{
  const fixture=await applicationReviewSmokeCases(1000n),again=await applicationReviewSmokeCases(1000n);
  assert.equal(fixture.cases.length,3);assert.deepEqual(fixture.cases.map(c=>c.expected),['PASS','ABSTAIN','REJECT']);
  for(const item of fixture.cases){assert.ok(await verifyQuoteSignature(item.input.quote,{chainId:fixture.deployment.chainId,arbiter:fixture.deployment.arbiter}));assert.deepEqual(item.input.policy,fixture.cases[0].input.policy);assert.equal(item.input.intent.price,'10');assert.equal(item.input.intent.bond,'0');assert.equal(item.input.intent.purchaseEvidenceCommitment,purchaseEvidenceHash(item.input.evidence));assert.equal(item.input.evidence.documents[0].text,item.input.quote.serviceTerms);}
  assert.match(fixture.cases[1].input.quote.serviceTerms,/No license or permission for use of the resulting report is stated/);assert.match(fixture.cases[2].input.quote.serviceTerms,/Commercial use.*explicitly prohibited/);
  assert.notEqual(fixture.deployment.reviewer,again.deployment.reviewer);assert.notEqual(fixture.cases[0].input.intent.orderId,again.cases[0].input.intent.orderId);
});
test('recorded application smoke refuses a repeat before loading environment or writing evidence',()=>{
  const directory=mkdtempSync(join(tmpdir(),'intentpass-smoke-cli-test-')),path=join(directory,'artifacts/acceptance/application-review-smoke.json'),original='{"status":"IN_PROGRESS","providerRequests":1}\n';
  try{mkdirSync(join(directory,'artifacts/acceptance'),{recursive:true});writeFileSync(path,original);writeFileSync(join(directory,'.env'),'invalid private config, must not be read');
    const result=spawnSync(process.execPath,['--experimental-sqlite','--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('scripts/smoke-review.ts')],{cwd:directory,encoding:'utf8',timeout:15000});
    assert.equal(result.status,1);assert.match(result.stderr,/APPLICATION_SMOKE_ALREADY_RECORDED/);assert.equal(result.stdout,'');assert.equal(readFileSync(path,'utf8'),original);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
