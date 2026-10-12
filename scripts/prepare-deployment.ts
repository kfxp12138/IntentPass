import {existsSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {spawnSync} from 'node:child_process';
import {createPublicClient,http} from 'viem';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {commandExit} from './verification-outcome.js';
import {deploymentDraft,inspectDeployment,DeploymentConfigSchema} from '../packages/protocol/src/deployment.js';
import {configuredAssetMode,assetConfigurationKey,configuredAssetAddress} from '../packages/protocol/src/asset-mode.js';
const startedAt=new Date().toISOString(),base='artifacts/acceptance',path=`${base}/deployment-plan.json`;mkdirSync(base,{recursive:true});
if(existsSync(path)){const history=`${base}/history/${startedAt.replaceAll(':','-')}-deployment-plan`;mkdirSync(history,{recursive:true});for(const file of ['deployment-plan.json','deployment-build.log'])if(existsSync(`${base}/${file}`))copyFileSync(`${base}/${file}`,`${history}/${file}`);}
let report:Record<string,unknown>;
try{
  if(process.argv.length!==2)throw new Error('ARGUMENT_INVALID');
  if(existsSync('.env'))loadEnvFile('.env');
  const assetMode=configuredAssetMode(process.env);
  writeFileSync(`${base}/deployment-build.log`,JSON.stringify({scope:'FORCED_LOCAL_DEPLOYMENT_COMPILATION',status:'ATTEMPTED',rawCompilerOutputCaptured:false})+'\n');
  const compilation=compileDeploymentArtifacts({assetMode}),artifact=compilation.artifacts.escrow,metadata=artifact.metadata;
  writeFileSync(`${base}/deployment-build.log`,compilation.log);
  const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),changes=spawnSync('git',['status','--porcelain','--untracked-files=all','--','contracts/src','contracts/foundry.toml','packages','scripts','pnpm-lock.yaml','package.json'],{encoding:'utf8'});
  if(commandExit(revision)!==0||commandExit(changes)!==0)throw new Error('SOURCE_REVISION_UNAVAILABLE');
  const build={artifactSha256:compilation.bindings.find(value=>value.path.endsWith('/ContextVoteEscrow.json'))!.sha256,sourceCommit:revision.stdout.trim(),worktreeDirty:changes.stdout.trim()!=='',compiler:metadata.compiler.version,settings:metadata.settings,sources:metadata.sources,artifactBindings:compilation.bindings,creationBytecodeHashes:compilation.creationBytecodeHashes,forcedRebuild:true,rawCompilerOutputCaptured:false,evidence:`${base}/deployment-build.log`};
  const names=['CHAIN_ID','DEPLOYER_ADDRESS',assetConfigurationKey(process.env),'ELIGIBILITY_GATE_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','MONAD_RPC_URL'],missing=names.filter(n=>!process.env[n]);
  if(missing.length){report={status:'BLOCKED',reason:'DEPLOYMENT_CONFIGURATION_MISSING',missing,build};}
  else{
    const config=DeploymentConfigSchema.parse({chainId:process.env.CHAIN_ID,deployer:process.env.DEPLOYER_ADDRESS,asset:configuredAssetAddress(process.env),gate:process.env.ELIGIBILITY_GATE_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(v=>v.trim())});
    const endpoint=new URL(process.env.MONAD_RPC_URL!);if(endpoint.protocol!=='https:')throw new Error('RPC_ENDPOINT_INVALID');
    const draft=deploymentDraft(config,artifact),client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    const inspection=await inspectDeployment(config,{chainId:()=>client.getChainId(),block:number=>number===undefined?client.getBlock({blockTag:'finalized'}):client.getBlock({blockNumber:number}),code:(address,blockNumber)=>client.getCode({address,blockNumber}),balance:(address,blockNumber)=>client.getBalance({address,blockNumber})});
    report={status:'BLOCKED',reason:assetMode==='demo-erc20'?'UNSIGNED_DRAFT_ONLY_GAS_AND_CREATION_AND_FUNDING_NOT_VERIFIED':'UNSIGNED_DRAFT_ONLY_OFFICIAL_INTEGRATION_AND_GAS_AND_RECEIPT_NOT_VERIFIED',build,draft,inspection};
  }
  compilation.assertCurrent();
  report.assetMode=assetMode;
}catch{report={status:'BLOCKED',reason:'DEPLOYMENT_PREPARATION_UNAVAILABLE_OR_INVALID_INPUT'};}
report={startedAt,endedAt:new Date().toISOString(),scope:'NO_SIGNATURE_NO_BROADCAST_DEPLOYMENT_PREPARATION',...report,transactionsSent:0};writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,evidence:path}));process.exitCode=1;
