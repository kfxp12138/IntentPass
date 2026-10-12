import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { integrationStatus } from '../packages/adapters/src/status.js';
import { settlementRoute } from '../packages/protocol/src/route.js';
if (existsSync('.env')) loadEnvFile('.env');
const report = { at: new Date().toISOString(), node: process.version, stage:'D1', settlementRoute,
  integrations: integrationStatus(), note:'Configuration presence is not smoke evidence. Values intentionally omitted.' };
mkdirSync('artifacts/acceptance',{recursive:true});
writeFileSync('artifacts/acceptance/doctor.json', JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=1;
