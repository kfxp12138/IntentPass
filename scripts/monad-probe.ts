import {createPublicClient,http} from 'viem';
import {mkdirSync,writeFileSync,existsSync,copyFileSync} from 'node:fs';
const mode=process.argv[2],startedAt=new Date().toISOString(),base='artifacts/acceptance',path=`${base}/monad-network.json`;mkdirSync(base,{recursive:true});
if(existsSync(path)){const history=`${base}/history/${startedAt.replaceAll(':','-')}-monad-network`;mkdirSync(history,{recursive:true});copyFileSync(path,`${history}/monad-network.json`);}
let report:Record<string,unknown>;
try{
  if(!['--testnet','--mainnet'].includes(mode)||process.argv.length!==3)throw new Error('ARGUMENT_INVALID');
  const chainId=mode==='--testnet'?10143:143,url=mode==='--testnet'?'https://testnet-rpc.monad.xyz':'https://rpc.monad.xyz';
  const client=createPublicClient({transport:http(url,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
  if(await client.getChainId()!==chainId)throw new Error('CHAIN_MISMATCH');
  const block=await client.getBlock({blockTag:'finalized'});if(block.number===null||block.hash===null)throw new Error('FINALIZED_UNAVAILABLE');
  if((await client.getBlock({blockNumber:block.number})).hash!==block.hash||await client.getChainId()!==chainId)throw new Error('SNAPSHOT_CHANGED');
  report={status:'PASS',chainId:String(chainId),publicRpc:url,block:{number:String(block.number),hash:block.hash,timestamp:String(block.timestamp)},source:'https://docs.monad.xyz/ai/current-facts'};
}catch{report={status:'BLOCKED',reason:'PUBLIC_MONAD_READ_PROBE_UNAVAILABLE_OR_INVALID_ARGUMENT'};}
report={startedAt,endedAt:new Date().toISOString(),scope:'READ_ONLY_PUBLIC_MONAD_NETWORK_CONNECTIVITY',...report,transactionsSent:0,officialAssetVerified:false,deploymentVerified:false};writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));process.exitCode=report.status==='PASS'?0:1;
