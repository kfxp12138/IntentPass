import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
export const adaptorSource={
  commit:'8e1f96c20e16bf960be6caec7f3c94acb360cdf2',
  archiveSha256:'4a59dd9f1a05e16ce89d7925fee18dbe86112606c34acd4cfcce9b615f0d08a3',
  vectorsCommit:'9cd9148938c616690c79d99ec6f330e213c246c5',
  vectorsSha256:'978aefe2877283d3c4bb9df0af552a185b3f37c2d4f27831221f849414add36c',
} as const;
export const adaptorRuntimeDirectory=resolve('.tools/adaptor-runtime');
export function fileSha256(path:string){return createHash('sha256').update(readFileSync(path)).digest('hex');}
export function verifiedAdaptorBinary(){
  try{
    const manifest=JSON.parse(readFileSync(resolve(adaptorRuntimeDirectory,'build.json'),'utf8'));
    const binary=resolve(adaptorRuntimeDirectory,'intentpass-adaptor');
    if(manifest.commit!==adaptorSource.commit||manifest.archiveSha256!==adaptorSource.archiveSha256
      ||manifest.bridgeSha256!==fileSha256(resolve('scripts/native/adaptor.c'))||manifest.binarySha256!==fileSha256(binary))throw Error();
    return binary;
  }catch{throw Error('ADAPTOR_RUNTIME_MISSING_OR_CHANGED_RUN_TOOLS_ADAPTOR');}
}
