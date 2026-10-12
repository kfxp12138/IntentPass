import {existsSync,readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {loadEnvFile} from 'node:process';
import {spawnSync} from 'node:child_process';
import {createPublicClient,http,parseAbi,type Address} from 'viem';
import {build} from 'vite';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {commandExit} from './verification-outcome.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {deploymentProofPort} from '../packages/protocol/src/deployment-proof-port.js';
import {cleanverseGateProofPort} from '../packages/protocol/src/cleanverse-gate-proof-port.js';
import {CleanverseBootstrapConfigSchema} from '../packages/protocol/src/cleanverse-bootstrap.js';
import {DeploymentConfigSchema} from '../packages/protocol/src/deployment.js';
import {MetaMaskDeploymentService,type MetaMaskReadPort} from './metamask-service.js';
import {MetaMaskGateDeploymentService,type MetaMaskGateReadPort} from './metamask-gate-service.js';
import {createMetaMaskServer,type MetaMaskOperatorService,type MetaMaskStaticFile} from './metamask-server.js';
import {configuredAssetMode,assetConfigurationKey,configuredAssetAddress} from '../packages/protocol/src/asset-mode.js';
import {configuredMetaMaskOperatorPort} from './metamask-operator-port.js';
const gateMode=process.argv.length===3&&process.argv[2]==='--gate';
if(process.argv.length!==2&&!gateMode){console.error('ARGUMENT_INVALID');process.exit(1);}
const scope=gateMode?'LOCAL_OPERATOR_CLEANVERSE_GATE_HANDOFF':'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF';
if(existsSync('.env'))loadEnvFile('.env');
let operatorPort:number;
try{operatorPort=configuredMetaMaskOperatorPort(process.env.METAMASK_OPERATOR_PORT);}
catch{console.error('METAMASK_OPERATOR_PORT_INVALID');process.exit(1);}
const assetMode=configuredAssetMode(process.env);
if(gateMode&&assetMode==='demo-erc20'){console.error('LEGACY_CLEANVERSE_ROUTE_DISABLED');process.exit(1);}
const names=['CHAIN_ID','DEPLOYER_ADDRESS',assetConfigurationKey(process.env),...(gateMode?['CVI_VALIDATOR_ADDRESS','CVA_POLICY_ADDRESS','CLEANVERSE_GATE_NONCE']:['ELIGIBILITY_GATE_ADDRESS']),'REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','MONAD_RPC_URL','METAMASK_DEPLOYMENT_DB_PATH'],missing=names.filter(name=>!process.env[name]);
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});if(commandExit(revision)!==0)throw new Error('SOURCE_REVISION_UNAVAILABLE');
const sourceCommit=revision.stdout.trim(),sourceClean=()=>{
  const head=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),status=spawnSync('git',['status','--porcelain','--untracked-files=all','--','contracts/src','contracts/foundry.toml','packages','scripts','apps','tests','pnpm-lock.yaml','package.json','tsconfig.json'],{encoding:'utf8'});
  return commandExit(head)===0&&head.stdout.trim()===sourceCommit&&commandExit(status)===0&&!status.stdout.trim();
};
let store:DeploymentAttemptStore|undefined,service:MetaMaskOperatorService|undefined,blockers=missing.map(name=>`MISSING_${name}`);
if(!missing.length){
  try{
    const roles={chainId:process.env.CHAIN_ID,deployer:process.env.DEPLOYER_ADDRESS,asset:configuredAssetAddress(process.env),reviewer:process.env.REVIEWER_ADDRESS,committee:process.env.COMMITTEE_ADDRESSES!.split(',').map(v=>v.trim())};
    const config=gateMode?CleanverseBootstrapConfigSchema.parse({...roles,validator:process.env.CVI_VALIDATOR_ADDRESS,policy:process.env.CVA_POLICY_ADDRESS}):DeploymentConfigSchema.parse({...roles,gate:process.env.ELIGIBILITY_GATE_ADDRESS});
    if(config.chainId!=='10143')throw new Error('METAMASK_TESTNET_REQUIRED');
    let gateNonce:bigint|undefined;
    if(gateMode){const raw=process.env.CLEANVERSE_GATE_NONCE!;if(!/^(0|[1-9][0-9]*)$/.test(raw)||raw.length>16||BigInt(raw)>=BigInt(Number.MAX_SAFE_INTEGER))throw new Error('METAMASK_GATE_NONCE_INVALID');gateNonce=BigInt(raw);}
    const endpoint=new URL(process.env.MONAD_RPC_URL!);if(endpoint.protocol!=='https:')throw new Error('RPC_ENDPOINT_INVALID');
    const db=process.env.METAMASK_DEPLOYMENT_DB_PATH!;if(!isAbsolute(db)||!db.endsWith('.db'))throw new Error('DATABASE_CONFIGURATION_INVALID');
    const compilation=compileDeploymentArtifacts({assetMode}),{escrow:artifact,gate:gateArtifact}=compilation.artifacts;
    const compiledSourceClean=()=>sourceClean()&&compilation.isCurrent();
    const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    const gateAbi=parseAbi(['function asset() view returns(address)','function validator() view returns(address)','function policy() view returns(address)','function pool() view returns(address)']);
    const port:MetaMaskReadPort={chainId:()=>client.getChainId(),block:n=>n===undefined?client.getBlock({blockTag:'finalized'}):client.getBlock({blockNumber:n}),code:(address,blockNumber)=>client.getCode({address,blockNumber}),balance:(address,blockNumber)=>client.getBalance({address,blockNumber}),currentBalance:address=>client.getBalance({address,blockTag:'pending'}),nonce:async(address,blockTag)=>BigInt(await client.getTransactionCount({address,blockTag})),estimate:tx=>client.estimateGas(tx),fees:async()=>{const f=await client.estimateFeesPerGas({chain:null,type:'eip1559'});return {maxFeePerGas:f.maxFeePerGas,maxPriorityFeePerGas:f.maxPriorityFeePerGas};},gate:async(address,blockNumber)=>{
      if(assetMode==='demo-erc20')throw Error('LEGACY_CLEANVERSE_ROUTE_DISABLED');
      const args={address,blockNumber,abi:gateAbi};
      const [asset,validator,policy,pool]=await Promise.all((['asset','validator','policy','pool'] as const).map(functionName=>client.readContract({...args,functionName})));
      const assetPolicy=await client.readContract({address:asset as Address,abi:gateAbi,functionName:'policy',blockNumber});return {asset,validator,policy,pool,assetPolicy};
    },demoGate:async(address,blockNumber)=>({asset:await client.readContract({address,blockNumber,abi:gateAbi,functionName:'asset'})}),proof:deploymentProofPort(client)};
    store=new DeploymentAttemptStore(db);
    if(gateMode){const gatePort:MetaMaskGateReadPort={...port,assetPolicy:(address,blockNumber)=>client.readContract({address,blockNumber,abi:gateAbi,functionName:'policy'}),proof:cleanverseGateProofPort(client)};
      service=new MetaMaskGateDeploymentService({config,gateArtifact,escrowArtifact:artifact,nonce:gateNonce!,sourceCommit,sourceClean:compiledSourceClean,store,port:gatePort});
    }else service=new MetaMaskDeploymentService({config,artifact,gateArtifact,assetMode,sourceCommit,sourceClean:compiledSourceClean,store,port});
    blockers=[];
  }catch{store?.close();store=undefined;blockers=['DEPLOYMENT_CONFIGURATION_OR_BUILD_INVALID'];}
}
const output=resolve(gateMode?'.tools/metamask-gate-web':'.tools/metamask-deployment-web');mkdirSync(output,{recursive:true});
await build({root:resolve(gateMode?'scripts/metamask-gate-page':'scripts/metamask-page'),configFile:false,publicDir:false,logLevel:'error',build:{outDir:output,emptyOutDir:true,sourcemap:false}});
const staticFiles=new Map<string,MetaMaskStaticFile>();
function collect(directory:string){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())collect(path);else if(entry.isFile()){const name=relative(output,path).replaceAll('\\','/'),type=name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':undefined;if(type)staticFiles.set(name==='index.html'?'/':`/${name}`,{body:readFileSync(path),contentType:type});}}}
collect(output);
const app=createMetaMaskServer({service,scope,blockers,staticFiles});
app.server.listen(operatorPort,'127.0.0.1',()=>{const address=app.server.address();if(address&&typeof address==='object')console.log(JSON.stringify({url:`http://127.0.0.1:${address.port}`,scope,ready:service?.status().ready??false,blockers:service?.status().blockers??blockers,transactionsSentByServer:0}));});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await app.close();store?.close();process.exit(0);});
