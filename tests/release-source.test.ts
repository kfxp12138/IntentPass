import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync,symlinkSync,renameSync,truncateSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {captureReleaseSource,sameReleaseSource,type ReleaseSourceSnapshot} from '../scripts/release-source.js';

/** Local temporary Git/source fixtures only. No actual project files, provider,
 * compiler, wallet, network or private environment are used by these tests. */
function fixture(t:test.TestContext){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'intentpass-release-source-synthetic-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args:string[])=>{const result=spawnSync('git',['-c','user.name=Synthetic Source Fixture','-c','user.email=synthetic@example.invalid',
    '-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,'Local synthetic Git fixture failed');return result.stdout.trim();};
  const save=(path:string,content='SYNTHETIC_PUBLIC_SOURCE\n')=>{const absolute=join(root,path);mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,content);return absolute;};
  git('init','-q','-b','main');save('README.md');save('apps/web/src/main.ts','export const synthetic = 1;\n');save('fixtures/dev/synthetic.json','{"synthetic":true}\n');
  git('add','--','README.md','apps','fixtures');git('commit','-qm','Synthetic initial source');
  return {root,git,save,capture:()=>captureReleaseSource(root)};
}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fixedCode=(error:unknown)=>error instanceof Error&&/^RELEASE_SOURCE_[A-Z_]+$/.test(error.message);

