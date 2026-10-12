import {spawnSync} from 'node:child_process';
import {mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {captureReleaseSource,sameReleaseSource} from './release-source.js';
import {commandExit} from './verification-outcome.js';
import {completeReleaseUnitRun} from './release-local-outcome.js';
import {auditBytes} from './public-audit.js';
import {OrderSnapshotSchema} from '../packages/protocol/src/index.js';

const startedAt=new Date().toISOString(),id=randomUUID(),directory=`artifacts/acceptance/release-local/${id}`;
mkdirSync(directory,{recursive:true});
// No provider secrets or server runtime paths are inherited by test children.
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'true',FOUNDRY_OFFLINE:'true',INTENTPASS_RUNTIME_ARTIFACT_INTEGRATION:'1'};
const runs:{name:string;exitCode:number|null;startedAt:string;endedAt:string;evidence:string;sha256:string}[]=[];
let source:ReturnType<typeof captureReleaseSource>|undefined,unit:ReturnType<typeof completeReleaseUnitRun>|undefined,contracts:unknown,chain:unknown,sourceStable=false,status:'PASS'|'FAIL'='FAIL',reason='RELEASE_LOCAL_UNAVAILABLE';
function run(name:string,args:string[],timeout=180000){
  const began=new Date().toISOString(),r=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout,maxBuffer:32000000});
  const output=(r.stdout??'')+(r.stderr??'')+(r.error?'\nLOCAL_COMMAND_ERROR\n':''),bytes=Buffer.from(output);
  if(auditBytes(`${name}.log`,bytes).length)throw Error('RELEASE_LOG_REQUIRES_PRIVATE_REVIEW');
  const path=`${directory}/${name}.log`;writeFileSync(path,bytes,{flag:'wx'});
  const item={name,exitCode:commandExit(r),startedAt:began,endedAt:new Date().toISOString(),evidence:path,sha256:createHash('sha256').update(bytes).digest('hex')};runs.push(item);console.log(`${name}: exit ${item.exitCode}`);
  if(item.exitCode!==0)throw Error('RELEASE_LOCAL_COMMAND_FAILED');return output;
}
try{
  if(process.argv.length!==2||!process.version.startsWith('v24.'))throw Error('RELEASE_RUNTIME_INVALID');
  source=captureReleaseSource();
  run('typecheck',['node_modules/typescript/bin/tsc','--noEmit']);
  const files=readdirSync('tests').filter(name=>/^[A-Za-z0-9._-]+\.test\.ts$/.test(name)).sort().map(name=>`tests/${name}`);
  unit=completeReleaseUnitRun(run('unit',['--experimental-sqlite','--import','tsx','--test','--test-reporter=tap',...files]));
  run('contracts',['--import','tsx','scripts/test-monad-contract.ts']);
  const c=JSON.parse(readFileSync('artifacts/acceptance/monad-contract.json','utf8'));
  if(c.status!=='PASS'||c.scope!=='LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES'||c.tests.passed<68||c.tests.failed!==0||c.tests.skipped!==0)throw Error('RELEASE_CONTRACT_RUN_INCOMPLETE');contracts=c.tests;
  run('abi',['--import','tsx','scripts/check-abi.ts']);
  run('build',['node_modules/vite/bin/vite.js','build','apps/web','--outDir','dist']);
  const historical=JSON.parse(readFileSync('artifacts/acceptance/general-automation/first-background-purchase.json','utf8'));
  const result=JSON.parse(run('independent-chain-client',['--import','tsx','examples/chain-client/index.ts',historical.chainProof.orderId]));
  const s=OrderSnapshotSchema.parse(result.snapshot),anchor=historical.chainProof.finalOrder;
  if(result.status!=='ORDER_READ_VERIFIED'||result.scope!=='PUBLIC_FINALIZED_SDK_ORDER_READ_NOT_AUTHENTICATED_PURCHASE_ACCEPTANCE'||result.transactionsSent!==0||result.signaturesRequested!==0||s.state!=='ALLOCATED_PAID'||s.withdrawn.payee!==historical.paidMinimalUnits||BigInt(s.block.number)<BigInt(anchor.block.number)||s.credits.payee!=='0')throw Error('RELEASE_PUBLIC_ORDER_READ_MISMATCH');
  for(const key of ['chainId','arbiter','asset','orderId','contextHash','buyer','seller','payee','price','bond','datasetHash','serviceTermsHash','evidenceHash'] as const)if(s[key].toLowerCase()!==anchor[key].toLowerCase())throw Error('RELEASE_PUBLIC_ORDER_READ_MISMATCH');
  chain=result;sourceStable=sameReleaseSource(source,captureReleaseSource());if(!sourceStable)throw Error('RELEASE_SOURCE_CHANGED');status='PASS';reason='COMPLETE_LOCAL_REGRESSION_AND_INDEPENDENT_PUBLIC_ORDER_READ';
}catch(error){reason=error instanceof Error&&/^RELEASE_[A-Z_]+$/.test(error.message)?error.message:'RELEASE_LOCAL_UNAVAILABLE';}
const report={schemaVersion:1,id,startedAt,endedAt:new Date().toISOString(),status,reason,scope:'CURRENT_SOURCE_LOCAL_TESTS_AND_PUBLIC_SDK_READ_NOT_FINAL_SEVEN_DAY_ACCEPTANCE',source,sourceStable,unit,contracts,independentChainRead:chain,runs,sevenDayAcceptanceStatus:'BLOCKED',financialAcceptanceStatus:'BLOCKED',signaturesRequested:0,publicTransactionsAdded:0,physicalDeviceChecksAdded:0,
  limits:['Tests use isolated local models, identities and chains. Public SDK read does not complete authenticated purchase/provider provenance acceptance.','Mera physical recovery, public HTTPS, final privacy/media review, video and actual submission remain required.']};
const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
if(auditBytes('release-local.json',bytes).length){console.error('RELEASE_PUBLIC_REPORT_UNSAFE');process.exitCode=1;}
else{const path=`${directory}/report.json`;writeFileSync(path,bytes,{flag:'wx'});console.log(JSON.stringify({status,reason,unit,contracts,sevenDayAcceptanceStatus:'BLOCKED',evidence:path}));process.exitCode=status==='PASS'?0:1;}
