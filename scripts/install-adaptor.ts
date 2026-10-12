import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {adaptorSource as pin,adaptorRuntimeDirectory as target,fileSha256} from './adaptor-runtime.js';
// Explicit project-local tool installation; never runs at application startup.
const cache=resolve('.tools/adaptor-source');mkdirSync(cache,{recursive:true});mkdirSync(target,{recursive:true});
async function download(name:string,url:string,hash:string){
  const path=join(cache,name);
  if(!existsSync(path)){
    const result=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!result.ok)throw Error('ADAPTOR_DOWNLOAD_FAILED');
    const body=Buffer.from(await result.arrayBuffer());if(body.length>10000000)throw Error('ADAPTOR_ARCHIVE_TOO_LARGE');writeFileSync(path,body,{flag:'wx'});
  }
  if(fileSha256(path)!==hash)throw Error('ADAPTOR_SOURCE_DIGEST_MISMATCH');return path;
}
try{
  if(!['linux','darwin'].includes(process.platform))throw Error('ADAPTOR_PLATFORM_UNSUPPORTED');
  const archive=await download('secp256k1-zkp.tar.gz',`https://codeload.github.com/BlockstreamResearch/secp256k1-zkp/tar.gz/${pin.commit}`,pin.archiveSha256);
  await download('ecdsa_adaptor.json',`https://raw.githubusercontent.com/discreetlogcontracts/dlcspecs/${pin.vectorsCommit}/test/ecdsa_adaptor.json`,pin.vectorsSha256);
  const source=join(cache,`secp256k1-zkp-${pin.commit}`),build=join(target,'build');
  execFileSync('tar',['-xzf',archive,'-C',cache],{timeout:30000});
  const flags=['-DBUILD_SHARED_LIBS=OFF','-DSECP256K1_ENABLE_MODULE_ECDSA_ADAPTOR=ON','-DSECP256K1_ENABLE_MODULE_RECOVERY=ON','-DSECP256K1_BUILD_TESTS=ON','-DSECP256K1_BUILD_EXHAUSTIVE_TESTS=OFF','-DSECP256K1_BUILD_CTIME_TESTS=OFF','-DSECP256K1_BUILD_BENCHMARK=OFF','-DSECP256K1_INSTALL=OFF'];
  execFileSync('cmake',['-S',source,'-B',build,...flags],{stdio:'inherit',timeout:60000});
  execFileSync('cmake',['--build',build,'--parallel','4'],{stdio:'inherit',timeout:180000});
  const binary=join(target,'intentpass-adaptor'),bridge=resolve('scripts/native/adaptor.c');
  execFileSync('cc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-I',join(source,'include'),bridge,join(build,'lib','libsecp256k1.a'),'-o',binary],{stdio:'inherit',timeout:60000});
  writeFileSync(join(target,'build.json'),JSON.stringify({...pin,bridgeSha256:fileSha256(bridge),binarySha256:fileSha256(binary)},null,2)+'\n');
  writeFileSync(join(target,'COPYING'),readFileSync(join(source,'COPYING')));
  console.log('Pinned adaptor runtime built locally. Run test:adaptor for verification.');
}catch(error){console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'ADAPTOR_BUILD_FAILED');process.exitCode=1;}
