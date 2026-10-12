import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {configuredAssetMode} from '../packages/protocol/src/asset-mode.js';
if(existsSync('.env'))loadEnvFile('.env');
if(configuredAssetMode(process.env)==='demo-erc20')await import('./inspect-demo-chain-flow.js');
else await import('./inspect-day4-chain-flow.js');
