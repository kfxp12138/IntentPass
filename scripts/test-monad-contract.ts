import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,existsSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {commandExit} from './verification-outcome.js';
import {nativeFoundryBinary} from './foundry-runtime.js';
const startedAt=new Date().toISOString(),base='artifacts/acceptance';mkdirSync(base,{recursive:true});
if(existsSync(`${base}/monad-contract.json`)) {
  const history=`${base}/history/${startedAt.replaceAll(':','-')}-monad-contract`;mkdirSync(history,{recursive:true});
  for(const file of ['monad-contract.json','monad-contract.log'])copyFileSync(`${base}/${file}`,`${history}/${file}`);
}
const binary=nativeFoundryBinary('forge'),version=spawnSync(binary,['--version'],{encoding:'utf8'}).stdout.trim();
// Run from the contract directory. Foundry 1.8 Solar diagnostics use process cwd for relative imports.
const args=['test','--network','monad'];
const result=spawnSync(binary,args,{cwd:resolve('contracts'),encoding:'utf8',timeout:180000,maxBuffer:16000000});
const output=(result.stdout??'')+(result.stderr??'');writeFileSync(`${base}/monad-contract.log`,output);
const counts=output.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped/);
const status=commandExit(result)===0&&counts&&Number(counts[1])>=68&&Number(counts[2])===0&&Number(counts[3])===0&&!/^error:/m.test(output)?'PASS':'FAIL';
const releasePath='.tools/foundry-v1.8.0/release.json';
writeFileSync(`${base}/monad-contract.json`,JSON.stringify({scope:'LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES',status,startedAt,endedAt:new Date().toISOString(),toolVersion:version,release:existsSync(releasePath)?JSON.parse(readFileSync(releasePath,'utf8')):null,command:'forge test --network monad',cwd:'contracts',exitCode:commandExit(result),tests:counts?{passed:Number(counts[1]),failed:Number(counts[2]),skipped:Number(counts[3])}:null,publicMonadDeployment:false,evidence:`${base}/monad-contract.log`},null,2)+'\n');
console.log(output);console.log(`Monad native contracts ${status}; local execution only.`);process.exitCode=status==='PASS'?0:1;
