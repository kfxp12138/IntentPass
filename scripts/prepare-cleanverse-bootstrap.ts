import {existsSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {spawnSync} from 'node:child_process';
import {createPublicClient,http,parseAbi} from 'viem';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {commandExit} from './verification-outcome.js';
import {CleanverseBootstrapConfigSchema,inspectCleanverseBootstrap} from '../packages/protocol/src/cleanverse-bootstrap.js';
const startedAt=new Date().toISOString(),base='artifacts/acceptance',path=`${base}/cleanverse-bootstrap.json`;
mkdirSync(base,{recursive:true});
if(existsSync(path)){
  const history=`${base}/history/${startedAt.replaceAll(':','-')}-cleanverse-bootstrap`;mkdirSync(history,{recursive:true});
  for(const name of ['cleanverse-bootstrap.json','cleanverse-bootstrap-build.log'])if(existsSync(`${base}/${name}`))copyFileSync(`${base}/${name}`,`${history}/${name}`);
}
let report:Record<string,unknown>;
try{
  if(process.argv.length!==2)throw new Error('ARGUMENT_INVALID');
  writeFileSync(`${base}/cleanverse-bootstrap-build.log`,JSON.stringify({scope:'FORCED_LOCAL_DEPLOYMENT_COMPILATION',status:'ATTEMPTED',rawCompilerOutputCaptured:false})+'\n');
  const compilation=compileDeploymentArtifacts();writeFileSync(`${base}/cleanverse-bootstrap-build.log`,compilation.log);
  const artifacts=(['gate','escrow'] as const).map(role=>{
    const name=role==='gate'?'CleanverseEligibility':'ContextVoteEscrow',value=compilation.artifacts[role],metadata=value.metadata;
    return {name,value,artifactSha256:compilation.bindings.find(binding=>binding.path.endsWith(`/${name}.json`))!.sha256,compiler:metadata.compiler.version,settings:metadata.settings,sources:metadata.sources};
  });
  const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),changes=spawnSync('git',['status','--porcelain','--untracked-files=all','--','contracts/src','contracts/foundry.toml','packages','scripts','apps','tests','pnpm-lock.yaml','package.json','tsconfig.json'],{encoding:'utf8'});
  if(commandExit(revision)!==0||commandExit(changes)!==0)throw new Error('SOURCE_REVISION_UNAVAILABLE');
  const build={sourceCommit:revision.stdout.trim(),worktreeDirty:!!changes.stdout.trim(),artifacts:artifacts.map(({value,...metadata})=>metadata),artifactBindings:compilation.bindings,creationBytecodeHashes:compilation.creationBytecodeHashes,forcedRebuild:true,rawCompilerOutputCaptured:false,evidence:`${base}/cleanverse-bootstrap-build.log`};
  if(existsSync('.env'))loadEnvFile('.env');
  const names=['CHAIN_ID','DEPLOYER_ADDRESS','CVA_ADDRESS','CVI_VALIDATOR_ADDRESS','CVA_POLICY_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','MONAD_RPC_URL'];
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length)report={status:'BLOCKED',reason:'BOOTSTRAP_CONFIGURATION_MISSING',missing,build};
  else{
    const config=CleanverseBootstrapConfigSchema.parse({chainId:process.env.CHAIN_ID,deployer:process.env.DEPLOYER_ADDRESS,asset:process.env.CVA_ADDRESS,
      validator:process.env.CVI_VALIDATOR_ADDRESS,policy:process.env.CVA_POLICY_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,
      committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(value=>value.trim())});
    const endpoint=new URL(process.env.MONAD_RPC_URL!);if(endpoint.protocol!=='https:')throw new Error('RPC_ENDPOINT_INVALID');
    const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    const result=await inspectCleanverseBootstrap(config,artifacts[0].value,artifacts[1].value,{
      chainId:()=>client.getChainId(),block:number=>number===undefined?client.getBlock({blockTag:'finalized'}):client.getBlock({blockNumber:number}),
      code:(address,blockNumber)=>client.getCode({address,blockNumber}),balance:(address,blockNumber)=>client.getBalance({address,blockNumber}),
      currentBalance:address=>client.getBalance({address,blockTag:'pending'}),nonce:async(address,blockTag)=>BigInt(await client.getTransactionCount({address,blockTag})),
      assetPolicy:(address,blockNumber)=>client.readContract({address,blockNumber,abi:parseAbi(['function policy() view returns(address)']),functionName:'policy'})
    });
    report={status:'BLOCKED',reason:'SEQUENTIAL_UNSIGNED_DRAFT_ONLY_OFFICIAL_INTEGRATION_GAS_GATE_RECEIPT_NOT_VERIFIED',build,...result};
  }
  compilation.assertCurrent();
}catch{report={status:'BLOCKED',reason:'BOOTSTRAP_PREPARATION_UNAVAILABLE_OR_INVALID_INPUT'};}
report={startedAt,endedAt:new Date().toISOString(),scope:'NO_SIGNATURE_NO_BROADCAST_CLEANVERSE_BOOTSTRAP_PREPARATION',...report,signaturesRequested:0,transactionsSent:0};
writeFileSync(path,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,evidence:path}));process.exitCode=1;
