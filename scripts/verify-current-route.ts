import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {configuredAssetMode} from '../packages/protocol/src/asset-mode.js';
if(existsSync('.env'))loadEnvFile('.env');
const day=Number(process.argv[2]);if(!Number.isInteger(day)||day<1||day>7){console.error('ARGUMENT_INVALID');process.exit(1);}
if(configuredAssetMode(process.env)==='demo-erc20')await import('./verify-demo-scope.js');
else if(day===1)await import('./verify.js');
else await import(`./verify-day${day}.js`);
