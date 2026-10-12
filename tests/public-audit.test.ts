import test from 'node:test';
import assert from 'node:assert/strict';
import {auditBytes,auditPublicTree} from '../scripts/public-audit.js';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('public audit detects Ark key tokens without retaining matched credentials',()=>{
  const synthetic=['ark','-','a'.repeat(28),'-','b'.repeat(12)].join('');
  for(const bytes of [Buffer.from(synthetic),Buffer.concat([Buffer.from([0,1]),Buffer.from(synthetic)])]){
    const found=auditBytes('public.txt',bytes);assert.deepEqual(found,[{path:'public.txt',line:1,rule:'ARK_API_KEY_LITERAL'}]);assert.equal(JSON.stringify(found).includes(synthetic),false);
  }
  assert.deepEqual(auditBytes('template.txt',Buffer.from('PLANNER_API_KEY=')),[]);
});
test('public audit detects TypeSafe key tokens without retaining the matched value',()=>{
  const synthetic=['apikey','_','a'.repeat(36),'_','b'.repeat(64)].join('');
  for(const bytes of [Buffer.from(synthetic),Buffer.concat([Buffer.from([0,1]),Buffer.from(synthetic)])]) {
    const found=auditBytes('public.txt',bytes);assert.deepEqual(found,[{path:'public.txt',line:1,rule:'TYPESAFE_API_KEY_LITERAL'}]);assert.equal(JSON.stringify(found).includes(synthetic),false);
  }
  assert.deepEqual(auditBytes('template.txt',Buffer.from('TYPESAFE_API_KEY=')),[]);
});
test('public audit detects credential forms in source build logs and raw binary without returning matched secrets',()=>{const synthetic='x'.repeat(30),input='first line\n'+JSON.stringify({apiKey:synthetic})+'\nBearer '+['a'.repeat(20),'b'.repeat(20),'c'.repeat(20)].join('.')+'\n'+'sk-'+synthetic+'\n'+'-----BEGIN '+'PRIVATE KEY-----'+'\n'+['https://','user:secret','@example.com'].join('');const found=auditBytes('build/app.js',Buffer.from(input));assert.ok(found.some(f=>f.rule==='CREDENTIAL_LITERAL'&&f.line===2));assert.ok(found.some(f=>f.rule==='API_KEY_LITERAL'));assert.ok(found.some(f=>f.rule==='BEARER_JWT_LITERAL'));assert.ok(found.some(f=>f.rule==='PRIVATE_KEY_PEM'));assert.ok(found.some(f=>f.rule==='AUTHENTICATED_URL_LITERAL'));assert.equal(JSON.stringify(found).includes('user:secret'),false);assert.equal(JSON.stringify(found).includes(synthetic),false);assert.equal(auditBytes('media.png',Buffer.concat([Buffer.from([0,1,2]),Buffer.from(input)])).length,found.length);});
test('public audit excludes private runtime storage scans ignored public builds and marks media and symlinks unverified',()=>{const root=mkdtempSync(join(tmpdir(),'intentpass-audit-'));try{mkdirSync(join(root,'apps/web/dist'),{recursive:true});writeFileSync(join(root,'apps/web/dist/app.js'),'const safe = true;');writeFileSync(join(root,'.env'),'PRIVY_APP_SECRET="'+'x'.repeat(40)+'"');writeFileSync(join(root,'.env.example'),'PRIVY_APP_SECRET=');writeFileSync(join(root,'private.db'),'-----BEGIN '+'PRIVATE KEY-----');writeFileSync(join(root,'image.png'),Buffer.from([0,1,2]));symlinkSync(join(root,'.env'),join(root,'public-link.txt'));const report=auditPublicTree(root);assert.equal(report.findings.length,0);assert.equal(report.status,'BLOCKED');assert.ok(report.manifest.some(f=>f.path==='apps/web/dist/app.js'));assert.ok(report.manifest.some(f=>f.path==='.env.example'));assert.ok(!report.manifest.some(f=>f.path==='.env'||f.path==='private.db'));assert.ok(report.unverified.includes('image.png'));assert.ok(report.unverified.includes('public-link.txt'));}finally{rmSync(root,{recursive:true,force:true});}});
