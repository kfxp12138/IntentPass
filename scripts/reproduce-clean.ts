import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {commandExit,completeUnitRun} from './verification-outcome.js';
const startedAt=new Date().toISOString(),base=resolve('artifacts/acceptance'),path=join(base,'clean-reproduction.json');mkdirSync(base,{recursive:true});
if(existsSync(path)){const history=join(base,'history',startedAt.replaceAll(':','-')+'-clean-reproduction');mkdirSync(history,{recursive:true});copyFileSync(path,join(history,'clean-reproduction.json'));for(const name of ['clone','checkout','pnpm-version','install','build','unit','client-health','server','foundry-install','native-contract','abi','native-demo']){const log=join(base,'clean-reproduction-'+name+'.log');if(existsSync(log))copyFileSync(log,join(history,'clean-reproduction-'+name+'.log'));}}
const directory=mkdtempSync(join(tmpdir(),'intentpass-reproduction-')),project=join(directory,'project'),runs:{command:string;exitCode:number|null;evidence:string}[]=[];
// Deliberately do not inherit service tokens, RPC configuration or financial paths.
const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'true',NPM_CONFIG_USERCONFIG:join(directory,'empty.npmrc')};writeFileSync(env.NPM_CONFIG_USERCONFIG!,'');
let server:ReturnType<typeof spawn>|undefined,report:Record<string,unknown>={},serverOutput='';
function run(name:string,command:string,args:string[],cwd=project,extra:NodeJS.ProcessEnv={}){
  const result=spawnSync(command,args,{cwd,env:{...env,...extra},encoding:'utf8',timeout:300000,maxBuffer:32000000}),evidence=`artifacts/acceptance/clean-reproduction-${name}.log`;
  writeFileSync(resolve(evidence),(result.stdout??'')+(result.stderr??'')+(result.error?'\nLOCAL_COMMAND_ERROR':''));const item={command:[command,...args].join(' '),exitCode:commandExit(result),evidence};runs.push(item);console.log(`${name}: exit ${item.exitCode}`);if(item.exitCode!==0)throw new Error('REPRODUCTION_COMMAND_FAILED');return result.stdout??'';
}
try{
  if(process.argv.length!==2||process.platform==='win32'||!process.version.startsWith('v24.'))throw new Error('RUNTIME_OR_ARGUMENT_INVALID');
  const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});if(commandExit(revision)!==0||!/^[a-f0-9]{40}\s*$/.test(revision.stdout))throw new Error('SOURCE_COMMIT_UNAVAILABLE');
  const sourceCommit=revision.stdout.trim();report={sourceCommit,node:process.version,platform:process.platform,sameHost:true,independentMachine:false,sharedDependencyStore:false};
  run('clone','git',['clone','--no-local','--no-hardlinks',process.cwd(),project],directory);
  run('checkout','git',['checkout','--detach',sourceCommit]);
  const excluded=['.env','node_modules','.pnpm-store','.tools','apps/web/dist','contracts/out'];if(excluded.some(p=>existsSync(join(project,p))))throw new Error('CLONE_CONTAINS_PRIVATE_OR_GENERATED_STATE');
  report.cleanClone={excludedAbsent:excluded,sourceModified:false};
  const manager=run('pnpm-version','pnpm',['--version']).trim();if(manager!=='11.25.0')throw new Error('PACKAGE_MANAGER_VERSION_MISMATCH');report.packageManager='pnpm@'+manager;
  run('install','pnpm',['install','--frozen-lockfile','--registry=https://registry.npmjs.org']);
  copyFileSync(join(project,'.env.example'),join(project,'.env'));
  run('build','pnpm',['build']);
  // Install the pinned compiler and compile the fresh source before the mandatory
  // offline runtime-artifact regression. A default skipped test is not acceptance.
  run('foundry-install','pnpm',['tools:foundry']);
  run('native-contract','pnpm',['test:contract:monad']);
  run('unit','pnpm',['test:unit'],project,{FOUNDRY_OFFLINE:'true',INTENTPASS_RUNTIME_ARTIFACT_INTEGRATION:'1'});
  const unit=readFileSync(join(base,'clean-reproduction-unit.log'),'utf8');if(!completeUnitRun(unit,330))throw new Error('INCOMPLETE_UNIT_RUN');report.applicationTests=Number(unit.match(/^# pass (\d+)$/m)?.[1]??0);
  const contracts=JSON.parse(readFileSync(join(project,'artifacts/acceptance/monad-contract.json'),'utf8'));if(contracts.status!=='PASS'||contracts.tests?.passed<68||contracts.tests.failed!==0||contracts.tests.skipped!==0)throw new Error('CONTRACT_REPRODUCTION_FAILED');
  run('abi','pnpm',['abi:check']);
  run('native-demo','pnpm',['demo:monad-local']);
  const demo=JSON.parse(readFileSync(join(project,'artifacts/acceptance/local-monad-demo.json'),'utf8')),proof=JSON.parse(readFileSync(join(project,'artifacts/acceptance/local-deployment-proof.json'),'utf8'));
  if(demo.scope!=='LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES_NOT_PUBLIC_MONAD_OR_CVA'||demo.transactions.length!==28||demo.finalBalances?.buyer!=='980'||demo.finalBalances.seller!=='20'||demo.finalBalances.escrow!=='0'||proof.status!=='CONFIRMED'||proof.scope!=='LOCAL_TEST_DEPLOYMENT_CREATION_PROOF')throw new Error('NATIVE_DEMO_REPRODUCTION_FAILED');
  report.native={contracts:contracts.tests,toolVersion:contracts.toolVersion,scope:contracts.scope,demoTransactions:demo.transactions.length,finalBalances:demo.finalBalances,creationProof:proof};
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const address=listener.address();if(!address||typeof address==='string')throw new Error('PORT_UNAVAILABLE');const port=address.port;await new Promise<void>((ok,fail)=>listener.close(e=>e?fail(e):ok()));
  server=spawn('pnpm',['start'],{cwd:project,env:{...env,PORT:String(port)},detached:true,stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr])stream?.on('data',chunk=>{serverOutput+=String(chunk);if(serverOutput.length>2000000)serverOutput=serverOutput.slice(-2000000);});
  server.on('error',()=>{});
  const deadline=Date.now()+30000,marker=`http://127.0.0.1:${port}`;
  while(!serverOutput.includes(marker)&&Date.now()<deadline&&server.exitCode===null&&server.signalCode===null)await new Promise(ok=>setTimeout(ok,100));
  if(!serverOutput.includes(marker)||server.exitCode!==null||server.signalCode!==null)throw new Error('SERVER_START_UNAVAILABLE');
  const url=marker,healthResponse=await fetch(url+'/health',{redirect:'error',signal:AbortSignal.timeout(10000)}),health=await healthResponse.json();
  if(healthResponse.status!==200||health.service!=='intentpass'||health.liveness!=='OK'||health.ready!==false)throw new Error('HEALTH_BOUNDARY_INVALID');
  const page=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)}),html=await page.text();if(page.status!==200||!html.includes('IntentPass')||html.includes('/@vite/client'))throw new Error('PAGE_UNAVAILABLE');
  const assetPath=html.match(/src="(\/assets\/[^"<>]+\.js)"/)?.[1];if(!assetPath)throw new Error('BUILT_ASSET_UNAVAILABLE');
  const asset=await fetch(url+assetPath,{redirect:'error',signal:AbortSignal.timeout(10000)});if(asset.status!==200||!(await asset.text()).length||!asset.headers.get('cache-control')?.includes('immutable'))throw new Error('BUILT_ASSET_UNAVAILABLE');
  const head=await fetch(url+assetPath,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(10000)});if(head.status!==200||(await head.text())!==''||!Number(head.headers.get('content-length')))throw new Error('BUILT_ASSET_HEAD_INVALID');
  for(const privatePath of ['/capsules.db','/capsules.db-wal','/capsules.db-shm','/.env','/src/main.ts','/@vite/client','/@fs'+join(project,'package.json')]){const response=await fetch(url+privatePath,{headers:{accept:'text/html'},redirect:'error',signal:AbortSignal.timeout(10000)});if(![403,404].includes(response.status)||(await response.text()).includes('<!doctype'))throw new Error('PRODUCTION_PRIVATE_PATH_EXPOSED');}
  const blockedResponse=await fetch(url+'/api/catalog',{redirect:'error',signal:AbortSignal.timeout(10000)}),blocked=await blockedResponse.json();if(blockedResponse.status!==503||blocked.status!=='BLOCKED')throw new Error('UNCONFIGURED_API_BOUNDARY_INVALID');
  const clientOutput=run('client-health','pnpm',['example:run','health'],project,{INTENTPASS_URL:url});if(!clientOutput.includes('"ready": false')&&!clientOutput.includes('"ready":false'))throw new Error('CLIENT_HEALTH_BOUNDARY_INVALID');
  report={...report,status:'PASS',scope:'SAME_HOST_EMPTY_CLONE_FRESH_INSTALL_APPLICATION_NATIVE_CONTRACT_DEMO_HTTP_CLI',serverCommand:'pnpm start',http:{webMode:'production',health,pageStatus:page.status,assetStatus:asset.status,assetHeadStatus:head.status,privateWebPathsDenied:true,unconfiguredApi:{statusCode:blockedResponse.status,status:blocked.status}},contractsRun:true,realIntegrationsRun:false,publicDeployments:0};
}catch{report={...report,status:'FAIL',scope:'SAME_HOST_EMPTY_CLONE_FRESH_INSTALL_APPLICATION_NATIVE_CONTRACT_DEMO_HTTP_CLI',reason:'CLEAN_REPRODUCTION_FAILED'};}
finally{
  let stopped=true;
  if(server?.pid){const pid=server.pid,alive=()=>{try{process.kill(-pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}};try{process.kill(-pid,'SIGTERM');}catch{}let deadline=Date.now()+5000;while(alive()&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,100));if(alive()){try{process.kill(-pid,'SIGKILL');}catch{}deadline=Date.now()+2000;while(alive()&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,100));}stopped=!alive();}
  report.serverProcessGroupStopped=stopped;if(!stopped){report.status='FAIL';report.reason='REPRODUCTION_SERVER_CLEANUP_UNVERIFIED';}
  writeFileSync(join(base,'clean-reproduction-server.log'),serverOutput);report={startedAt,endedAt:new Date().toISOString(),...report,runs,temporaryWorkspaceRemoved:true};rmSync(directory,{recursive:true,force:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,scope:report.scope,sourceCommit:report.sourceCommit,evidence:'artifacts/acceptance/clean-reproduction.json'}));process.exitCode=report.status==='PASS'?0:1;
}
