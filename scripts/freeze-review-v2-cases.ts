import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {questionConfigHash} from '../packages/adapters/src/jev-review.js';
import {EvaluationStateSchema,evaluationSha} from './review-evaluation.js';
import {reviewV2Cases} from './review-v2-cases.js';
const base='fixtures/review-v2';
if(process.argv.length!==2||['dev.json','holdout.json','manifest.json'].some(name=>existsSync(`${base}/${name}`))){console.error('REVIEW_V2_COHORT_ALREADY_EXISTS_OR_ARGUMENTS_INVALID');process.exit(1);}
const source='artifacts/acceptance/application-review-smoke.json',raw=readFileSync(source,'utf8'),original=JSON.parse(raw);
if(original.scope!=='REAL_JEV_APPLICATION_SERVICE_PUBLIC_SYNTHETIC_QUOTES_LOCAL_SIGNER'||original.results?.[1]?.id!=='application-license-missing'||original.results[1].expected!=='ABSTAIN'||original.results[1].result.decision!=='REJECT')throw new Error('APPLICATION_REGRESSION_EVIDENCE_INVALID');
const cases=reviewV2Cases(EvaluationStateSchema.parse(original.providerRecords[1].state));mkdirSync(base,{recursive:true});
const files=Object.entries(cases).map(([split,rows])=>{const path=`${base}/${split}.json`,text=JSON.stringify(rows,null,2)+'\n';writeFileSync(path,text,{flag:'wx'});return {path,count:rows.length,sha256:evaluationSha(text),expectedCounts:Object.fromEntries(['PASS','ABSTAIN','REJECT'].map(label=>[label,rows.filter(r=>r.expected===label).length]))};});
writeFileSync(`${base}/manifest.json`,JSON.stringify({version:1,questionVersion:2,candidateQuestionConfigHash:questionConfigHash(.9,2),frozenAt:new Date().toISOString(),scope:'NEW_PUBLIC_SYNTHETIC_COHORT_BEFORE_VERSION_2_MODEL_REQUESTS',files,developmentRegressionSource:{path:source,sha256:evaluationSha(raw),case:'application-license-missing'},holdoutRule:'Disjoint new states, seller and datasets. Freeze before all model requests; no original holdout outcomes used to tune version 2.'},null,2)+'\n',{flag:'wx'});
console.log('New version 2 cohort frozen: 12 development / 24 holdout; provider requests 0.');
