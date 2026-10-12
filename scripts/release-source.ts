import {spawnSync} from 'node:child_process';
import {constants,lstatSync,realpathSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {resolve,dirname,extname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';

const maximumFileBytes=32000000,maximumFiles=8192,maximumTotalBytes=128000000;
const fixed=new Set(['README.md','LICENSE','pnpm-lock.yaml','package.json','tsconfig.json','.env.example','contracts/foundry.toml',
  'docs/architecture.md','docs/submission.md','docs/monad-deployment.md','docs/decisions.md','docs/interfaces.md','docs/threat-model.md','docs/attribution.md','docs/judge-access.md',
  'examples/chain-client/monad-testnet.json','deploy/systemd/intentpass.service','deploy/caddy/Caddyfile','deploy/README.md']);
const extensions=new Set(['.ts','.tsx','.js','.mjs','.cjs','.css','.html','.sol','.sql']);
const excluded=new Set(['node_modules','dist','out','cache','artifacts','acceptance']);
function selected(path:string){
  if(fixed.has(path))return true;
  const parts=path.split('/');
  if(parts.some(part=>part.startsWith('.')||excluded.has(part)||/[.]db(?:-|$)/i.test(part)))return false;
  if(/^fixtures\//.test(path))return extname(path)==='.json';
  return /^(?:apps|packages|scripts|tests)\//.test(path)||/^contracts\/src\//.test(path)
    ?extensions.has(extname(path))||parts.at(-1)==='package.json':false;
}
const safePath=(path:string)=>selected(path)&&(path==='.env.example'||/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(path));
const binding=z.object({path:z.string().max(4096).refine(safePath),bytes:z.number().int().nonnegative().safe().max(maximumFileBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const snapshot=z.object({sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),bindings:z.array(binding).min(1).max(maximumFiles)}).strict().superRefine((value,ctx)=>{
  if(value.bindings.some((entry,index)=>index>0&&entry.path<=value.bindings[index-1].path)||value.bindings.reduce((sum,entry)=>sum+entry.bytes,0)>maximumTotalBytes)
    ctx.addIssue({code:'custom',message:'RELEASE_SOURCE_BINDINGS_INVALID'});
});
export type ReleaseSourceSnapshot=z.infer<typeof snapshot>;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fail=(code:string):never=>{throw Error(code);};
const errors=new Set(['RELEASE_SOURCE_GIT_UNAVAILABLE','RELEASE_SOURCE_PATH_INVALID','RELEASE_SOURCE_FILE_INVALID','RELEASE_SOURCE_CHANGED_DURING_CAPTURE','RELEASE_SOURCE_BINDINGS_INVALID']);

function canonicalPath(absolute:string){
  if(realpathSync(absolute)!==absolute)fail('RELEASE_SOURCE_PATH_INVALID');
  for(let current=absolute;;current=dirname(current)){
    if(lstatSync(current).isSymbolicLink())fail('RELEASE_SOURCE_PATH_INVALID');
    if(dirname(current)===current)break;
  }
}
function stableBytes(root:string,path:string){
  if(!safePath(path))fail('RELEASE_SOURCE_PATH_INVALID');
  const absolute=resolve(root,path);if(!absolute.startsWith(root+sep))fail('RELEASE_SOURCE_PATH_INVALID');canonicalPath(absolute);
  const before=lstatSync(absolute);if(!before.isFile()||before.size>maximumFileBytes)fail('RELEASE_SOURCE_FILE_INVALID');
  const same=(stat:NonNullable<ReturnType<typeof lstatSync>>)=>before.ino===stat.ino&&before.dev===stat.dev&&before.size===stat.size&&before.mtimeMs===stat.mtimeMs;
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(before.size);
  try{
    if(!same(fstatSync(fd)))fail('RELEASE_SOURCE_CHANGED_DURING_CAPTURE');
    let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(count===0)break;offset+=count;}
    if(offset!==before.size||!same(fstatSync(fd))||!same(lstatSync(absolute)))fail('RELEASE_SOURCE_CHANGED_DURING_CAPTURE');
    canonicalPath(absolute);
  }finally{closeSync(fd);}
  return bytes;
}
function git(root:string,args:string[]){
  const result=spawnSync('git',['-c','core.fsmonitor=false','-c','core.untrackedCache=false',...args],{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:4000000});
  if(result.error||result.signal||result.status!==0)fail('RELEASE_SOURCE_GIT_UNAVAILABLE');return result.stdout;
}
function head(root:string){const value=git(root,['rev-parse','--verify','HEAD']).trim();if(!/^[a-f0-9]{40}$/.test(value))fail('RELEASE_SOURCE_GIT_UNAVAILABLE');return value;}
function paths(root:string){
  const output=git(root,['ls-files','-z','--cached','--others','--exclude-standard']);
  if(output&&!output.endsWith('\0'))fail('RELEASE_SOURCE_GIT_UNAVAILABLE');
  const values=output.split('\0').filter(Boolean).filter(selected);
  if(!values.length||values.length>maximumFiles||values.some(value=>!safePath(value)))fail('RELEASE_SOURCE_BINDINGS_INVALID');
  return [...new Set(values)].sort();
}

/** Snapshot only the fixed public release source classes, including newly added
 * untracked runtime sources. No private configuration or generated reports are read. */
export function captureReleaseSource(root=process.cwd()):ReleaseSourceSnapshot{
  try{
    const base=resolve(root);canonicalPath(base);
    if(git(base,['rev-parse','--show-toplevel']).trim()!==base)fail('RELEASE_SOURCE_PATH_INVALID');
    const sourceCommit=head(base),before=paths(base);let total=0;
    const bindings=before.map(path=>{const bytes=stableBytes(base,path);total+=bytes.length;if(total>maximumTotalBytes)fail('RELEASE_SOURCE_BINDINGS_INVALID');return {path,bytes:bytes.length,sha256:sha(bytes)};});
    if(JSON.stringify(before)!==JSON.stringify(paths(base)))fail('RELEASE_SOURCE_CHANGED_DURING_CAPTURE');
    // Recheck all earlier byte bindings after the final file was read.
    for(const entry of bindings){const bytes=stableBytes(base,entry.path);if(bytes.length!==entry.bytes||sha(bytes)!==entry.sha256)fail('RELEASE_SOURCE_CHANGED_DURING_CAPTURE');}
    if(sourceCommit!==head(base))fail('RELEASE_SOURCE_CHANGED_DURING_CAPTURE');
    return snapshot.parse({sourceCommit,bindings});
  }catch(error){throw Error(error instanceof Error&&errors.has(error.message)?error.message:'RELEASE_SOURCE_CAPTURE_INVALID');}
}

/** Exact declaration comparison only; this does not attest remote deployment,
 * compiler execution, provider actions or the provenance of an operator record. */
export function sameReleaseSource(before:unknown,after:unknown):boolean{
  try{
    const first=snapshot.parse(structuredClone(before)),second=snapshot.parse(structuredClone(after));
    return first.sourceCommit===second.sourceCommit&&first.bindings.length===second.bindings.length&&first.bindings.every((entry,index)=>{
      const other=second.bindings[index];return entry.path===other.path&&entry.bytes===other.bytes&&entry.sha256===other.sha256;
    });
  }catch{return false;}
}
