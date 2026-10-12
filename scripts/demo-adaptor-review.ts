import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {generatePrivateKey} from 'viem/accounts';
import {keccak256,toHex} from 'viem';
import {AdaptorReviewExperiment,verifyAdaptorCertificate} from '../apps/web/src/services/adaptor-review-experiment.js';
import {NativeEcdsaAdaptor} from '../packages/adapters/src/ecdsa-adaptor.js';
import {AdaptorSessionStore} from '../packages/storage/src/adaptor-session-store.js';
import {ReviewStore} from '../packages/storage/src/review-store.js';
import {applicationReviewSmokeCases} from './application-review-smoke.js';
import {adaptorSource} from './adaptor-runtime.js';
import type {JevResult} from '../packages/adapters/src/jev-review.js';
import {parseSalesCsv,sampleSalesCsv,salesTaskText} from '../packages/protocol/src/sales-brief.js';
import {createReport} from '../packages/protocol/src/report.js';

// Explicit synthetic provider. No .env, remote model call, wallet or transaction.
const sales=process.argv[2]==='--sales';
if(process.argv.length!==(sales?3:2))throw Error('ADAPTOR_DEMO_ARGUMENTS_INVALID');
const directory=mkdtempSync(join(tmpdir(),'intentpass-adaptor-demo-'));
const store=new AdaptorSessionStore(join(directory,'sessions.db')),journal=new ReviewStore(join(directory,'reviews.db'));
let flow:AdaptorReviewExperiment|undefined;
try{
  const source=parseSalesCsv(sampleSalesCsv,'sample'),report=createReport(source.dataset);
  const now=BigInt(Math.floor(Date.now()/1000)),f=await applicationReviewSmokeCases(now,sales?{datasetHash:report.datasetHash as `0x${string}`,taskText:salesTaskText(source,report.datasetHash)}:undefined),native=new NativeEcdsaAdaptor();
  let calls=0,current:'SUPPORTED'|'INSUFFICIENT'|'CONTRADICTED'='SUPPORTED';
  const jev={model:'jev-1.13.0',evaluate:async():Promise<JevResult>=>{calls++;const a={type:'choice' as const,choice:current,confidence:1,probabilities:{SUPPORTED:current==='SUPPORTED'?1:0,CONTRADICTED:current==='CONTRADICTED'?1:0,INSUFFICIENT:current==='INSUFFICIENT'?1:0}};const supported={type:'choice' as const,choice:'SUPPORTED' as const,confidence:1,probabilities:{SUPPORTED:1,CONTRADICTED:0,INSUFFICIENT:0}};return {model:'jev-1.13.0',answers:{service:sales?supported:a,purpose:a,provenance:sales?supported:a},usage:{input_tokens:0,output_tokens:0}};}};
  flow=new AdaptorReviewExperiment({preSignerKey:generatePrivateKey(),attestorKey:generatePrivateKey(),jev,deployment:f.deployment,minConfidence:.9,reviewJournal:journal,store,native,clock:()=>now});
  const cases=[];
  for(const item of f.cases){
    current=item.expected==='PASS'?'SUPPORTED':item.expected==='REJECT'?'CONTRADICTED':'INSUFFICIENT';
    const before=calls,s=flow.prepare(item.input,f.principal);assert.equal(calls,before);
    const done=await flow.complete(s.candidate.sessionId,item.input,f.principal);
    assert.equal(done.review?.decision,item.expected);
    const passed=done.state==='COMPLETE';assert.equal(passed,item.expected==='PASS');
    const checks:{[key:string]:boolean}={preparedBeforeProvider:true,expectedDecision:done.review?.decision===item.expected,expectedCompletion:passed===(item.expected==='PASS')};
    if(done.certificate){
      const p=done.certificate;checks.signatureAndResultBinding=await verifyAdaptorCertificate(p,item.input,flow.trust,native,now);
      checks.changedOrderRejected=!await verifyAdaptorCertificate({...p,candidate:{...p.candidate,orderId:keccak256(toHex('changed order'))}},item.input,flow.trust,native,now);
      checks.changedResultRejected=!await verifyAdaptorCertificate({...p,release:{...p.release,evaluationHash:keccak256(toHex('changed result'))}},item.input,flow.trust,native,now);
      checks.missingReleaseRejected=!await verifyAdaptorCertificate({...p,releaseSignature:undefined},item.input,flow.trust,native,now);
      await flow.acceptOnce(s.candidate.sessionId,item.input,f.principal);let replayRejected=false;try{await flow.acceptOnce(s.candidate.sessionId,item.input,f.principal);}catch{replayRejected=true;}checks.localReplayRejected=replayRejected;
    }else checks.noCompletedSignature=done.certificate===undefined;
    assert.ok(Object.values(checks).every(Boolean));cases.push({id:item.id,request:item.input,preparation:s,evaluation:done.review,decision:done.review?.decision,state:done.state,checks,certificate:done.certificate??null});
  }
  const evidence={schemaVersion:1,status:'PASS',scope:'LOCAL_REAL_ADAPTOR_CRYPTO_SYNTHETIC_JEV',createdAt:new Date().toISOString(),...(sales?{scenario:'commercial-sales-report',sales:{csv:source.csv,report}}:{}),source:adaptorSource,trust:flow.trust,syntheticProviderCalls:calls,remoteModelCalls:0,transactions:0,cases,limitations:['Generated local test signing keys and synthetic JEV responses.','Current Privy signer, deployed escrow and real financial workflow unchanged.','Both the completed signature and signed result-release statement are required.','The local review service is the attestor; this is not a JEV-provider signature or proof of model correctness.','Pending witnesses exist only in memory; loss blocks the original session.','Local replay consumption is not a chain grant nonce.']};
  const output=resolve('artifacts/acceptance/adaptor-prototype',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(output,{recursive:true});
  const path=join(output,'demo.json');writeFileSync(path,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:evidence.status,scope:evidence.scope,cases:cases.map(c=>({decision:c.decision,state:c.state,checks:c.checks})),evidence:path,remoteModelCalls:0,transactions:0},null,2));
}finally{flow?.dispose();store.close();journal.close();rmSync(directory,{recursive:true,force:true});}
