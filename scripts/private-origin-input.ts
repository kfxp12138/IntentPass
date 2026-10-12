import {lstatSync,realpathSync} from 'node:fs';
import {resolve,isAbsolute,relative,sep,dirname} from 'node:path';
import {readStableReleaseJson} from './release-review.js';

/** Original plaintext evidence lives outside the public repository. Canonical
 * component checks precede and follow the stable bounded read; no path is logged. */
export function readPrivateOriginJson(path:string,root=process.cwd()){
  const check=()=>{
    if(!isAbsolute(path)||path!==resolve(path)||!path.endsWith('.json'))throw Error('DAY4_ORIGINS_PRIVATE_INPUT_INVALID');
    const base=realpathSync(root),canonical=realpathSync(path);
    for(let current=path;;current=dirname(current)){if(lstatSync(current).isSymbolicLink())throw Error('DAY4_ORIGINS_PRIVATE_INPUT_INVALID');if(dirname(current)===current)break;}
    if(canonical!==path)throw Error('DAY4_ORIGINS_PRIVATE_INPUT_INVALID');
    const local=relative(base,canonical);
    if(!isAbsolute(local)&&local!=='..'&&!local.startsWith('..'+sep))throw Error('DAY4_ORIGINS_PRIVATE_INPUT_NOT_ISOLATED');
  };
  try{check();const bytes=readStableReleaseJson(path);check();return bytes;}
  catch(error){if(error instanceof Error&&error.message==='DAY4_ORIGINS_PRIVATE_INPUT_NOT_ISOLATED')throw error;throw Error('DAY4_ORIGINS_PRIVATE_INPUT_INVALID');}
}
