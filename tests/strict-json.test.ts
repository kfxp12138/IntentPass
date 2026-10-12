import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strictJsonParse} from '../scripts/strict-json.js';
import {readStableReleaseJson} from '../scripts/release-review.js';

test('strict JSON preserves valid native values strings escapes arrays numbers and empty containers',()=>{
  const value={string:'quote " slash \\ newline\n unicode 字符',array:[true,false,null,0,-1,1.25,1e30,{},[]],nested:{a:[{same:1},{same:2}]}};
  const text=JSON.stringify(value);assert.deepEqual(strictJsonParse(' \r\n'+text+'\t'),value);
  for(const text of ['null','true','false','0','-0','12e-2','"\\u4e2d"','{}','[]'])assert.deepEqual(strictJsonParse(text),JSON.parse(text));
});
test('strict JSON rejects duplicate decoded member names including escaped keys and nested objects',()=>{
  for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"nested":[{"a":1,"a":2}]}','{"__proto__":1,"__proto__":2}'])assert.throws(()=>strictJsonParse(text),/JSON_DUPLICATE_KEY/);
});
test('strict JSON keeps independent object keys and duplicate-looking text valid without regex key heuristics',()=>{
  for(const text of ['[{"a":1},{"a":2}]','{"a":{"a":1},"b":{"a":2}}','{"text":"\\\"a\\\":1,\\\"a\\\":2","a":1}','{"quote\\\"key":1,"slash\\\\key":2}'])assert.deepEqual(strictJsonParse(text),JSON.parse(text));
});
test('strict JSON rejects malformed excessive-depth and duplicate private inputs with fixed errors before returning raw bytes',()=>{
  for(const text of ['','{','[1,]','{"a":1,}','{"a":NaN}','"unclosed','true false'])assert.throws(()=>strictJsonParse(text),/^Error: JSON_INVALID$/);
  assert.throws(()=>strictJsonParse('['.repeat(130)+'0'+']'.repeat(130)),/JSON_DEPTH_EXCEEDED/);
  const root=mkdtempSync(join(tmpdir(),'intentpass-json-format-')),path=join(root,'synthetic-private-record.json');
  try{writeFileSync(path,'{"a":1,"\\u0061":2}');assert.throws(()=>readStableReleaseJson(path),/JSON_DUPLICATE_KEY/);}finally{rmSync(root,{recursive:true,force:true});}
});
