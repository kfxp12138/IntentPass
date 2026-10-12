import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {keccak256,toHex,type Hex} from 'viem';
import {verifyDay4OriginArtifactBindings} from '../scripts/origin-artifact-bindings.js';

type Source={path:string;bytes:number;sha256:string;keccak256:string};
type Settings={evmVersion:string;viaIR:boolean;optimizer:{enabled:boolean;runs:number};compilationTarget:Record<string,string>};
type Binding={path:string;bytes:number;sha256:string;compiler:{version:string};settings:Settings;sources:Source[]};
type Artifact={bytecode:{object:Hex};metadata:{compiler:{version:string};settings:Settings;sources:Record<string,{keccak256:string}>}};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;

/** These are synthetic compiler-shaped JSON and source bytes in a limited local
 * reader double. No real compiler, filesystem, RPC, Privy or wallet is invoked. */
function fixture(){
  const files=new Map<string,Buffer>(),calls:string[]=[],bindings:Binding[]=[];
  const sourceBytes={gate:Buffer.from('// synthetic local source G'),escrow:Buffer.from('// synthetic local source E'),
    shared:Buffer.from('// synthetic local interface'),dependency:Buffer.from('// synthetic local IERC20')};
  const sources={gate:'contracts/src/CleanverseEligibility.sol',escrow:'contracts/src/ContextVoteEscrow.sol',
    shared:'contracts/src/IAssetEligibility.sol',dependency:'node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol'};
  for(const key of Object.keys(sources) as (keyof typeof sources)[])files.set(sources[key],sourceBytes[key]);
  const artifacts:Record<'gate'|'escrow',Artifact>={} as Record<'gate'|'escrow',Artifact>;
  const paths={gate:'contracts/out/CleanverseEligibility.sol/CleanverseEligibility.json',escrow:'contracts/out/ContextVoteEscrow.sol/ContextVoteEscrow.json'};
  for(const role of ['gate','escrow'] as const){
    const name=role==='gate'?'CleanverseEligibility':'ContextVoteEscrow',file=`${name}.sol`,list=role==='gate'?[sources.gate,sources.shared]:[sources.escrow,sources.shared,sources.dependency];
    const settings={evmVersion:'cancun',viaIR:true,optimizer:{enabled:true,runs:200},compilationTarget:{[`src/${file}`]:name}};
    artifacts[role]={bytecode:{object:role==='gate'?'0x6001':'0x6002'},metadata:{compiler:{version:'0.8.28+commit.7893614a'},settings,
      sources:Object.fromEntries(list.map(path=>[path.startsWith('contracts/')?path.slice('contracts/'.length):`../${path}`,{keccak256:keccak256(toHex(files.get(path)!))}]))}};
    const bytes=Buffer.from(JSON.stringify(artifacts[role]));files.set(paths[role],bytes);
    bindings.push({path:paths[role],bytes:bytes.length,sha256:sha(bytes),compiler:structuredClone(artifacts[role].metadata.compiler),settings:structuredClone(settings),
      sources:list.map(path=>({path,bytes:files.get(path)!.length,sha256:sha(files.get(path)!),keccak256:keccak256(toHex(files.get(path)!))}))});
  }
  const reader=(path:string)=>{calls.push(path);const bytes=files.get(path);if(!bytes)throw Error('synthetic reader forbids unknown path');return bytes;};
  const updateArtifact=(role:'gate'|'escrow',mutate:(artifact:Artifact)=>void)=>{
    mutate(artifacts[role]);const bytes=Buffer.from(JSON.stringify(artifacts[role]));files.set(paths[role],bytes);
    const binding=bindings.find(value=>value.path===paths[role])!;binding.bytes=bytes.length;binding.sha256=sha(bytes);
  };
  const hashes={gate:keccak256(artifacts.gate.bytecode.object),escrow:keccak256(artifacts.escrow.bytecode.object)};
  return {files,calls,bindings,sources,artifacts,paths,reader,hashes,updateArtifact,verify:()=>verifyDay4OriginArtifactBindings(bindings,reader,hashes)};
}

