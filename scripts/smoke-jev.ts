import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { jevSmoke } from '../packages/adapters/src/jev.js';
if(existsSync('.env')) loadEnvFile('.env');
const key=process.env.TYPESAFE_API_KEY, model=process.env.JEV_MODEL;
if(!key||!model) { console.error('BLOCKED: TYPESAFE_API_KEY / JEV_MODEL required');process.exit(1); }
try {
  const result=await jevSmoke(key,model);
  mkdirSync('artifacts/acceptance',{recursive:true});
  writeFileSync('artifacts/acceptance/jev-smoke.json',JSON.stringify({at:new Date().toISOString(),...result},null,2)+'\n');
  console.log('Real JEV connectivity response validated; no executable receipt issued.');
} catch(error) {
  const code=error instanceof Error && /^JEV_(HTTP_\d+|RESPONSE_INVALID)$/.test(error.message)?error.message:'JEV_UNAVAILABLE';
  console.error(code);process.exitCode=1;
}
