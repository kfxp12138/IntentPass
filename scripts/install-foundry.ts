import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,rmSync,mkdtempSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {z} from 'zod';
import {foundryVersion} from './foundry-runtime.js';
const assetSchema=z.object({name:z.string(),browser_download_url:z.string().url(),digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),size:z.number().int().positive().max(350000000)});
const releaseSchema=z.object({tag_name:z.literal(`v${foundryVersion}`),assets:z.array(assetSchema)});
const directory=mkdtempSync(join(tmpdir(),'intentpass-foundry-install-'));
try {
  if(!['darwin','linux'].includes(process.platform)||!['arm64','x64'].includes(process.arch))throw new Error('UNSUPPORTED_PLATFORM');
  const name=`foundry_v${foundryVersion}_${process.platform}_${process.arch==='x64'?'amd64':'arm64'}.tar.gz`;
  const source=`https://api.github.com/repos/foundry-rs/foundry/releases/tags/v${foundryVersion}`;
  const metadata=await fetch(source,{signal:AbortSignal.timeout(30000)});if(!metadata.ok)throw new Error('RELEASE_UNAVAILABLE');
  const asset=releaseSchema.parse(await metadata.json()).assets.find(a=>a.name===name);if(!asset)throw new Error('RELEASE_ASSET_MISSING');
  const expectedUrl=`https://github.com/foundry-rs/foundry/releases/download/v${foundryVersion}/${name}`;
  if(asset.browser_download_url!==expectedUrl)throw new Error('RELEASE_ORIGIN_MISMATCH');
  const download=await fetch(expectedUrl,{signal:AbortSignal.timeout(120000)});if(!download.ok)throw new Error('DOWNLOAD_UNAVAILABLE');
  const content=Buffer.from(await download.arrayBuffer()),digest=createHash('sha256').update(content).digest('hex');
  if(content.length!==asset.size||`sha256:${digest}`!==asset.digest)throw new Error('RELEASE_DIGEST_MISMATCH');
  const archive=join(directory,'release.tar.gz');writeFileSync(archive,content);
  const listing=spawnSync('tar',['-tvzf',archive],{encoding:'utf8'});if(listing.status!==0)throw new Error('INVALID_RELEASE_ARCHIVE');
  const names=['forge','anvil','cast','chisel','solar'];
  for(const file of names){const entries=listing.stdout.split('\n').filter(line=>line.endsWith(` ${file}`));if(entries.length!==1||!entries[0].startsWith('-'))throw new Error('INVALID_RELEASE_MEMBER');}
  const target=resolve(`.tools/foundry-v${foundryVersion}`);mkdirSync(target,{recursive:true});
  const extracted=spawnSync('tar',['-xzf',archive,'-C',directory,...names]);if(extracted.status!==0)throw new Error('EXTRACTION_FAILED');
  for(const file of names){writeFileSync(join(target,file),readFileSync(join(directory,file)));chmodSync(join(target,file),0o755);}
  writeFileSync(join(target,'release.json'),JSON.stringify({version:foundryVersion,source,asset:name,sha256:digest,binaries:names},null,2)+'\n');
  console.log(`Installed SHA-256 verified Foundry ${foundryVersion} in project .tools; global tools unchanged.`);
}catch(error){console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'FOUNDRY_INSTALL_FAILED');process.exitCode=1;}
finally{rmSync(directory,{recursive:true,force:true});}
