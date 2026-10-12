import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync,existsSync,readdirSync} from 'node:fs';
import {resolve,relative,basename} from 'node:path';
import {createHash} from 'node:crypto';
export interface Finding {path:string;line:number;rule:string;}
/** Heuristics and raw byte inspection, not a proof against encoded secrets or
 * private text in image/video pixels. Findings never contain the matched value.
 */
export function auditBytes(path:string,bytes:Uint8Array):Finding[]{const text=Buffer.from(bytes).toString('latin1'),rules:[string,RegExp][]=[
  ['PRIVATE_KEY_PEM',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['API_KEY_LITERAL',/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/g],
  ['TYPESAFE_API_KEY_LITERAL',/\bapikey_[A-Za-z0-9_]{32,}/g],
  ['ARK_API_KEY_LITERAL',/\bark-[A-Za-z0-9-]{24,}/g],
  ['BEARER_JWT_LITERAL',/Bearer\s+[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ['CREDENTIAL_LITERAL',/["']?(?:api[_-]?key|app[_-]?secret|privy[_-]?app[_-]?secret|authorization[_-]?private[_-]?key|privy[_-]?authorization[_-]?private[_-]?key|private[_-]?key|access[_-]?token|prf[_-]?output|derived[_-]?key)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=.-]{24,}["']/gi],
  ['AUTHENTICATED_URL_LITERAL',/https?:\/\/[^\s"'`<>/:]+(?::[^\s"'`<>/@]+)?@[^\s"'`<>]+/g],
];return rules.flatMap(([rule,pattern])=>Array.from(text.matchAll(pattern),match=>({path,line:text.slice(0,match.index).split('\n').length,rule})));}
export function auditPublicTree(root:string){const exclusions=['node_modules/**','**/node_modules/**','.git/**','.tools/**','.pnpm-store/**','cache/**','contracts/out/**','contracts/cache/**','*.db','*.db-*','.env','.env.*','**/.DS_Store','artifacts/acceptance/public-audit.json'];
  const result=spawnSync('rg',['--files','--hidden','--no-ignore','-0',...exclusions.flatMap(p=>['-g','!'+p])],{cwd:root,encoding:'utf8',maxBuffer:16000000});if(result.error||result.status!==0)throw new Error('PUBLIC_AUDIT_DISCOVERY_UNAVAILABLE');
  const discovered=result.stdout.split('\0').filter(Boolean),files=new Set(discovered);
  // rg does not inventory symlinks. Record their names without following targets.
  const visit=(directory:string)=>{for(const entry of readdirSync(resolve(root,directory),{withFileTypes:true})){const name=directory?directory+'/'+entry.name:entry.name;if(entry.isSymbolicLink()){if(!entry.name.startsWith('.env')&&!/\.db(?:-|$)/.test(entry.name))files.add(name);}else if(entry.isDirectory()&&!['node_modules','.git','.tools','.pnpm-store','cache'].includes(entry.name)&&name!=='contracts/out')visit(name);}};visit('');if(existsSync(resolve(root,'.env.example')))files.add('.env.example');const findings:Finding[]=[],manifest:{path:string;bytes:number;sha256:string;binary:boolean}[]=[],unverified:string[]=[];
  for(const name of [...files].sort()){if(basename(name)==='.env'||basename(name).startsWith('.env.')&&basename(name)!=='.env.example')continue;const absolute=resolve(root,name),local=relative(resolve(root),absolute);if(local.startsWith('..')||lstatSync(absolute).isSymbolicLink()){unverified.push(name);continue;}const bytes=readFileSync(absolute),binary=bytes.includes(0)||/\.(?:png|jpg|jpeg|gif|webp|mp4|mov|pdf|zip|wasm)$/i.test(name);findings.push(...auditBytes(name,bytes));manifest.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),binary});if(binary)unverified.push(name);}
  return {scope:'PUBLIC_SOURCE_BUILD_LOG_RAW_BYTES_HEURISTIC_ONLY',status:findings.length?'FAIL':unverified.length?'BLOCKED':'PASS',findings,unverified,manifest,exclusions,limits:['No OCR or decoding of media/archive contents.','No proof against obfuscation or arbitrary private task text.','Server .env, databases, dependencies and isolated tools excluded; values never read.']} as const;
}
