import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {keccak256,type Hex} from 'viem';
import {compileDay4OriginArtifacts} from './origin-artifacts.js';
import {deploymentArtifactTargets,deploymentArtifactRoles,verifyDay4OriginArtifactBindings,type DeploymentAssetMode} from './origin-artifact-bindings.js';
import {strictJsonParse} from './strict-json.js';

type Compilation=ReturnType<typeof compileDay4OriginArtifacts>;
type Artifact={bytecode:{object:Hex};metadata:{compiler:{version:string};settings:Record<string,unknown>;sources:Record<string,{keccak256:string}>}};
function frozen<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}

/** Every production invocation forces the existing local compiler. Tests may
 * provide explicit in-memory compiler/reader doubles; no cache fallback exists. */
export function compileDeploymentArtifacts(options:{assetMode?:DeploymentAssetMode;compile?:()=>Compilation;readBytes?:(path:string)=>Buffer}={}){
  // Capture both operations before the first call, then snapshot compiler output.
  const assetMode=options.assetMode===undefined?'cleanverse':options.assetMode,targets=deploymentArtifactTargets(assetMode),roles=deploymentArtifactRoles(assetMode);
  const compile=options.compile??(()=>compileDay4OriginArtifacts({assetMode})),readBytes=options.readBytes??readFileSync;
  let compiled:Compilation;
  try{compiled=frozen(structuredClone(compile()));if(compiled.buildExitCode!==0)throw Error();}
  catch{throw Error('DEPLOYMENT_BUILD_UNAVAILABLE');}
  try{
    if(!verifyDay4OriginArtifactBindings(compiled.bindings,readBytes,undefined,{assetMode}))throw Error();
    const artifacts={} as Record<'gate'|'escrow',Artifact>&{asset?:Artifact};
    for(const role of roles){
      // Derive the object used by deployment from its independently checked bytes.
      // A compiler result object cannot substitute different in-memory bytecode.
      const path=targets[role]!.path,bytes=readBytes(path);
      if(!Buffer.isBuffer(bytes))throw Error();
      const originalBytes=Buffer.from(bytes),binding=compiled.bindings.find(value=>value.path===path);
      if(!binding||originalBytes.length!==binding.bytes||createHash('sha256').update(originalBytes).digest('hex')!==binding.sha256)throw Error();
      const original=strictJsonParse(originalBytes.toString('utf8'));
      if(!isDeepStrictEqual(original,compiled.artifacts[role]))throw Error();
      artifacts[role]=frozen(original as Artifact);
    }
    const hashes=frozen({...(assetMode==='demo-erc20'?{asset:keccak256(artifacts.asset!.bytecode.object)}:{}),gate:keccak256(artifacts.gate.bytecode.object),escrow:keccak256(artifacts.escrow.bytecode.object)});
    const isCurrent=()=>verifyDay4OriginArtifactBindings(compiled.bindings,readBytes,hashes,{assetMode});
    const assertCurrent=()=>{if(!isCurrent())throw Error('DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH');};
    assertCurrent();
    const log=JSON.stringify({scope:'FORCED_LOCAL_DEPLOYMENT_COMPILATION_AND_COMPLETE_SOURCE_BYTE_BINDINGS',buildExitCode:0,forcedRebuild:true,
      assetMode,rawCompilerOutputCaptured:false,artifactBindings:compiled.bindings,creationBytecodeHashes:hashes})+'\n';
    return frozen({assetMode,artifacts:frozen(artifacts),bindings:compiled.bindings,creationBytecodeHashes:hashes,buildExitCode:0 as const,log,isCurrent,assertCurrent});
  }catch{throw Error('DEPLOYMENT_ARTIFACT_SOURCE_MISMATCH');}
}
