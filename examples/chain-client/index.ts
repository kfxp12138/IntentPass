import {readFileSync} from 'node:fs';
import {runChainExample} from './client.js';
// No server .env, user token, original authorization or private wallet data.
try{
  const manifest=JSON.parse(readFileSync(new URL('./monad-testnet.json',import.meta.url),'utf8'));
  process.exitCode=await runChainExample(process.argv.slice(2),{INTENTPASS_RPC_URL:process.env.INTENTPASS_RPC_URL},{manifest,out:value=>process.stdout.write(JSON.stringify(value,null,2)+'\n'),error:code=>process.stderr.write(code+'\n')});
}catch{console.error('PUBLIC_DEPLOYMENT_MANIFEST_UNAVAILABLE');process.exitCode=1;}
