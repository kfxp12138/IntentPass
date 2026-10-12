import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,copyFileSync} from 'node:fs';
import {commandExit} from './verification-outcome.js';
import {demoArguments,negativeDemoEvidence,negativeContractChecks,expectedBlockedExit} from './demo-evidence.js';
import {day4LocalEvidence} from './day4-evidence.js';
const startedAt=new Date().toISOString(),base='artifacts/acceptance';mkdirSync(base,{recursive:true});
let args:ReturnType<typeof demoArguments>;try{args=demoArguments(process.argv.slice(2));}catch{console.error(JSON.stringify({status:'FAIL',code:'DEMO_ARGUMENT_INVALID'}));process.exit(1);}
const prefix=`demo-${args.kind}`,path=`${base}/${prefix}.json`;
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),working=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
if(existsSync(path)){const history=`${base}/history/${startedAt.replaceAll(':','-')}-${prefix}`;mkdirSync(history,{recursive:true});for(const name of [`${prefix}.json`,`${prefix}-day4.log`,`${prefix}-contract.log`,`${prefix}-unit.log`])if(existsSync(`${base}/${name}`))copyFileSync(`${base}/${name}`,`${history}/${name}`);}
const runs:{command:string;exitCode:number|null;evidence:string}[]=[];
function run(name:string,command:string,argv:string[]){const r=spawnSync(command,argv,{encoding:'utf8',timeout:300000,maxBuffer:32000000}),evidence=`${base}/${prefix}-${name}.log`;writeFileSync(evidence,(r.stdout??'')+(r.stderr??'')+(r.error?'\nLOCAL_COMMAND_ERROR':''));const result={command:[command,...argv].join(' '),exitCode:commandExit(r),commandError:!!r.error,signal:r.signal,evidence};runs.push(result);console.log(`${name}: exit ${result.exitCode}`);return result;}
function json(name:string):any{try{return JSON.parse(readFileSync(`${base}/${name}`,'utf8'));}catch{return null;}}
let status:'PASS'|'BLOCKED'|'FAIL'='BLOCKED',localEvidence:unknown=null;
if(args.local){
  if(args.kind==='happy'){
    const child=run('day4','pnpm',['verify:day4']),r=json('day4.json');
    const valid=expectedBlockedExit(child)&&r?.status==='BLOCKED'&&r?.deterministicChecks==='PASS'&&r?.stage==='D4'&&r?.scope==='LOCAL_NATIVE_PREREQUISITES_ONLY_NOT_D4_EXTERNAL_ACCEPTANCE'&&r.startedAt>=startedAt&&Array.isArray(r.runs)&&day4LocalEvidence({startedAt,endedAt:new Date().toISOString(),exits:r.runs.map((v:{exitCode:number|null})=>v.exitCode),unit:readFileSync(`${base}/day4-test-unit.log`,'utf8'),contracts:json('monad-contract.json'),demo:json('local-monad-demo.json'),creationProof:json('local-deployment-proof.json'),minimumTests:330});
    status=valid?'PASS':'FAIL';if(valid){const d=json('local-monad-demo.json');localEvidence={orders:d.orders.map((o:{orderId:string;state:string})=>({orderId:o.orderId,state:o.state})),transactions:d.transactions,finalBalances:d.finalBalances,creationProof:'artifacts/acceptance/local-deployment-proof.json',day4:'artifacts/acceptance/day4.json'};}
  }else{
    run('contract','pnpm',['test:contract:monad']);run('unit',process.execPath,['--experimental-sqlite','--import','tsx','--test','--test-reporter=tap','tests/review.test.ts','tests/receipt-signer.test.ts']);
    status=negativeDemoEvidence({startedAt,endedAt:new Date().toISOString(),exits:runs.map(r=>r.exitCode),contracts:json('monad-contract.json'),contractLog:readFileSync(`${base}/${prefix}-contract.log`,'utf8'),unitLog:readFileSync(`${base}/${prefix}-unit.log`,'utf8')})?'PASS':'FAIL';if(status==='PASS')localEvidence={contracts:json('monad-contract.json').tests,applicationTests:Number(readFileSync(`${base}/${prefix}-unit.log`,'utf8').match(/^# pass (\d+)$/m)![1]),requiredContractChecks:negativeContractChecks,providerScope:'LOCAL_JEV_PRIVY_TRANSPORT_AND_TEST_ELIGIBILITY_DOUBLES'};
  }
}
const report={startedAt,endedAt:new Date().toISOString(),command:`demo:${args.kind}`,commit:commandExit(revision)===0?revision.stdout.trim():null,worktreeDirty:commandExit(working)!==0||!!working.stdout.trim(),status,scope:args.local?'LOCAL_MONAD_NATIVE_TEST_DOUBLES_NOT_PUBLIC_OR_SPONSOR_DEMO':'REAL_PUBLIC_DEMO_EVIDENCE_REQUIRED',releaseAcceptance:'BLOCKED',reason:args.local?'Explicit local regression demonstration; real product/provider recording remains required.':'No actual public product/provider demo was executed. Use --monad-local only for explicitly scoped local regression.',runs,localEvidence,realProviderCallsAdded:0,publicTransactionsAdded:0,physicalDeviceChecksAdded:0};writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status,scope:report.scope,releaseAcceptance:report.releaseAcceptance,evidence:path}));process.exitCode=status==='PASS'?0:1;