test('local source snapshots bind the exact current HEAD and sorted original public bytes',t=>{
  const f=fixture(t),snapshot=f.capture();assert.equal(snapshot.sourceCommit,f.git('rev-parse','HEAD'));
  assert.deepEqual(snapshot.bindings.map(entry=>entry.path),['README.md','apps/web/src/main.ts','fixtures/dev/synthetic.json']);
  for(const entry of snapshot.bindings){const bytes=readFileSync(join(f.root,entry.path));assert.equal(entry.bytes,bytes.length);assert.equal(entry.sha256,digest(bytes));}
  assert.equal(sameReleaseSource(snapshot,f.capture()),true);assert.equal(JSON.stringify(snapshot).includes(f.root),false);
});
test('local source byte drift changes comparison even with the same HEAD and restored bytes restore equality',t=>{
  const f=fixture(t),before=f.capture(),path=join(f.root,'apps/web/src/main.ts'),original=readFileSync(path);
  writeFileSync(path,'export const synthetic = 2;\n');const changed=f.capture();assert.equal(before.sourceCommit,changed.sourceCommit);assert.equal(sameReleaseSource(before,changed),false);
  writeFileSync(path,original);assert.equal(sameReleaseSource(before,f.capture()),true);
});
test('local HEAD changes reject equality even when all public source bytes remain identical',t=>{
  const f=fixture(t),before=f.capture();f.git('commit','--allow-empty','-qm','Synthetic HEAD change');const after=f.capture();
  assert.deepEqual(before.bindings,after.bindings);assert.notEqual(before.sourceCommit,after.sourceCommit);assert.equal(sameReleaseSource(before,after),false);
});
test('local newly staged public sources change the inventory without requiring a commit',t=>{
  const f=fixture(t),before=f.capture();f.save('packages/protocol/src/synthetic.ts');f.git('add','--','packages/protocol/src/synthetic.ts');const after=f.capture();
  assert.equal(before.sourceCommit,after.sourceCommit);assert.equal(sameReleaseSource(before,after),false);assert.ok(after.bindings.some(entry=>entry.path==='packages/protocol/src/synthetic.ts'));
});
test('local newly untracked runtime sources are included and cannot hide behind cached Git paths',t=>{
  const f=fixture(t),before=f.capture();f.save('tests/synthetic-new.test.ts');const after=f.capture();
  assert.equal(before.sourceCommit,after.sourceCommit);assert.ok(after.bindings.some(entry=>entry.path==='tests/synthetic-new.test.ts'));assert.equal(sameReleaseSource(before,after),false);
});
test('local fixed runtime extensions package metadata fixture JSON and required documents are selected',t=>{
  const f=fixture(t),expected=['scripts/synthetic.tsx','scripts/synthetic.js','scripts/synthetic.mjs','scripts/synthetic.cjs','scripts/synthetic.css',
    'scripts/synthetic.html','contracts/src/Synthetic.sol','packages/storage/src/synthetic.sql','apps/worker/package.json','contracts/foundry.toml',
    'pnpm-lock.yaml','package.json','tsconfig.json','.env.example','LICENSE','docs/architecture.md','docs/submission.md','docs/monad-deployment.md',
    'docs/decisions.md','docs/interfaces.md','docs/threat-model.md','docs/attribution.md','docs/judge-access.md'];
  for(const path of expected)f.save(path);const snapshot=f.capture();for(const path of expected)assert.ok(snapshot.bindings.some(entry=>entry.path===path),path);
});
test('local private configuration database dependency and generated files are filtered before byte reads',t=>{
  const f=fixture(t),before=f.capture(),excluded=['.env','.env.local','scripts/private.json','scripts/private.md','scripts/private.env','scripts/private.db',
    'scripts/private.pem','packages/module/.env','packages/module/private.json','packages/node_modules/vendor/index.ts','apps/web/dist/index.js',
    'artifacts/acceptance/day7.json','contracts/out/Synthetic.sol/Synthetic.json','docs/day7-report.md','docs/unlisted.md','node_modules/vendor/source.ts'];
  for(const path of excluded)f.save(path,'SYNTHETIC_PRIVATE_OR_GENERATED_BYTES_NEVER_SELECTED');f.git('add','-f','--',...excluded);
  // Even an excluded private JSON symlink must be filtered before a file read
  // or source-path validation; its target content is outside the source scope.
  const target=f.save('private-target.txt','SYNTHETIC_PRIVATE_BYTES_NEVER_SELECTED');
  unlinkSync(join(f.root,'scripts/private.json'));symlinkSync(target,join(f.root,'scripts/private.json'));
  const after=f.capture();assert.equal(sameReleaseSource(before,after),true);assert.ok(after.bindings.every(entry=>!excluded.includes(entry.path)));
});
test('release source binds the public chain pin and deployment templates and rejects their byte drift',t=>{
  const f=fixture(t),paths=['examples/chain-client/monad-testnet.json','deploy/caddy/Caddyfile','deploy/systemd/intentpass.service','deploy/README.md'];
  for(const path of paths)f.save(path,'SYNTHETIC_PUBLIC_DEPLOYMENT_CONFIGURATION');const original=f.capture();
  for(const path of paths){assert.ok(original.bindings.some(b=>b.path===path));f.save(path,'SYNTHETIC_CHANGED_CONFIGURATION');assert.equal(sameReleaseSource(original,f.capture()),false);f.save(path,'SYNTHETIC_PUBLIC_DEPLOYMENT_CONFIGURATION');assert.equal(sameReleaseSource(original,f.capture()),true);}
});
test('local ignored untracked runtime output stays excluded while tracked ignored sources remain bound',t=>{
  const f=fixture(t);f.save('.gitignore','scripts/ignored.ts\n');const before=f.capture();f.save('scripts/ignored.ts');assert.equal(sameReleaseSource(before,f.capture()),true);
  f.git('add','-f','--','scripts/ignored.ts');assert.equal(sameReleaseSource(before,f.capture()),false);
});
test('local deleted tracked sources fail closed with no filesystem path exposed',t=>{
  const f=fixture(t);unlinkSync(join(f.root,'apps/web/src/main.ts'));
  assert.throws(f.capture,error=>fixedCode(error)&&!(error as Error).message.includes(f.root));
});
test('local source file symlinks are rejected before any target bytes can be returned',t=>{
  const f=fixture(t),source=join(f.root,'apps/web/src/main.ts'),target=f.save('private-target.txt','SYNTHETIC_PRIVATE_LINK_TARGET');
  unlinkSync(source);symlinkSync(target,source);assert.throws(f.capture,{message:'RELEASE_SOURCE_PATH_INVALID'});
});
test('local source parent symlinks and a symlink root cannot alias a valid snapshot',t=>{
  const f=fixture(t),source=join(f.root,'apps/web/src'),moved=join(f.root,'apps/web/retired');renameSync(source,moved);symlinkSync(moved,source);
  assert.throws(f.capture,{message:'RELEASE_SOURCE_PATH_INVALID'});
  const g=fixture(t),alias=join(g.root,'root-alias');symlinkSync(g.root,alias);assert.throws(()=>captureReleaseSource(alias),{message:'RELEASE_SOURCE_PATH_INVALID'});
});
test('local oversized source files and nonrepository or nested roots expose only fixed errors',t=>{
  const f=fixture(t);truncateSync(join(f.root,'apps/web/src/main.ts'),32000001);assert.throws(f.capture,{message:'RELEASE_SOURCE_FILE_INVALID'});
  assert.throws(()=>captureReleaseSource(join(f.root,'apps')),{message:'RELEASE_SOURCE_PATH_INVALID'});
  const outside=realpathSync(mkdtempSync(join(tmpdir(),'intentpass-release-source-nogit-')));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  assert.throws(()=>captureReleaseSource(outside),{message:'RELEASE_SOURCE_GIT_UNAVAILABLE'});
});
test('local unusual runtime source paths fail safely rather than escaping the fixed source classes',t=>{
  const f=fixture(t);f.save('scripts/synthetic unsafe.ts');assert.throws(f.capture,{message:'RELEASE_SOURCE_BINDINGS_INVALID'});
});
test('source comparison validates both complete ordered snapshots and refuses malformed or private bindings',t=>{
  const f=fixture(t),before=f.capture(),invalid:unknown[]=[null,{},[],{...before,extra:'synthetic-private-extra'},
    {...before,sourceCommit:'invalid'},{...before,bindings:[]},{...before,bindings:[...before.bindings].reverse()},
    {...before,bindings:[before.bindings[0],before.bindings[0]]}];
  for(const change of [{path:'.env'},{path:'scripts/private.json'},{path:'apps/../private.ts'},{path:'/private/synthetic.ts'},
    {bytes:-1},{bytes:32000001},{sha256:'wrong'},{privateMetadata:'synthetic-private-extra'}]){
    const changed=structuredClone(before) as ReleaseSourceSnapshot;Object.assign(changed.bindings[0],change);invalid.push(changed);
  }
  for(const value of invalid){assert.equal(sameReleaseSource(before,value),false);assert.equal(sameReleaseSource(value,before),false);}
  const emptySource=structuredClone(before);emptySource.bindings[0].bytes=0;emptySource.bindings[0].sha256=digest(Buffer.alloc(0));
  assert.equal(sameReleaseSource(emptySource,structuredClone(emptySource)),true);
});
