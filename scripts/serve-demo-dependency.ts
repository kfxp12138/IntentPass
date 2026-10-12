import {existsSync,readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {loadEnvFile} from 'node:process';
import {spawnSync} from 'node:child_process';
import {createPublicClient,http,parseAbi,type Address,type Hex} from 'viem';
import {build} from 'vite';
import {compileDeploymentArtifacts} from './deployment-artifacts.js';
import {commandExit} from './verification-outcome.js';
import {configuredAssetMode} from '../packages/protocol/src/asset-mode.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {MetaMaskDemoDependencyService} from './metamask-demo-service.js';
import type {DemoDependencyReadPort} from './demo-dependency.js';
import {createMetaMaskServer,type MetaMaskOperatorService,type MetaMaskStaticFile} from './metamask-server.js';
import {configuredMetaMaskOperatorPort} from './metamask-operator-port.js';
if(process.argv.length!==3||!['--asset','--gate'].includes(process.argv[2]!)){console.error('ARGUMENT_INVALID');process.exit(1);}
if(existsSync('.env'))loadEnvFile('.env');
let operatorPort:number;
try{operatorPort=configuredMetaMaskOperatorPort(process.env.METAMASK_OPERATOR_PORT);}
catch{console.error('METAMASK_OPERATOR_PORT_INVALID');process.exit(1);}
if(configuredAssetMode(process.env)!=='demo-erc20'){console.error('DEMO_ASSET_MODE_REQUIRED');process.exit(1);}
const dependency=process.argv[2]==='--asset'?'ASSET':'GATE';
const names=['CHAIN_ID','DEPLOYER_ADDRESS','MONAD_RPC_URL','METAMASK_DEPLOYMENT_DB_PATH',...(dependency==='GATE'?['ASSET_ADDRESS']:[])],missing=names.filter(name=>!process.env[name]?.trim());
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});if(commandExit(revision)!==0)throw Error('SOURCE_REVISION_UNAVAILABLE');
const sourceCommit=revision.stdout.trim(),sourceClean=()=>{const head=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),changes=spawnSync('git',['status','--porcelain','--untracked-files=all','--','contracts/src','contracts/foundry.toml','packages','scripts','apps','tests','pnpm-lock.yaml','package.json','tsconfig.json'],{encoding:'utf8'});return commandExit(head)===0&&head.stdout.trim()===sourceCommit&&commandExit(changes)===0&&!changes.stdout.trim();};
let store:DeploymentAttemptStore|undefined,service:MetaMaskOperatorService|undefined,blockers=missing.map(name=>'MISSING_'+name);
if(!missing.length)try{
  if(process.env.CHAIN_ID!=='10143')throw Error('METAMASK_TESTNET_REQUIRED');
  const endpoint=new URL(process.env.MONAD_RPC_URL!);if(endpoint.protocol!=='https:')throw Error('RPC_ENDPOINT_INVALID');
  const db=process.env.METAMASK_DEPLOYMENT_DB_PATH!;if(!isAbsolute(db)||!db.endsWith('.db'))throw Error('DATABASE_CONFIGURATION_INVALID');
  const compilation=compileDeploymentArtifacts({assetMode:'demo-erc20'});if(!compilation.artifacts.asset)throw Error('DEPLOYMENT_DEMO_ASSET_ARTIFACT_REQUIRED');
  const client=createPublicClient({transport:http(endpoint.href,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
  const tokenAbi=parseAbi(['function name() view returns(string)','function symbol() view returns(string)','function decimals() view returns(uint8)','function totalSupply() view returns(uint256)']);
  const port:DemoDependencyReadPort={chainId:()=>client.getChainId(),block:n=>n===undefined?client.getBlock({blockTag:'finalized'}):client.getBlock({blockNumber:n}),code:(address,blockNumber)=>client.getCode({address,blockNumber}),nonce:async(address,blockTag)=>BigInt(await client.getTransactionCount({address,blockTag})),balance:address=>client.getBalance({address,blockTag:'pending'}),fees:async()=>{const f=await client.estimateFeesPerGas({chain:null,type:'eip1559'});return {maxFeePerGas:f.maxFeePerGas,maxPriorityFeePerGas:f.maxPriorityFeePerGas};},estimate:tx=>client.estimateGas(tx),token:async(address,blockNumber)=>{
    const common={address,blockNumber,abi:tokenAbi};
    const [name,symbol,decimals,totalSupply]=await Promise.all([client.readContract({...common,functionName:'name'}),client.readContract({...common,functionName:'symbol'}),client.readContract({...common,functionName:'decimals'}),client.readContract({...common,functionName:'totalSupply'})]);return {name,symbol,decimals,totalSupply};
  },gate:async(address,blockNumber)=>({asset:await client.readContract({address,blockNumber,abi:parseAbi(['function asset() view returns(address)']),functionName:'asset'})}),transaction:async hash=>{try{return await client.getTransaction({hash});}catch(error){if(error instanceof Error&&error.name==='TransactionNotFoundError')return null;throw Error('DEPLOYMENT_TRANSACTION_UNAVAILABLE');}},receipt:async hash=>{try{const receipt=await client.getTransactionReceipt({hash});return {...receipt,contractAddress:receipt.contractAddress??null};}catch(error){if(error instanceof Error&&error.name==='TransactionReceiptNotFoundError')return null;throw Error('DEPLOYMENT_RECEIPT_UNAVAILABLE');}}};
  store=new DeploymentAttemptStore(db);
  service=new MetaMaskDemoDependencyService({dependency,config:{chainId:'10143',deployer:process.env.DEPLOYER_ADDRESS,...(dependency==='GATE'?{asset:process.env.ASSET_ADDRESS}: {})},artifact:dependency==='ASSET'?compilation.artifacts.asset:compilation.artifacts.gate,assetArtifact:compilation.artifacts.asset,sourceCommit,sourceClean:()=>sourceClean()&&compilation.isCurrent(),store,port});blockers=[];
}catch{store?.close();store=undefined;blockers=['DEPLOYMENT_CONFIGURATION_OR_BUILD_INVALID'];}
const output=resolve('.tools/metamask-demo-dependency-web');mkdirSync(output,{recursive:true});
await build({root:resolve('scripts/metamask-page'),configFile:false,publicDir:false,logLevel:'error',build:{outDir:output,emptyOutDir:true,sourcemap:false}});
const staticFiles=new Map<string,MetaMaskStaticFile>();
const collect=(folder:string)=>{for(const entry of readdirSync(folder,{withFileTypes:true})){const path=resolve(folder,entry.name);if(entry.isDirectory())collect(path);else if(entry.isFile()){const name=relative(output,path).replaceAll('\\','/'),contentType=name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':undefined;if(contentType)staticFiles.set(name==='index.html'?'/':'/'+name,{body:readFileSync(path),contentType});}}};collect(output);
const app=createMetaMaskServer({service,blockers,staticFiles});app.server.listen(operatorPort,'127.0.0.1',()=>{const address=app.server.address();if(address&&typeof address==='object'){const status=service?.status();console.log(JSON.stringify({url:`http://127.0.0.1:${address.port}`,assetMode:'demo-erc20',dependency,sourceCommit,ready:status?.ready??false,blockers:status?.blockers??blockers,transactionsSentByServer:0}));}});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await app.close();store?.close();process.exit(0);});
