import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPrivateOriginJson} from '../scripts/private-origin-input.js';
function fixture(){const base=mkdtempSync(join(realpathSync(tmpdir()),'intentpass-private-origin-')),root=join(base,'repo');mkdirSync(root);return {base,root,file:join(base,'private.json'),close:()=>rmSync(base,{recursive:true,force:true})};}
test('actual private JSON read allows only canonical ordinary outside-repository bytes',()=>{
  const f=fixture();try{writeFileSync(f.file,'{"localFixture":true}');assert.equal(readPrivateOriginJson(f.file,f.root).toString(),' {"localFixture":true}'.trim());}finally{f.close();}
});
test('actual private reader rejects inside repo including a filename or directory beginning two dots',()=>{
  const f=fixture();try{for(const name of ['public.json','..public.json']){const path=join(f.root,name);writeFileSync(path,'{}');assert.throws(()=>readPrivateOriginJson(path,f.root),/DAY4_ORIGINS_PRIVATE_INPUT_NOT_ISOLATED/);}
    const folder=join(f.root,'..public');mkdirSync(folder);const path=join(folder,'input.json');writeFileSync(path,'{}');assert.throws(()=>readPrivateOriginJson(path,f.root),/DAY4_ORIGINS_PRIVATE_INPUT_NOT_ISOLATED/);
  }finally{f.close();}
});
test('actual private reader rejects symlink file and symlink parent into public or private folders',()=>{
  const f=fixture();try{writeFileSync(f.file,'{}');const link=join(f.base,'file-link.json');symlinkSync(f.file,link);assert.throws(()=>readPrivateOriginJson(link,f.root),/DAY4_ORIGINS_PRIVATE_INPUT_INVALID/);
    const publicFile=join(f.root,'public.json');writeFileSync(publicFile,'{}');const parent=join(f.base,'parent-link');symlinkSync(f.root,parent);assert.throws(()=>readPrivateOriginJson(join(parent,'public.json'),f.root),/DAY4_ORIGINS_PRIVATE_INPUT_INVALID/);
    const privateFolder=join(f.base,'private-folder');mkdirSync(privateFolder);writeFileSync(join(privateFolder,'input.json'),'{}');const other=join(f.base,'private-link');symlinkSync(privateFolder,other);assert.throws(()=>readPrivateOriginJson(join(other,'input.json'),f.root),/DAY4_ORIGINS_PRIVATE_INPUT_INVALID/);
  }finally{f.close();}
});
test('actual private reader rejects oversized duplicate-key and noncanonical inputs without echoing path or content',()=>{
  const f=fixture();try{for(const content of ['{"local":1,"local":2}',' '.repeat(65537)]){writeFileSync(f.file,content);assert.throws(()=>readPrivateOriginJson(f.file,f.root),error=>error instanceof Error&&error.message==='DAY4_ORIGINS_PRIVATE_INPUT_INVALID');}
    assert.throws(()=>readPrivateOriginJson('relative.json',f.root),/DAY4_ORIGINS_PRIVATE_INPUT_INVALID/);
    const other=join(f.base,'private.txt');writeFileSync(other,'{}');assert.throws(()=>readPrivateOriginJson(other,f.root),/DAY4_ORIGINS_PRIVATE_INPUT_INVALID/);
  }finally{f.close();}
});
