import {existsSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {createPublicClient,http} from 'viem';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {verifyDeploymentCreation} from '../packages/protocol/src/deployment-proof.js';
import {deploymentProofPort} from '../packages/protocol/src/deployment-proof-port.js';
import {configuredAssetMode,assetConfigurationKey,configuredAssetAddress} from '../packages/protocol/src/asset-mode.js';
const startedAt=new Date().toISOString(),base='artifacts/acceptance',path=`${base}/deployment-proof.json`;mkdirSync(base,{recursive:true});
if(existsSync(path)){const history=`${base}/history/${startedAt.replaceAll(':','-')}-deployment-proof`;mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/deployment-proof.json`);if(existsSync(`${base}/deployment-proof-build.log`))copyFileSync(`${base}/deployment-proof-build.log`,`${history}/deployment-proof-build.log`);}
let report:Record<string,unknown>;
try{
  if(existsSync('.env'))loadEnvFile('.env');
  const assetMode=configuredAssetMode(process.env),names=['CHAIN_ID','DEPLOYER_ADDRESS',assetConfigurationKey(process.env),'ELIGIBILITY_GATE_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','MONAD_RPC_URL'],missing=names.filter(n=>!process.env[n]);
  if(missing.length||process.argv.length!==3){report={status:'BLOCKED',reason:'DEPLOYMENT_PROOF_CONFIGURATION_OR_HASH_MISSING',missing};}
  else{
    const endpoint=new URL(process.env.MONAD_RPC_URL!);if(endpoint.protocol!=='https:')throw new Error('RPC_ENDPOINT_INVALID');
    writeFileSync(`${base}/deployment-proof-build.log`,JSON.stringify({scope:'FORCED_LOCAL_DEPLOYMENT_COMPILATION',status:'ATTEMPTED',rawCompilerOutputCaptured:false})+'\n');
    const compilation=compileDeploymentArtifacts({assetMode}),artifact=compilation.artifacts.escrow,metadata=artifact.metadata;
    writeFileSync(`${base}/deployment-proof-build.log`,compilation.log);
    const config={chainId:process.env.CHAIN_ID,deployer:process.env.DEPLOYER_ADDRESS,asset:configuredAssetAddress(process.env),gate:process.env.ELIGIBILITY_GATE_ADDRESS,reviewer:process.env.REVIEWER_ADDRESS,committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(v=>v.trim())};
    const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    const proof=await verifyDeploymentCreation(config,artifact,process.argv[2],deploymentProofPort(client));
    compilation.assertCurrent();
    report={status:'BLOCKED',reason:assetMode==='demo-erc20'?'CREATION_PROOF_DOES_NOT_VERIFY_ACTUAL_FUNDING_OR_POLICY_ACCEPTANCE':'CREATION_PROOF_DOES_NOT_VERIFY_OFFICIAL_ASSET_OR_IDENTITY_INTEGRATION',creationProof:proof,artifactSha256:compilation.bindings.find(value=>value.path.endsWith('/ContextVoteEscrow.json'))!.sha256,compiler:metadata.compiler,settings:metadata.settings,artifactBindings:compilation.bindings,creationBytecodeHashes:compilation.creationBytecodeHashes,forcedRebuild:true,rawCompilerOutputCaptured:false};
  }
  report.assetMode=assetMode;
}catch(error){const mismatch=error instanceof Error&&/^DEPLOYMENT_[A-Z_]+(?:MISMATCH|INCONSISTENT|INVALID|NOT_CANONICAL|CODE_MISSING|SNAPSHOT_CHANGED|UNSUPPORTED)$/.test(error.message);report={status:mismatch?'FAIL':'BLOCKED',reason:mismatch?(error as Error).message:'DEPLOYMENT_PROOF_UNAVAILABLE_OR_INVALID_INPUT'};}
report={startedAt,endedAt:new Date().toISOString(),scope:'READ_ONLY_ORIGINAL_CREATION_AND_CURRENT_RUNTIME_PROOF',...report,transactionsSent:0};writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,reason:report.reason,missing:report.missing,evidence:path}));process.exitCode=1;
