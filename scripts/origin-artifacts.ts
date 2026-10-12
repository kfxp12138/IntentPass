import {readFileSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {nativeFoundryBinary} from './foundry-runtime.js';
import {commandExit} from './verification-outcome.js';
import {keccak256,toHex} from 'viem';
import {strictJsonParse} from './strict-json.js';
import {deploymentArtifactTargets,deploymentArtifactRoles,type DeploymentAssetMode} from './origin-artifact-bindings.js';

/** Actual local compiler output only; no artifact is supplied by a private record. */
export function compileDay4OriginArtifacts(options:{assetMode?:DeploymentAssetMode}={}){
  const assetMode=options.assetMode===undefined?'cleanverse':options.assetMode,targets=deploymentArtifactTargets(assetMode),roles=deploymentArtifactRoles(assetMode);
  const build=spawnSync(nativeFoundryBinary('forge'),['build','--force'],{cwd:resolve('contracts'),encoding:'utf8',timeout:180000,maxBuffer:16000000});
  if(commandExit(build)!==0)throw Error('DAY4_ORIGINS_BUILD_UNAVAILABLE');
  const bindings=[] as {path:string;bytes:number;sha256:string;sources:{path:string;bytes:number;sha256:string;keccak256:string}[];
    compiler:{version:string};settings:{evmVersion:string;viaIR:boolean;optimizer:{enabled:boolean;runs:number};compilationTarget:Record<string,string>}}[];
  const artifacts={} as {gate:unknown;escrow:unknown;asset?:unknown};
  for(const key of roles){
    const {path,name,file}=targets[key]!,bytes=readFileSync(path);let artifact;
    try{artifact=strictJsonParse(bytes.toString('utf8')) as Record<string,any>;}catch{throw Error('DAY4_ORIGINS_ARTIFACT_INVALID');}
    const metadata=artifact?.metadata,settings=metadata?.settings;
    if(metadata?.compiler?.version!=='0.8.28+commit.7893614a'||settings?.evmVersion!=='cancun'||settings.viaIR!==true
      ||settings.optimizer?.enabled!==true||settings.optimizer.runs!==200
      ||JSON.stringify(settings.compilationTarget)!==JSON.stringify({[`src/${file}`]:name}))throw Error('DAY4_ORIGINS_COMPILER_CONFIGURATION_INVALID');
    if(!metadata.sources||typeof metadata.sources!=='object'||!Object.keys(metadata.sources).length||Object.keys(metadata.sources).length>256)throw Error('DAY4_ORIGINS_COMPILER_SOURCE_INVALID');
    const sources=Object.entries(metadata.sources).map(([name,value])=>{
      const dependency=name.startsWith('../node_modules/@openzeppelin/contracts/'),source=name.startsWith('src/');
      const remainder=name.slice(dependency?'../node_modules/@openzeppelin/contracts/'.length:'src/'.length);
      const base=resolve(dependency?'node_modules/@openzeppelin/contracts':'contracts/src'),absolute=resolve('contracts',name),local=relative(base,absolute);
      if(!dependency&&!source||local===''||local.startsWith('..'+sep)||local==='..'||!/^[-A-Za-z0-9_]+(?:\/[-A-Za-z0-9_]+)*\.sol$/.test(remainder))throw Error('DAY4_ORIGINS_COMPILER_SOURCE_INVALID');
      const original=readFileSync(absolute),hash=keccak256(toHex(original));
      if(!value||typeof value!=='object'||!('keccak256' in value)||value.keccak256!==hash)throw Error('DAY4_ORIGINS_COMPILER_SOURCE_MISMATCH');
      return {path:relative(resolve('.'),absolute),bytes:original.length,sha256:createHash('sha256').update(original).digest('hex'),keccak256:hash};
    });
    artifacts[key]=artifact;
    bindings.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sources,compiler:{version:metadata.compiler.version},
      settings:{evmVersion:settings.evmVersion,viaIR:settings.viaIR,optimizer:{enabled:true,runs:settings.optimizer.runs},compilationTarget:settings.compilationTarget}});
  }
  return {artifacts,bindings,buildExitCode:0 as const};
}
