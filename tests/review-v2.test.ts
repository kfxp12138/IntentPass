import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {JevHttp,questionConfigHash,reviewQuestions,reviewQuestionsV2,type JevResult} from '../packages/adapters/src/jev-review.js';
import {loadReviewPolicy,loadActivatedReviewPolicy} from '../packages/adapters/src/review-policy.js';
import {reviewV2Cases} from '../scripts/review-v2-cases.js';
import {evaluationPlan,runSemanticEvaluation,evaluationSummary,evaluationSha,ruleOnlyComparison} from '../scripts/review-evaluation.js';
import {calibrateDevelopment} from '../scripts/review-calibration.js';
import {purchaseEvidenceFixture} from './support/purchase-evidence.js';
import {ReviewService} from '../apps/web/src/services/review.js';
import {ReviewRequestSchema} from '../packages/protocol/src/draft.js';
import {committeeHash,receiptTypedData} from '../packages/protocol/src/index.js';
import {prepareAuthorization,AuthorizationRuleSchema} from '../packages/capsule/src/authorization.js';
import type {Address} from 'viem';
const model='jev-1.13.0';
function judgment(choice:'SUPPORTED'|'INSUFFICIENT'|'CONTRADICTED'):JevResult{const answer={type:'choice' as const,choice,confidence:1,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0}};return {model,answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:10,output_tokens:3}};}
test('version 1 retains its historical hash and HTTP questions; version 2 is explicit and cannot alias it',async()=>{
  assert.equal(questionConfigHash(.75),'0x7263f2a1bd44756e34e8ced799e5549efe91126484de4bfd2bcf41d5316225e5');assert.notEqual(questionConfigHash(.75,2),questionConfigHash(.75));
  const sent:unknown[]=[];const transport:typeof fetch=async(_url,init)=>{sent.push(JSON.parse(String(init?.body)).questions);return new Response(JSON.stringify(judgment('SUPPORTED')));};
  await new JevHttp('local-only-test-key',model,transport).evaluate({});await new JevHttp('local-only-test-key',model,transport,2).evaluate({});assert.deepEqual(sent,[reviewQuestions,reviewQuestionsV2]);assert.throws(()=>new JevHttp('local-only',model,transport,3 as 2),/QUESTION_VERSION_INVALID/);
});
test('new version cohorts are balanced disjoint and include absence and contradiction without embedding labels in states',()=>{
  const {dev,holdout}=reviewV2Cases();assert.equal(dev.length,12);assert.equal(holdout.length,24);
  for(const [cases,count] of [[dev,4],[holdout,8]] as const)for(const label of ['PASS','ABSTAIN','REJECT'])assert.equal(cases.filter(c=>c.expected===label).length,count);
  const hashes=new Set(dev.map(c=>evaluationSha(JSON.stringify(c.state))));for(const c of holdout){assert.equal(hashes.has(evaluationSha(JSON.stringify(c.state))),false);assert.equal('expected'in c.state,false);assert.equal('rationale'in c.state,false);}
  assert.ok(holdout.some(c=>c.expected==='ABSTAIN'&&c.state.documents.length===0));assert.ok(holdout.some(c=>c.state.documents.some(d=>d.text.includes('Untrusted embedded command'))));
});
test('version 2 calibration and policy loading bind their own fixture and hash, rejecting version and question drift',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'intentpass-v2-policy-test-')),cases=reviewV2Cases().dev,text=JSON.stringify(cases),fixturePath='fixtures/review-v2/dev.json';
  try{mkdirSync(join(directory,'fixtures/review-v2'),{recursive:true});writeFileSync(join(directory,fixturePath),text);writeFileSync(join(directory,'fixtures/review-v2/manifest.json'),JSON.stringify({questionVersion:2,candidateQuestionConfigHash:questionConfigHash(.9,2),files:[{path:fixturePath,count:12,sha256:evaluationSha(text)}]}));
    const plan=evaluationPlan(cases,'dev');let index=0;const results=await runSemanticEvaluation(plan,{model,questionVersion:2,evaluate:async()=>judgment(plan[index++].expected==='PASS'?'SUPPORTED':plan[index-1].expected==='REJECT'?'CONTRADICTED':'INSUFFICIENT')},.9);
    const report={split:'dev',questionVersion:2,model,minConfidence:.9,questionConfigHash:questionConfigHash(.9,2),fixtureSha256:evaluationSha(text),startedAt:'2026-10-02T00:00:00.000Z',endedAt:'2026-10-02T00:01:00.000Z',scope:'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',status:'PASS',confidenceRule:'DEVELOPMENT_CANDIDATE_NOT_PRODUCTION_FROZEN',ruleOnly:ruleOnlyComparison(plan),summary:evaluationSummary(results,12),results,blocked:null};
    assert.throws(()=>calibrateDevelopment(report,text,evaluationSha(text)),/REPORT_INVALID/);const calibrated=calibrateDevelopment(report,text,evaluationSha(text),2),sourcePath='artifacts/acceptance/review-v2/dev.json',reportPath='artifacts/acceptance/review-v2/dev-calibrated.json',sourceText=JSON.stringify(report);mkdirSync(join(directory,'artifacts/acceptance/review-v2'),{recursive:true});writeFileSync(join(directory,sourcePath),sourceText);calibrated.calibration={...calibrated.calibration,sourceReportPath:sourcePath,sourceReportSha256:evaluationSha(sourceText)} as typeof calibrated.calibration;const bytes=JSON.stringify(calibrated);writeFileSync(join(directory,reportPath),bytes);
    const policy={version:2,questionVersion:2,model,minConfidence:calibrated.minConfidence,questionConfigHash:calibrated.questionConfigHash,developmentReportPath:reportPath,developmentReportSha256:evaluationSha(bytes)},path=join(directory,'policy.json');writeFileSync(path,JSON.stringify(policy));assert.equal(loadReviewPolicy(path,model,directory).questionVersion,2);
    for(const changed of [{...policy,questionVersion:1},{...policy,questionConfigHash:questionConfigHash(policy.minConfidence)}]){writeFileSync(path,JSON.stringify(changed));assert.throws(()=>loadReviewPolicy(path,model,directory),/POLICY_INVALID/);}
    const forged={...calibrated,minConfidence:.5,questionConfigHash:questionConfigHash(.5,2)},forgedText=JSON.stringify(forged);writeFileSync(join(directory,reportPath),forgedText);writeFileSync(path,JSON.stringify({...policy,minConfidence:.5,questionConfigHash:forged.questionConfigHash,developmentReportSha256:evaluationSha(forgedText)}));assert.throws(()=>loadReviewPolicy(path,model,directory),/POLICY_INVALID/);
    assert.equal(loadReviewPolicy('artifacts/acceptance/review-policy.json',model).questionVersion,undefined);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('browser and grant preparation accept explicitly bound version 2 receipts but cannot reinterpret them as version 1',async()=>{
  const f=await purchaseEvidenceFixture(),rule={model,minConfidence:.9,questionConfigHash:questionConfigHash(.9,2),questionVersion:2 as const};f.configuration.purchaseRule=rule;
  const d=f.deployment,deployment={chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,reviewer:d.reviewer as Address,gate:d.asset as Address,committeeHash:committeeHash(d.committee)};
  const service=new ReviewService({model,questionVersion:2,evaluate:async()=>judgment('SUPPORTED')},deployment,.9,{address:f.reviewer.address,sign:(r,domain)=>f.reviewer.signTypedData(receiptTypedData(r,domain))},f.clock);f.port.review=input=>service.review(input,f.principal());
  await f.flow.catalog();await f.flow.propose([f.entry.quote.quoteId]);const result=await f.flow.review();assert.ok(result.source==='JEV'&&result.executable);assert.equal(result.questionConfigHash,rule.questionConfigHash);const prepared=await f.flow.prepare('0','1200');assert.equal(prepared.payload.receipt.questionConfigHash,rule.questionConfigHash);
  const draft=f.flow.draft!,request=ReviewRequestSchema.parse({policy:draft.policy,intent:draft.intent,quote:draft.quote,evidence:draft.evidence}),context={authenticatedWallets:f.principal().wallets,deployment:d,rule:{model,minConfidence:.9,questionConfigHash:questionConfigHash(.9)},now:1000n};await assert.rejects(prepareAuthorization({request,review:result,nonce:'0',deadline:'1200'},context),/RULE_MISMATCH/);assert.throws(()=>AuthorizationRuleSchema.parse({...rule,questionVersion:3}));
});
test('recorded version 2 development refuses repeat before reading a private environment',()=>{
  const directory=mkdtempSync(join(tmpdir(),'intentpass-v2-cli-test-')),text=JSON.stringify(reviewV2Cases().dev),path=join(directory,'artifacts/acceptance/review-v2/dev.json'),original='{"status":"NOT_STARTED","runState":"IN_PROGRESS"}\n';
  try{mkdirSync(join(directory,'fixtures/review-v2'),{recursive:true});mkdirSync(join(directory,'artifacts/acceptance/review-v2'),{recursive:true});writeFileSync(join(directory,'fixtures/review-v2/dev.json'),text);writeFileSync(join(directory,'fixtures/review-v2/manifest.json'),JSON.stringify({questionVersion:2,candidateQuestionConfigHash:questionConfigHash(.9,2),files:[{path:'fixtures/review-v2/dev.json',count:12,sha256:evaluationSha(text)}]}));writeFileSync(path,original);writeFileSync(join(directory,'.env'),'invalid private configuration');
    const result=spawnSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('scripts/eval-review-v2.ts'),'--dev'],{cwd:directory,encoding:'utf8',timeout:15000});assert.equal(result.status,1);assert.match(result.stderr,/V2_RUN_ALREADY_RECORDED/);assert.equal(readFileSync(path,'utf8'),original);assert.equal(result.stdout,'');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('version 2 application activation requires PASS holdout with no false PASS and all nine critical judgments',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'intentpass-v2-activation-test-')),cases=reviewV2Cases(),base='artifacts/acceptance/review-v2',fixtureBase='fixtures/review-v2';
  try{mkdirSync(join(directory,base),{recursive:true});mkdirSync(join(directory,fixtureBase),{recursive:true});const entries=Object.entries(cases).map(([split,rows])=>{const path=`${fixtureBase}/${split}.json`,text=JSON.stringify(rows);writeFileSync(join(directory,path),text);return {path,count:rows.length,sha256:evaluationSha(text)};});writeFileSync(join(directory,`${fixtureBase}/manifest.json`),JSON.stringify({questionVersion:2,candidateQuestionConfigHash:questionConfigHash(.9,2),files:entries}));
    let threshold=.9;
    async function report(mode:'dev'|'holdout'|'critical',bad=false,missedCaseId?:string){const source=mode==='holdout'?cases.holdout:cases.dev,plan=evaluationPlan(source,mode);let i=0;const rows=await runSemanticEvaluation(plan,{model,questionVersion:2,evaluate:async()=>{const c=plan[i++];if(c.id===missedCaseId)return judgment('INSUFFICIENT');return judgment(bad&&(mode==='critical'?i===2:c.id==='holdout-009')?(mode==='critical'?'INSUFFICIENT':'SUPPORTED'):c.expected==='PASS'?'SUPPORTED':c.expected==='ABSTAIN'?'INSUFFICIENT':'CONTRADICTED');}},threshold),summary=evaluationSummary(rows,plan.length);return {split:mode,questionVersion:2,model,minConfidence:threshold,questionConfigHash:questionConfigHash(threshold,2),fixtureSha256:entries.find(e=>e.path.endsWith(`${mode==='holdout'?'holdout':'dev'}.json`))!.sha256,startedAt:mode==='dev'?'2026-10-02T00:00:00.000Z':'2026-10-02T00:02:00.000Z',endedAt:mode==='dev'?'2026-10-02T00:01:00.000Z':'2026-10-02T00:03:00.000Z',scope:'REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION',confidenceRule:mode==='dev'?'DEVELOPMENT_CANDIDATE_NOT_PRODUCTION_FROZEN':'FROZEN_DEVELOPMENT_RULE',status:summary.matches===plan.length?'PASS':'FAIL',ruleOnly:ruleOnlyComparison(plan),summary,results:rows,blocked:null};}
    const dev=await report('dev'),sourcePath=`${base}/dev.json`,sourceText=JSON.stringify(dev);writeFileSync(join(directory,sourcePath),sourceText);const fixtureText=readFileSync(join(directory,`${fixtureBase}/dev.json`),'utf8'),calibrated=calibrateDevelopment(dev,fixtureText,evaluationSha(fixtureText),2);calibrated.calibration={...calibrated.calibration,sourceReportPath:sourcePath,sourceReportSha256:evaluationSha(sourceText)} as typeof calibrated.calibration;threshold=calibrated.minConfidence;const devPath=`${base}/dev-calibrated.json`,devText=JSON.stringify(calibrated);writeFileSync(join(directory,devPath),devText);const path=join(directory,`${base}/policy.json`);writeFileSync(path,JSON.stringify({version:2,questionVersion:2,model,minConfidence:threshold,questionConfigHash:questionConfigHash(threshold,2),developmentReportPath:devPath,developmentReportSha256:evaluationSha(devText)}));
    writeFileSync(join(directory,`${base}/holdout.json`),JSON.stringify(await report('holdout')));writeFileSync(join(directory,`${base}/critical.json`),JSON.stringify(await report('critical',true)));assert.throws(()=>loadActivatedReviewPolicy(path,model,directory),/ACTIVATION_REQUIRED/);
    writeFileSync(join(directory,`${base}/critical.json`),JSON.stringify(await report('critical')));assert.equal(loadActivatedReviewPolicy(path,model,directory).questionVersion,2);
    const candidateRule=loadReviewPolicy(path,model,directory);
    // Both reports honestly describe a complete 23/24 holdout with no false
    // permission. Development remains usable as a candidate, not as activation.
    for(const expected of ['PASS','REJECT'] as const){
      const missedCase=cases.holdout.find(c=>c.expected===expected)!;
      const failed=await report('holdout',false,missedCase.id);
      assert.equal(failed.status,'FAIL');assert.deepEqual(failed.summary,{planned:24,attempted:24,evaluated:24,errors:0,matches:23,falsePass:0});
      writeFileSync(join(directory,`${base}/holdout.json`),JSON.stringify(failed));
      assert.deepEqual(loadReviewPolicy(path,model,directory),candidateRule);
      assert.throws(()=>loadActivatedReviewPolicy(path,model,directory),/ACTIVATION_REQUIRED/);
      // Changing only the verdict cannot hide the mismatched raw judgment.
      writeFileSync(join(directory,`${base}/holdout.json`),JSON.stringify({...failed,status:'PASS'}));
      assert.throws(()=>loadActivatedReviewPolicy(path,model,directory),/ACTIVATION_REQUIRED/);
    }
    writeFileSync(join(directory,`${base}/holdout.json`),JSON.stringify(await report('holdout')));assert.deepEqual(loadActivatedReviewPolicy(path,model,directory),candidateRule);
    writeFileSync(join(directory,`${base}/holdout.json`),JSON.stringify(await report('holdout',true)));assert.throws(()=>loadActivatedReviewPolicy(path,model,directory),/ACTIVATION_REQUIRED/);
    assert.deepEqual(loadActivatedReviewPolicy('artifacts/acceptance/review-policy.json',model),loadReviewPolicy('artifacts/acceptance/review-policy.json',model));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('competing application smoke processes atomically reserve one report even when the preliminary existence check loses its race',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'intentpass-v2-smoke-race-')),counter=join(directory,'local-fetch-count.txt'),hook=join(directory,'local-fetch-hook.mjs');
  try{
    for(const path of ['fixtures/review-v2/manifest.json','fixtures/review-v2/dev.json','fixtures/review-v2/holdout.json','artifacts/acceptance/review-v2/dev.json','artifacts/acceptance/review-v2/dev-calibrated.json','artifacts/acceptance/review-v2/policy.json']){mkdirSync(join(directory,path.split('/').slice(0,-1).join('/')),{recursive:true});copyFileSync(path,join(directory,path));}
    writeFileSync(join(directory,'.env'),'TYPESAFE_API_KEY=local-only-test-key\nJEV_MODEL=jev-1.13.0\n');
    writeFileSync(hook,`import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const exists=fs.existsSync,exec=cp.execFileSync;
fs.existsSync=p=>String(p)==='artifacts/acceptance/review-v2/application-smoke.json'?false:exists(p);
cp.execFileSync=(file,args,...rest)=>file==='git'?(args[0]==='rev-parse'?'local-test-commit\\n':'?? local-test-double\\n'):exec(file,args,...rest);
syncBuiltinESMExports();
globalThis.fetch=async(_url,init)=>{fs.appendFileSync(${JSON.stringify(counter)},'request\\n');const body=JSON.parse(String(init.body)),text=body.state.currentQuote.serviceTerms;let purpose='SUPPORTED';if(text.includes('No license or permission for use of the resulting report is stated'))purpose='INSUFFICIENT';if(text.includes('explicitly prohibited'))purpose='CONTRADICTED';const answer=c=>({type:'choice',choice:c,confidence:1,probabilities:{SUPPORTED:c==='SUPPORTED'?1:0,INSUFFICIENT:c==='INSUFFICIENT'?1:0,CONTRADICTED:c==='CONTRADICTED'?1:0}});return new Response(JSON.stringify({model:body.model,answers:{service:answer('SUPPORTED'),purpose:answer(purpose),provenance:answer('SUPPORTED')},usage:{input_tokens:0,output_tokens:0}}));};
`);
    function run(){return new Promise<{code:number|null;stdout:string;stderr:string}>((ready,reject)=>{const child=spawn(process.execPath,['--experimental-sqlite','--import',resolve('node_modules/tsx/dist/loader.mjs'),'--import',hook,resolve('scripts/smoke-review.ts'),'--v2'],{cwd:directory,env:{...process.env,TYPESAFE_API_KEY:'local-only-test-key',JEV_MODEL:model}});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('LOCAL_SMOKE_RACE_TIMEOUT'));},15000);child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);ready({code,stdout,stderr});});});}
    const results=await Promise.all([run(),run()]);assert.deepEqual(results.map(r=>r.code).sort(),[0,1]);assert.equal(readFileSync(counter,'utf8').trim().split('\n').length,3);const original=JSON.parse(readFileSync(join(directory,'artifacts/acceptance/review-v2/application-smoke.json'),'utf8'));assert.equal(original.providerRequests,3);assert.equal(original.status,'PASS');assert.ok(results.some(r=>r.stderr.includes('APPLICATION_SMOKE_RESERVATION_FAILED')));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
