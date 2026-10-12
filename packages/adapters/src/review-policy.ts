import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {JevResponseSchema,aggregateJev,questionConfigHash,type ReviewQuestionVersion} from './jev-review.js';
import {calibrateDevelopment} from './review-development.js';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const read=(path:string)=>{const stat=statSync(path);if(!stat.isFile()||stat.size>4000000)throw new Error('REVIEW_POLICY_INVALID');return readFileSync(path,'utf8');};
const fields={model:z.string().regex(/^jev-\d+\.\d+\.\d+$/),minConfidence:z.number().min(0).max(1),questionConfigHash:z.string(),developmentReportPath:z.string().min(1),developmentReportSha256:z.string().regex(/^[a-f0-9]{64}$/)};
const PolicySchema=z.discriminatedUnion('version',[z.object({version:z.literal(1),...fields}).strict(),z.object({version:z.literal(2),questionVersion:z.literal(2),...fields}).strict()]);
/** Checks a trusted operator-supplied report's integrity and internal results, not provenance attestation. */
export function loadReviewPolicy(path:string,model:string,root=process.cwd()):{model:string;minConfidence:number;questionConfigHash:string;questionVersion?:ReviewQuestionVersion} {
  try {
    const resource=(value:string)=>read(resolve(root,value));
    const policy=PolicySchema.parse(JSON.parse(resource(path))),version=policy.version,raw=resource(policy.developmentReportPath),report=JSON.parse(raw),manifest=JSON.parse(resource(version===1?'fixtures/review-manifest.json':'fixtures/review-v2/manifest.json'));
    const fixturePath=version===1?'fixtures/dev/review-cases.json':'fixtures/review-v2/dev.json',entry=manifest.files.find((f:{path:string})=>f.path===fixturePath),casesRaw=resource(fixturePath),cases=JSON.parse(casesRaw);
    if(version===2&&(manifest.questionVersion!==2||manifest.candidateQuestionConfigHash!==questionConfigHash(.9,2)||report.questionVersion!==2))throw new Error();
    if(version===2){
      const sourcePath='artifacts/acceptance/review-v2/dev.json',sourceText=resource(sourcePath);
      if(policy.developmentReportPath!=='artifacts/acceptance/review-v2/dev-calibrated.json'||report.calibration?.sourceReportPath!==sourcePath||report.calibration?.sourceReportSha256!==sha(sourceText))throw new Error();
      const recomputed=calibrateDevelopment(JSON.parse(sourceText),casesRaw,entry?.sha256,2);
      const expected={...recomputed,calibration:{...recomputed.calibration,sourceReportPath:sourcePath,sourceReportSha256:sha(sourceText)}};
      if(!isDeepStrictEqual(report,expected))throw new Error();
    }
    if(!entry||sha(casesRaw)!==entry.sha256||sha(raw)!==policy.developmentReportSha256||policy.model!==model||policy.questionConfigHash!==questionConfigHash(policy.minConfidence,version)
      ||report.scope!=='REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION'||report.status!=='PASS'||report.split!=='dev'||report.model!==model||report.minConfidence!==policy.minConfidence
      ||report.questionConfigHash!==policy.questionConfigHash||report.fixtureSha256!==entry.sha256||cases.length!==12||report.results?.length!==12
      ||report.summary?.planned!==12||report.summary.attempted!==12||report.summary.evaluated!==12||report.summary.matches!==12||report.summary.errors!==0||report.summary.falsePass!==0)throw new Error();
    for(let i=0;i<cases.length;i++) {
      const row=report.results[i],c=cases[i],judgment=JevResponseSchema.parse(row.raw),decision=aggregateJev(judgment,policy.minConfidence);
      if(row.id!==c.id||JSON.stringify(row.input)!==JSON.stringify(c.state)||row.expected!==c.expected||row.error!==null||!row.matches||judgment.model!==model||decision!==row.actual||decision!==c.expected)throw new Error();
    }
    const rule={model:policy.model,minConfidence:policy.minConfidence,questionConfigHash:policy.questionConfigHash};return version===2?{...rule,questionVersion:2}:rule;
  }catch{throw new Error('REVIEW_POLICY_INVALID');}
}