test('synthetic complete compiler/source bytes and original creation bytecode hashes bind both fixed artifacts',()=>{
  const f=fixture();assert.equal(f.verify(),true);assert.equal(verifyDay4OriginArtifactBindings([...f.bindings].reverse(),f.reader,f.hashes),true);
  assert.ok(f.calls.every(path=>f.files.has(path)));assert.ok(f.calls.includes(f.sources.dependency));
});
test('synthetic bindings can be inspected without a provided chain creation hash while bytecode remains validated',()=>{
  const f=fixture();assert.equal(verifyDay4OriginArtifactBindings(f.bindings,f.reader),true);
  f.updateArtifact('gate',artifact=>{artifact.bytecode.object='0x' as Hex;});assert.equal(verifyDay4OriginArtifactBindings(f.bindings,f.reader),false);
});
test('synthetic another creation bytecode hash or swapped role hashes cannot splice a different proof',()=>{
  const f=fixture();for(const hashes of [{...f.hashes,gate:h(99)},{...f.hashes,escrow:h(99)},
    {gate:f.hashes.escrow,escrow:f.hashes.gate},{...f.hashes,unexpected:'synthetic-private-extra'},
    {gate:'bad-hash',escrow:f.hashes.escrow}])assert.equal(verifyDay4OriginArtifactBindings(f.bindings,f.reader,hashes),false);
});
test('synthetic missing extra duplicate or nonfixed artifact records fail before reads',()=>{
  for(const mutation of [
    (f:ReturnType<typeof fixture>)=>f.bindings.pop(),
    (f:ReturnType<typeof fixture>)=>f.bindings.push(structuredClone(f.bindings[0])),
    (f:ReturnType<typeof fixture>)=>{f.bindings[1]=structuredClone(f.bindings[0]);},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].path='contracts/out/Unrelated.sol/Unrelated.json';},
  ]){const f=fixture();mutation(f);assert.equal(f.verify(),false);assert.equal(f.calls.length,0);}
});
test('synthetic empty duplicate or incomplete main source lists fail before reading files',()=>{
  for(const mutation of [
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources=[];},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources.push(structuredClone(f.bindings[0].sources[0]));},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources=f.bindings[0].sources.filter(source=>source.path!==f.sources.gate);},
  ]){const f=fixture();mutation(f);assert.equal(f.verify(),false);assert.equal(f.calls.length,0);}
});
test('synthetic absolute traversal aliases URL secret and unrelated dependency source paths never reach the reader',()=>{
  for(const path of ['/private/synthetic-key.sol','contracts/src/../private.sol','contracts/src/sub/../../private.sol','contracts/src//file.sol',
    'contracts/src/.env.sol','contracts/src/file.pem','contracts/src/file.sol?token=synthetic','https://synthetic.invalid/file.sol',
    'node_modules/@openzeppelin/contracts/../private.sol','node_modules/@unrelated/package/file.sol']){
    const f=fixture();f.bindings[0].sources[0].path=path;assert.equal(f.verify(),false);assert.equal(f.calls.length,0);
  }
});
test('synthetic malformed numeric digest private extras and unknown root objects fail closed before reads',()=>{
  for(const mutation of [
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].bytes=0;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].bytes=Number.MAX_SAFE_INTEGER+1;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources[0].bytes=-1;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources[0].sha256='invalid';},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].sources[0].keccak256='invalid';},
    (f:ReturnType<typeof fixture>)=>{Object.assign(f.bindings[0],{private_metadata:'synthetic-private-extra'});},
  ]){const f=fixture();mutation(f);assert.equal(f.verify(),false);assert.equal(f.calls.length,0);}
  const f=fixture();for(const input of [null,{},'verified',[],{bindings:f.bindings}])assert.equal(verifyDay4OriginArtifactBindings(input,f.reader),false);
  assert.equal(f.calls.length,0);
});
test('synthetic declaration cannot change compiler EVM optimizer viaIR or exact compilation target',()=>{
  for(const mutation of [
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].compiler.version='0.8.29';},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.evmVersion='paris';},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.viaIR=false;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.optimizer.enabled=false;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.optimizer.runs=201;},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.compilationTarget={'src/Unrelated.sol':'Unrelated'};},
    (f:ReturnType<typeof fixture>)=>{f.bindings[0].settings.compilationTarget['src/Extra.sol']='Extra';},
  ]){const f=fixture();mutation(f);assert.equal(f.verify(),false);assert.equal(f.calls.length,0);}
});
test('synthetic actual artifact settings cannot lie even with correctly updated raw byte hashes',()=>{
  for(const mutation of [
    (a:Artifact)=>{a.metadata.compiler.version='0.8.29';},
    (a:Artifact)=>{a.metadata.settings.evmVersion='paris';},
    (a:Artifact)=>{a.metadata.settings.viaIR=false;},
    (a:Artifact)=>{a.metadata.settings.optimizer.runs=201;},
    (a:Artifact)=>{a.metadata.settings.compilationTarget={'src/Other.sol':'Other'};},
  ]){const f=fixture();f.updateArtifact('gate',mutation);assert.equal(f.verify(),false);}
});
test('synthetic artifact and source bytes SHA length or keccak drift invalidate original bindings',()=>{
  for(const path of ['artifact','source'] as const)for(const field of ['bytes','sha256','keccak256'] as const){
    if(path==='artifact'&&field==='keccak256')continue;
    const f=fixture(),target=path==='artifact'?f.bindings[0]:f.bindings[0].sources[0];
    if(field==='bytes')target.bytes++;else if(field==='sha256')target.sha256='f'.repeat(64);else if('keccak256'in target)target.keccak256=h(99);
    assert.equal(f.verify(),false);
  }
  const f=fixture();f.files.set(f.sources.dependency,Buffer.from('// changed synthetic dependency'));assert.equal(f.verify(),false);
});
test('synthetic full artifact source table cannot omit the imported dependency or add an uncompiled source',()=>{
  const f=fixture();f.bindings[1].sources=f.bindings[1].sources.filter(source=>source.path!==f.sources.dependency);assert.equal(f.verify(),false);
  const g=fixture();g.bindings[0].sources.push(structuredClone(g.bindings[1].sources.find(source=>source.path===g.sources.dependency)!));assert.equal(g.verify(),false);
});
test('synthetic unsafe original metadata source path is rejected without reading it',()=>{
  for(const path of ['/private/synthetic-secret.sol','src/../private.sol','../node_modules/@unrelated/package/file.sol']){
    const f=fixture();f.updateArtifact('gate',artifact=>{artifact.metadata.sources[path]={keccak256:h(99)};});assert.equal(f.verify(),false);
    assert.ok(f.calls.every(path=>path===f.paths.gate));
  }
});
test('synthetic original metadata keccak must agree with supplied binding and actual bytes',()=>{
  const f=fixture();f.updateArtifact('gate',artifact=>{artifact.metadata.sources['src/CleanverseEligibility.sol'].keccak256=h(99);});assert.equal(f.verify(),false);
});
test('synthetic duplicate decoded artifact fields are refused even when their full raw SHA is correctly recorded',()=>{
  const f=fixture(),raw=f.files.get(f.paths.gate)!.toString('utf8'),bytes=Buffer.from(raw.replace('"version":','"version":"wrong","version":'));
  f.files.set(f.paths.gate,bytes);f.bindings[0].bytes=bytes.length;f.bindings[0].sha256=sha(bytes);assert.equal(f.verify(),false);
});
test('synthetic reader failures malformed original JSON and nonbuffer results expose only false',()=>{
  const f=fixture();assert.doesNotThrow(()=>assert.equal(verifyDay4OriginArtifactBindings(f.bindings,()=>{throw Error('synthetic-private-reader-error');}),false));
  assert.equal(verifyDay4OriginArtifactBindings(f.bindings,()=>null as unknown as Buffer),false);
  const bytes=Buffer.from('not-json');f.files.set(f.paths.gate,bytes);f.bindings[0].bytes=bytes.length;f.bindings[0].sha256=sha(bytes);assert.equal(f.verify(),false);
});
test('synthetic manifest and expected creation hash mutations inside the reader cannot redirect frozen inputs',()=>{
  const f=fixture(),original=f.reader;let first=true;
  assert.equal(verifyDay4OriginArtifactBindings(f.bindings,path=>{if(first){first=false;f.bindings[1].path='/private/synthetic-secret.sol';f.hashes.escrow=h(99) as Hex;}return original(path);},f.hashes),true);
  assert.ok(f.calls.every(path=>f.files.has(path)));
});
test('synthetic late source mutation during another file read fails final complete byte recheck',()=>{
  const f=fixture(),original=f.reader;let mutated=false;
  assert.equal(verifyDay4OriginArtifactBindings(f.bindings,path=>{if(path===f.paths.escrow&&!mutated){mutated=true;f.files.set(f.sources.gate,Buffer.from('// changed after earlier synthetic read'));}return original(path);},f.hashes),false);
});
test('synthetic actual bytecode malformed or another value cannot inherit a matching source declaration',()=>{
  for(const bytecode of ['0x','0x0','0xzz','0x6009']){const f=fixture();f.updateArtifact('gate',artifact=>{artifact.bytecode.object=bytecode as Hex;});assert.equal(f.verify(),false);}
});
