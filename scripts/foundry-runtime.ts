import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
export const foundryVersion='1.8.0';
export function nativeFoundryBinary(name:'forge'|'anvil'):string {
  const isolated=resolve(`.tools/foundry-v${foundryVersion}/${name}`);
  const candidates=existsSync(isolated)?[isolated,name]:[name];
  for(const candidate of candidates) {
    const result=spawnSync(candidate,['--version'],{encoding:'utf8'});
    if(result.status===0&&new RegExp(`Version: ${foundryVersion.replaceAll('.','\\.')}\\b`).test(result.stdout))return candidate;
  }
  throw new Error('FOUNDRY_1_8_REQUIRED: run pnpm tools:foundry');
}