/** A development-frozen v2 candidate is not an activated application policy.
 * Report integrity is checked here; these files are not provider attestations.
 * A holdout FAIL cannot activate a candidate even with no false PASS.
 * v1 keeps its existing configuration behavior and historical hash.
 */
export function loadActivatedReviewPolicy(path:string,model:string,root=process.cwd()){
  const rule=loadReviewPolicy(path,model,root);if(rule.questionVersion!==2)return rule;
  try{
    const resource=(value:string)=>read(resolve(root,value)),policy=JSON.parse(resource(path)),dev=JSON.parse(resource(policy.developmentReportPath)),manifest=JSON.parse(resource('fixtures/review-v2/manifest.json'));
    if(!Number.isFinite(Date.parse(dev.endedAt)))throw new Error();
    for(const mode of ['holdout','critical'] as const){
      const fixturePath=`fixtures/review-v2/${mode==='holdout'?'holdout':'dev'}.json`,fixtureText=resource(fixturePath),cases=JSON.parse(fixtureText) as {id:string;expected:string;state:unknown}[],entry=manifest.files.find((f:{path:string})=>f.path===fixturePath),r=JSON.parse(resource(`artifacts/acceptance/review-v2/${mode}.json`));
      if(!entry||sha(fixtureText)!==entry.sha256||cases.length!==(mode==='holdout'?24:12)||entry.count!==cases.length)throw new Error();
      const labels={'dev-001':'PASS','dev-005':'ABSTAIN','dev-009':'REJECT'};
      const plan=mode==='holdout'?cases.map(c=>({...c,caseId:c.id,attempt:1})):Object.entries(labels).flatMap(([id,label])=>{const c=cases.find(c=>c.id===id);if(!c||c.expected!==label)throw new Error();return [1,2,3].map(attempt=>({...c,id:`${id}#${attempt}`,caseId:id,attempt}));});
      if(r.scope!=='REAL_JEV_PUBLIC_SYNTHETIC_EVALUATION'||r.split!==mode||r.questionVersion!==2||r.model!==rule.model||r.minConfidence!==rule.minConfidence||r.questionConfigHash!==rule.questionConfigHash||r.fixtureSha256!==entry.sha256||r.blocked!==null||r.runState!==undefined||r.confidenceRule!=='FROZEN_DEVELOPMENT_RULE'||!Array.isArray(r.results)||r.results.length!==plan.length
        ||!Number.isFinite(Date.parse(r.startedAt))||!Number.isFinite(Date.parse(r.endedAt))||Date.parse(r.startedAt)<Date.parse(dev.endedAt)||Date.parse(r.endedAt)<Date.parse(r.startedAt)||Date.parse(r.endedAt)>Date.now())throw new Error();
      let matches=0,falsePass=0;
      for(let i=0;i<plan.length;i++){
        const row=r.results[i],c=plan[i],raw=JevResponseSchema.parse(row.raw),actual=aggregateJev(raw,rule.minConfidence);
        if(row.id!==c.id||row.caseId!==c.caseId||row.attempt!==c.attempt||row.expected!==c.expected||!isDeepStrictEqual(row.input,c.state)||row.inputSha256!==sha(JSON.stringify(c.state))||row.error!==null||raw.model!==rule.model||row.actual!==actual||row.matches!==(actual===c.expected)||!Number.isInteger(row.durationMs)||row.durationMs<0)throw new Error();
        if(row.matches)matches++;if(actual==='PASS'&&c.expected!=='PASS')falsePass++;
      }
      const summary={planned:plan.length,attempted:plan.length,evaluated:plan.length,errors:0,matches,falsePass};
      if(!isDeepStrictEqual(r.summary,summary)||r.status!==(matches===plan.length?'PASS':'FAIL')||mode==='holdout'&&r.status!=='PASS'||falsePass!==0||mode==='critical'&&matches!==9)throw new Error();
    }
    return rule;
  }catch{throw new Error('REVIEW_POLICY_ACTIVATION_REQUIRED');}
}
