import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../apps/web/src/server.js';
import {AuthenticationRejected} from '../packages/adapters/src/privy-auth.js';

type App=Awaited<ReturnType<typeof createApp>>;
async function listen(app:App){await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();assert.ok(address&&typeof address==='object');return address.port;}
/** Raw origin-form requests preserve encoded dot segments that fetch would normalize. */
function get(port:number,path:string,method='GET',headers:Record<string,string>={}){return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,path,method,headers},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));res.on('error',reject);});req.on('error',reject);req.end();
});}
const page='<!doctype html><html><body>BUILT_LOCAL_PAGE</body></html>',bundle='globalThis.productionFixture=true;',database='LOCAL_DATABASE_BYTES_MUST_NOT_BE_PUBLIC';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'intentpass-built-web-')),dist=join(root,'dist');await mkdir(join(dist,'assets'),{recursive:true});await writeFile(join(dist,'index.html'),page);await writeFile(join(dist,'assets','index-AbCd1234.js'),bundle);return {root,dist};}

test('production serves the built UI and immutable assets with HEAD while retaining authenticated APIs',async()=>{
  const {root,dist}=await fixture();let app:App|undefined;
  try{let lookups=0;app=await createApp({webMode:'production',distDirectory:dist,browserApi:{configuration:{privyAppId:'local-production-test',meraRpId:null,recoveryDeployment:null},auth:{authenticate:async token=>{lookups++;if(token!=='local-user')throw new AuthenticationRejected();return {subject:'verified-local-user',wallets:[]};}}}});const port=await listen(app);
    const home=await get(port,'/');assert.equal(home.status,200);assert.equal(home.body,page);assert.equal(home.headers['cache-control'],'no-store');assert.match(String(home.headers['content-type']),/^text\/html/);
    const asset=await get(port,'/assets/index-AbCd1234.js');assert.equal(asset.status,200);assert.equal(asset.body,bundle);assert.equal(asset.headers['cache-control'],'public, max-age=31536000, immutable');assert.match(String(asset.headers['content-type']),/^text\/javascript/);
    const head=await get(port,'/assets/index-AbCd1234.js','HEAD');assert.equal(head.status,200);assert.equal(head.body,'');assert.equal(head.headers['content-length'],String(Buffer.byteLength(bundle)));assert.equal(head.headers['cache-control'],asset.headers['cache-control']);
    const navigation=await get(port,'/task','GET',{accept:'text/html'});assert.equal(navigation.status,200);assert.equal(navigation.body,page);assert.equal((await get(port,'/task')).status,404);assert.equal((await get(port,'/assets/missing.js','GET',{accept:'text/html'})).status,404);
    assert.equal((await get(port,'/health')).status,200);assert.equal((await get(port,'/api/session')).status,401);assert.equal(lookups,0);const session=await get(port,'/api/session','GET',{authorization:'Bearer local-user'});assert.equal(session.status,200);assert.deepEqual(JSON.parse(session.body),{subject:'verified-local-user',wallets:[]});assert.equal(lookups,1);assert.equal((await get(port,'/api/unconfigured','GET',{accept:'text/html'})).status,503);assert.equal((await get(port,'/','POST')).status,405);
  }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
});

test('production rejects source, private files, encoded traversal and escaping symlinks without SPA fallback',async()=>{
  const {root,dist}=await fixture();let app:App|undefined;
  try{await writeFile(join(root,'capsules.db'),database);await writeFile(join(dist,'copied.db'),database);await symlink(join(root,'capsules.db'),join(dist,'assets','escape-AbCd1234.js'));app=await createApp({webMode:'production',distDirectory:dist});const port=await listen(app);
    for(const path of ['/copied.db','/copied.db-wal','/copied.db-shm','/.env','/assets/escape-AbCd1234.js','/assets/%2e%2e/%2e%2e/capsules.db','/assets/../copied.db','/%2e%2e/capsules.db']){const response=await get(port,path,'GET',{accept:'text/html'});assert.equal(response.status,403,path);assert.ok(!response.body.includes(database),path);assert.ok(!response.body.includes(page),path);}
    for(const path of ['/%252e%252e/capsules.db','/assets%5c..%5ccapsules.db','/assets/%00.js','/%zz'])assert.equal((await get(port,path)).status,400,path);
    for(const path of ['/@fs'+join(root,'capsules.db'),'/@vite/client','/@id/module','/src/main.ts','/packages/protocol/src/index.ts','/node_modules/vite/package.json','/package.json','/assets/index-AbCd1234.js.map']){const response=await get(port,path,'GET',{accept:'text/html'});assert.ok([403,404].includes(response.status),path);assert.ok(!response.body.includes(database)&&!response.body.includes(page),path);}
    assert.equal((await get(port,'/copied.db','HEAD')).status,403);await app.close();app=undefined;
    await assert.rejects(createApp({webMode:'production',distDirectory:join(root,'missing')}),/PRODUCTION_BUILD_REQUIRED/);const bad=join(root,'bad');await mkdir(bad);await symlink(join(root,'capsules.db'),join(bad,'index.html'));await assert.rejects(createApp({webMode:'production',distDirectory:bad}),/PRODUCTION_BUILD_REQUIRED/);
  }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
});

test('development blocks database files and aliased symlinks for ordinary and @fs requests while modules still load',async()=>{
  const webRoot=fileURLToPath(new URL('../apps/web/',import.meta.url)),directory=await mkdtemp(join(webRoot,'.http-storage-test-'));let app:App|undefined;
  try{for(const name of ['capsules.db','capsules.db-wal','capsules.db-shm'])await writeFile(join(directory,name),database);await symlink(join(directory,'capsules.db'),join(directory,'masked.js'));app=await createApp({dependencyPrebundling:false});const port=await listen(app),prefix='/'+directory.slice(webRoot.length);
    for(const name of ['capsules.db','capsules.db-wal','capsules.db-shm','masked.js'])for(const path of [`${prefix}/${name}`,`/@fs${join(directory,name)}`,`/@fs/${join(directory,name)}`]){const response=await get(port,path);assert.equal(response.status,403,path);assert.ok(!response.body.includes(database),path);assert.equal((await get(port,path,'HEAD')).status,403,path);}
    assert.equal((await get(port,`${prefix}/capsules%2edb?raw`)).status,403);assert.equal((await get(port,'/src/main.ts')).status,200);assert.equal((await get(port,'/health')).status,200);assert.equal((await get(port,'/api/intent/submit','POST')).status,503);
  }finally{if(app)await app.close();await rm(directory,{recursive:true,force:true});}
});
