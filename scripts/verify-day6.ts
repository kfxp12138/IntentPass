import {refreshAcceptanceIndex} from './acceptance-index.js';
import {writeStageReport,archiveStageReport} from './stage-report.js';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,copyFileSync} from 'node:fs';
import {commandExit,completeUnitRun} from './verification-outcome.js';
import {loadEnvFile} from 'node:process';
import {inspectEvaluationReport} from './review-report-evidence.js';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const startedAt=new Date().toISOString(),base='artifacts/acceptance';mkdirSync(base,{recursive:true});
archiveStageReport('D6',startedAt);
const commands=['typecheck','build','test:unit','test:contract:monad','audit:public'];
if(existsSync(`${base}/day6.json`)){const history=`${base}/history/${startedAt.replaceAll(':','-')}-D6`;mkdirSync(history,{recursive:true});for(const file of ['day6.json',...commands.map(n=>`day6-${n.replaceAll(':','-')}.log`)])if(existsSync(`${base}/${file}`))copyFileSync(`${base}/${file}`,`${history}/${file}`);}
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
const runs=commands.map(name=>{const result=spawnSync('pnpm',['run',name],{encoding:'utf8',timeout:240000,maxBuffer:16000000}),evidence=`${base}/day6-${name.replaceAll(':','-')}.log`;writeFileSync(evidence,(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:''));const run={command:`pnpm run ${name}`,exitCode:commandExit(result),evidence};console.log(`${name}: exit ${run.exitCode}`);return run;});
const unit=readFileSync(`${base}/day6-test-unit.log`,'utf8');
function report(path:string):Record<string,unknown>|null{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}}
const contracts=report(`${base}/monad-contract.json`),audit=report(`${base}/public-audit.json`);
const fresh=(value:Record<string,unknown>|null)=>!!value&&typeof value.startedAt==='string'&&value.startedAt>=startedAt&&typeof value.endedAt==='string'&&value.endedAt>=value.startedAt;
const deterministic=runs.slice(0,4).every(r=>r.exitCode===0)&&completeUnitRun(unit,330)&&fresh(contracts)&&contracts?.status==='PASS';
const auditValid=fresh(audit)&&Array.isArray(audit?.findings)&&Array.isArray(audit?.manifest)&&audit.manifest.length>0;
const auditFailed=!auditValid||audit?.status==='FAIL';
// Load trusted operator configuration after local checks; never log secret values.
if(existsSync('.env'))loadEnvFile('.env');
const reviewConfig={model:process.env.JEV_MODEL,policyPath:process.env.REVIEW_POLICY_PATH},holdout=inspectEvaluationReport('holdout',`${base}/review-holdout.json`,reviewConfig),critical=inspectEvaluationReport('critical',`${base}/review-critical.json`,reviewConfig);
let reviewEvidence:Record<string,unknown>|null=null;
// Public synthetic evaluation files only. Do not expose a private operator path.
if(reviewConfig.model&&/^jev-\d+\.\d+\.\d+$/.test(reviewConfig.model)&&reviewConfig.policyPath&&resolve(reviewConfig.policyPath)===resolve(`${base}/review-policy.json`))try {
  const paths={policySha256:'review-policy',developmentSha256:'review-dev-calibrated',sourceDevelopmentSha256:'review-dev',holdoutSha256:'review-holdout',criticalSha256:'review-critical'};
  reviewEvidence={version:1,model:reviewConfig.model,...Object.fromEntries(Object.entries(paths).map(([name,file])=>[name,createHash('sha256').update(readFileSync(`${base}/${file}.json`)).digest('hex')]))};
}catch{/* Missing public records do not upgrade acceptance. */}
const acceptance=[
 {id:'D6-01',status:deterministic?'PASS':'FAIL',scope:'LOCAL_DETERMINISTIC_APPLICATION_AND_MONAD_NATIVE_TESTS',reason:'Real provider, public deployment and physical device acceptance remain separate.'},
 {id:'D6-02',...holdout,evidence:`${base}/review-holdout.json`},
 {id:'D6-03',...critical,evidence:`${base}/review-critical.json`},
 {id:'D6-04',status:'BLOCKED',reason:'Independent process/HTTP/signature tests are local doubles; real JEV and public order not verified.'},
 {id:'D6-05',status:'BLOCKED',reason:'Same-host empty clone installation and native demo evidence is recorded separately; configured public deployment/address reproduction remains incomplete.'},
 {id:'D6-06',status:auditFailed?'FAIL':'BLOCKED',reason:'Raw-byte heuristic inventory recorded. Media pixels, encoded contents and private-text consent require separate review.'},
 {id:'D6-07',status:'BLOCKED',reason:'Durable restart/concurrency regression tests run locally; actual browser refresh and public-chain worker recovery not executed.'},
];
const status=acceptance.some(x=>x.status==='FAIL')?'FAIL':'BLOCKED';
const result={startedAt,endedAt:new Date().toISOString(),stage:'D6',commit:commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty:commandExit(working)!==0||!!working.stdout.trim(),environment:{node:process.version,platform:process.platform},route:'context-vote-escrow',status,deterministicChecks:deterministic?'PASS':'FAIL',runs,acceptance,reviewEvidence,applicationTests:Number(unit.match(/^# pass (\d+)$/m)?.[1]??0),contractEvidence:`${base}/monad-contract.json`,auditEvidence:`${base}/public-audit.json`,realProviderCallsAdded:0,publicDeploymentsAdded:0,physicalDeviceChecksAdded:0};
writeFileSync(`${base}/day6.json`,JSON.stringify(result,null,2)+'\n');writeStageReport(result);refreshAcceptanceIndex();
console.log(JSON.stringify({status,deterministicChecks:result.deterministicChecks,acceptance}));process.exitCode=1;
