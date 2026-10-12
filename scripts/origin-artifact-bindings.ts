import {constants,fstatSync,lstatSync,openSync,readFileSync,readSync,closeSync,realpathSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {keccak256,toHex,type Hex} from 'viem';
import {z} from 'zod';
import {strictJsonParse} from './strict-json.js';

const maximum=16_000_000,sha=z.string().regex(/^[a-f0-9]{64}$/),digest=z.string().regex(/^0x[a-fA-F0-9]{64}$/);
export type DeploymentAssetMode='cleanverse'|'demo-erc20';
export type DeploymentArtifactRole='asset'|'gate'|'escrow';
type ArtifactTarget=Readonly<{path:string;file:string;name:string}>;
type ArtifactTargets=Readonly<{gate:ArtifactTarget;escrow:ArtifactTarget;asset?:ArtifactTarget}>;
const escrowTarget=Object.freeze({path:'contracts/out/ContextVoteEscrow.sol/ContextVoteEscrow.json',file:'ContextVoteEscrow.sol',name:'ContextVoteEscrow'} as const);
const cleanverseTargets=Object.freeze({gate:Object.freeze({path:'contracts/out/CleanverseEligibility.sol/CleanverseEligibility.json',file:'CleanverseEligibility.sol',name:'CleanverseEligibility'} as const),escrow:escrowTarget});
const demoTargets=Object.freeze({asset:Object.freeze({path:'contracts/out/IntentPassDemoToken.sol/IntentPassDemoToken.json',file:'IntentPassDemoToken.sol',name:'IntentPassDemoToken'} as const),
  gate:Object.freeze({path:'contracts/out/FixedAssetEligibility.sol/FixedAssetEligibility.json',file:'FixedAssetEligibility.sol',name:'FixedAssetEligibility'} as const),escrow:escrowTarget});
/** The selected route fixes every role and compiler target before any file read. */
export function deploymentArtifactTargets(assetMode:DeploymentAssetMode='cleanverse'):ArtifactTargets{
  if(assetMode==='cleanverse')return cleanverseTargets;
  if(assetMode==='demo-erc20')return demoTargets;
  throw Error('DEPLOYMENT_ASSET_MODE_INVALID');
}
export function deploymentArtifactRoles(assetMode:DeploymentAssetMode='cleanverse'):readonly DeploymentArtifactRole[]{
  deploymentArtifactTargets(assetMode);
  return assetMode==='demo-erc20'?Object.freeze(['asset','gate','escrow'] as const):Object.freeze(['gate','escrow'] as const);
}
const publicSource=(path:string)=>{
  const prefix=path.startsWith('contracts/src/')?'contracts/src/':path.startsWith('node_modules/@openzeppelin/contracts/')?'node_modules/@openzeppelin/contracts/':null;
  if(!prefix||path.length>1024)return false;
  const remainder=path.slice(prefix.length),parts=remainder.split('/');
  return remainder.endsWith('.sol')&&parts.every(part=>/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part)&&part!=='.'&&part!=='..');
};
const sourceSchema=z.object({path:z.string().refine(publicSource),bytes:z.number().int().positive().safe().max(maximum),sha256:sha,keccak256:digest}).strict();
const compilerSchema=z.object({version:z.literal('0.8.28+commit.7893614a')}).strict();
const settingsSchema=z.object({evmVersion:z.literal('cancun'),viaIR:z.literal(true),optimizer:z.object({enabled:z.literal(true),runs:z.literal(200)}).strict(),
  compilationTarget:z.record(z.string(),z.string())}).strict();
const metadataSchema=z.object({compiler:compilerSchema.passthrough(),settings:settingsSchema.extend({optimizer:settingsSchema.shape.optimizer.passthrough()}).passthrough(),
  sources:z.record(z.string(),z.object({keccak256:digest}).passthrough()).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=256)}).passthrough();
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const expectedTarget=(settings:z.infer<typeof settingsSchema>,file:string,name:string)=>
  Object.keys(settings.compilationTarget).length===1&&settings.compilationTarget[`src/${file}`]===name;
function sourcePath(name:string){
  const path=name.startsWith('src/')?`contracts/${name}`:name.startsWith('../node_modules/@openzeppelin/contracts/')?name.slice(3):'';
  if(!publicSource(path))throw Error('LOCAL_SOURCE_INVALID');return path;
}

/** Actual filesystem reads stay inside the fixed source classes. A package-root
 * pnpm link is allowed; nested source aliases and links outside it are rejected. */
function stableBytes(path:string){
  const absolute=resolve(path),root=realpathSync('.'),dependency=path.startsWith('node_modules/@openzeppelin/contracts/');
  if(dependency){
    const packageRoot=realpathSync('node_modules/@openzeppelin/contracts'),remainder=path.slice('node_modules/@openzeppelin/contracts/'.length),canonical=realpathSync(absolute);
    const packageRelative=relative(root,packageRoot);
    if(packageRelative==='..'||packageRelative.startsWith('..'+sep)||relative(packageRoot,canonical)!==remainder)throw Error('LOCAL_SOURCE_INVALID');
  }else if(realpathSync(absolute)!==absolute||!absolute.startsWith(root+sep))throw Error('LOCAL_SOURCE_INVALID');
  const before=lstatSync(absolute);
  if(!before.isFile()||before.isSymbolicLink()||before.size<=0||before.size>maximum)throw Error('LOCAL_FILE_INVALID');
  const same=(stat:NonNullable<ReturnType<typeof lstatSync>>)=>stat.ino===before.ino&&stat.dev===before.dev&&stat.size===before.size&&stat.mtimeMs===before.mtimeMs;
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(before.size);
  try{
    if(!same(fstatSync(fd)))throw Error('LOCAL_FILE_CHANGED');
    let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(count===0)break;offset+=count;}
    if(offset!==bytes.length||!same(fstatSync(fd))||!same(lstatSync(absolute)))throw Error('LOCAL_FILE_CHANGED');
  }finally{closeSync(fd);}
  return bytes;
}

