import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {calibrateDevelopment} from './review-calibration.js';
import {evaluationSha} from './review-evaluation.js';
import {loadReviewPolicy} from '../packages/adapters/src/review-policy.js';

const base='artifacts/acceptance',source=`${base}/review-dev.json`,output=`${base}/review-dev-calibrated.json`,policyPath=`${base}/review-policy.json`;
try {
  if(process.argv.length!==2)throw Error('REVIEW_FREEZE_NO_ARGUMENTS');
  const text=readFileSync(source,'utf8'),report=JSON.parse(text);
  if(existsSync(policyPath)) {
    const previous=JSON.parse(readFileSync(policyPath,'utf8')),calibrated=JSON.parse(readFileSync(output,'utf8'));
    loadReviewPolicy(policyPath,report.model);
    if(calibrated.calibration?.sourceReportSha256!==evaluationSha(text)||previous.developmentReportPath!==output)throw Error('FROZEN_POLICY_ALREADY_EXISTS');
    console.log(JSON.stringify({status:'PASS',action:'EXISTING_IDENTICAL_FROZEN_POLICY',providerRequestsAdded:0}));
  } else {
    for(const name of ['holdout','critical'])if(existsSync(`${base}/review-${name}.json`)) {
      const existing=JSON.parse(readFileSync(`${base}/review-${name}.json`,'utf8'));
      if(existing.scope!=='NO_REAL_MODEL_REQUESTS'||existing.results?.length!==0)throw Error('INDEPENDENT_EVALUATION_ALREADY_STARTED');
    }
    const manifest=JSON.parse(readFileSync('fixtures/review-manifest.json','utf8')),entry=manifest.files.find((f:{path:string})=>f.path==='fixtures/dev/review-cases.json');
    if(!entry||entry.count!==12)throw Error('FROZEN_DEVELOPMENT_INPUT_INVALID');
    const calibrated=calibrateDevelopment(report,readFileSync(entry.path,'utf8'),entry.sha256);
    calibrated.calibration={...calibrated.calibration,sourceReportPath:source,sourceReportSha256:evaluationSha(text)} as typeof calibrated.calibration;
    if(existsSync(output)){const history=`${base}/history/${new Date().toISOString().replaceAll(':','-')}-review-calibration`;mkdirSync(history,{recursive:true});copyFileSync(output,`${history}/review-dev-calibrated.json`);}
    const bytes=JSON.stringify(calibrated,null,2)+'\n';writeFileSync(output,bytes);
    const policy={version:1,model:calibrated.model,minConfidence:calibrated.minConfidence,questionConfigHash:calibrated.questionConfigHash,
      developmentReportPath:output,developmentReportSha256:evaluationSha(bytes)};
    writeFileSync(policyPath,JSON.stringify(policy,null,2)+'\n',{flag:'wx'});loadReviewPolicy(policyPath,String(calibrated.model));
    console.log(JSON.stringify({status:'PASS',model:policy.model,minConfidence:policy.minConfidence,development:calibrated.summary,providerRequestsAdded:0,policyPath,
      scope:'DEVELOPMENT_ONLY_FROZEN_RECOMPOSITION_NOT_INDEPENDENT_OR_PRODUCTION_SAFETY_PROOF'}));
  }
} catch(error) {
  console.error(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'REVIEW_FREEZE_UNAVAILABLE');process.exitCode=1;
}