/** Verify complete route-specific public compiler byte bindings. This neither compiles nor
 * reads a private record, contacts a provider, or authenticates chain finality. */
export function verifyDay4OriginArtifactBindings(input:unknown,readBytes:(path:string)=>Buffer=readFileSync,
  creationBytecodeHashes?:{gate:string;escrow:string;asset?:string},options:{assetMode?:DeploymentAssetMode}={}):boolean{
  try{
    const assetMode=options.assetMode===undefined?'cleanverse':options.assetMode,targets=deploymentArtifactTargets(assetMode),roles=deploymentArtifactRoles(assetMode);
    const targetPaths=roles.map(role=>targets[role]!.path);
    const bindingSchema=z.object({path:z.enum(targetPaths as [string,...string[]]),bytes:z.number().int().positive().safe().max(maximum),sha256:sha,
      compiler:compilerSchema,settings:settingsSchema,sources:z.array(sourceSchema).min(1).max(256)}).strict();
    const manifestSchema=z.array(bindingSchema).length(roles.length);
    const hashesSchema=assetMode==='demo-erc20'?z.object({asset:digest,gate:digest,escrow:digest}).strict():z.object({gate:digest,escrow:digest}).strict();
    const bindings=freeze(manifestSchema.parse(structuredClone(input))),expectedHashes=creationBytecodeHashes===undefined?undefined:freeze(hashesSchema.parse(structuredClone(creationBytecodeHashes)));
    if(new Set(bindings.map(value=>value.path)).size!==roles.length)return false;
    // Validate the whole manifest before even a fixed artifact is read.
    for(const binding of bindings){
      const target=targets[roles.find(role=>targets[role]!.path===binding.path)!]!;
      if(!expectedTarget(binding.settings,target.file,target.name)||new Set(binding.sources.map(value=>value.path)).size!==binding.sources.length
        ||!binding.sources.some(value=>value.path===`contracts/src/${target.file}`))return false;
    }
    const originalBytes=new Map<string,Buffer>();
    const currentBytes=(path:string)=>{
      const value=readBytes===readFileSync?stableBytes(path):readBytes(path);
      if(!Buffer.isBuffer(value)||value.length<=0||value.length>maximum)throw Error('LOCAL_FILE_INVALID');return Buffer.from(value);
    };
    const read=(path:string)=>{const bytes=currentBytes(path),previous=originalBytes.get(path);if(previous&&!previous.equals(bytes))throw Error('LOCAL_FILE_CHANGED');originalBytes.set(path,bytes);return bytes;};
    for(const binding of bindings){
      const role=roles.find(role=>targets[role]!.path===binding.path)!,target=targets[role]!,original=read(binding.path);
      if(original.length!==binding.bytes||hash(original)!==binding.sha256)return false;
      const artifact=strictJsonParse(original.toString('utf8'));
      if(!artifact||typeof artifact!=='object'||Array.isArray(artifact)||!('metadata'in artifact))return false;
      const metadata=metadataSchema.parse(artifact.metadata);
      if(!expectedTarget(metadata.settings,target.file,target.name))return false;
      if(!('bytecode'in artifact)||!artifact.bytecode||typeof artifact.bytecode!=='object'||!('object'in artifact.bytecode)
        ||typeof artifact.bytecode.object!=='string'||!/^0x(?:[a-fA-F0-9]{2})+$/.test(artifact.bytecode.object))return false;
      const expectedHash=expectedHashes&&role==='asset'?('asset' in expectedHashes?expectedHashes.asset:undefined):expectedHashes?.[role as 'gate'|'escrow'];
      if(expectedHashes&&(typeof expectedHash!=='string'||keccak256(artifact.bytecode.object as Hex).toLowerCase()!==expectedHash.toLowerCase()))return false;
      const actualSources=new Map(Object.entries(metadata.sources).map(([name,value])=>[sourcePath(name),value.keccak256.toLowerCase()]));
      if(actualSources.size!==Object.keys(metadata.sources).length||actualSources.size!==binding.sources.length
        ||binding.sources.some(source=>actualSources.get(source.path)!==source.keccak256.toLowerCase()))return false;
      for(const source of binding.sources){
        const bytes=read(source.path),actualKeccak=keccak256(toHex(bytes));
        if(bytes.length!==source.bytes||hash(bytes)!==source.sha256||actualKeccak.toLowerCase()!==source.keccak256.toLowerCase())return false;
      }
    }
    // Reject changes to an earlier file while the remaining files were read.
    for(const [path,original] of originalBytes)if(!currentBytes(path).equals(original))return false;
    return true;
  }catch{return false;}
}
