import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createMetaMaskServer} from '../scripts/metamask-server.js';
import type {MetaMaskDeploymentService} from '../scripts/metamask-service.js';
async function start(t:test.TestContext,service?:MetaMaskDeploymentService){const app=createMetaMaskServer({service,blockers:['MISSING_DEPLOYER_ADDRESS'],staticFiles:new Map([['/',{body:Buffer.from('<html>operator</html>'),contentType:'text/html'}]])});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const a=app.server.address();assert.ok(a&&typeof a==='object');return {app,url:`http://127.0.0.1:${a.port}`,port:a.port};}
test('loopback page and missing configuration expose no deployment data or private files',async t=>{
  const {url}=await start(t);const page=await fetch(url);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);const status=await(await fetch(`${url}/api/status`)).json();assert.equal(status.ready,false);assert.equal(status.plan,null);assert.equal(status.transactionsSentByServer,0);
  for(const path of ['/.env','/operator.db','/scripts/serve-metamask-deployment.ts','/contracts/out/ContextVoteEscrow.sol/ContextVoteEscrow.json'])assert.equal((await fetch(`${url}${path}`)).status,404);
  assert.equal((await fetch(`${url}/api/preflight`,{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'})).status,503);
});
test('separate blocked gate handoff preserves strict origin and private-file boundaries',async t=>{
  const app=createMetaMaskServer({scope:'LOCAL_OPERATOR_CLEANVERSE_GATE_HANDOFF',blockers:['MISSING_CVI_VALIDATOR_ADDRESS'],staticFiles:new Map([['/',{body:Buffer.from('<html>gate</html>'),contentType:'text/html'}]])});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const address=app.server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`,status=await(await fetch(`${url}/api/status`)).json();assert.equal(status.scope,'LOCAL_OPERATOR_CLEANVERSE_GATE_HANDOFF');assert.equal(status.ready,false);assert.equal(status.plan,null);assert.deepEqual(status.blockers,['MISSING_CVI_VALIDATOR_ADDRESS']);assert.equal(status.transactionsSentByServer,0);
  assert.equal((await fetch(`${url}/api/preflight`,{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'})).status,503);assert.equal((await fetch(`${url}/api/reserve`,{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'})).status,403);for(const path of ['/.env','/.private/metamask/deployment.db','/contracts/out/CleanverseEligibility.sol/CleanverseEligibility.json'])assert.equal((await fetch(`${url}${path}`)).status,404);
});
test('foreign or absent origin, DNS rebinding host and unsupported requests cannot reach mutation handlers',async t=>{
  let calls=0;const fake={status:()=>({ready:false}),preflight:async()=>{calls++;return {};}} as unknown as MetaMaskDeploymentService;const {url,port}=await start(t,fake);
  for(const origin of [undefined,'null','https://example.com']){const response=await fetch(`${url}/api/preflight`,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{}'});assert.equal(response.status,403);}
  const rebound=await new Promise<number>(resolve=>{const req=http.request({host:'127.0.0.1',port,path:'/api/status',headers:{Host:`example.com:${port}`}},res=>{res.resume();resolve(res.statusCode!);});req.end();});assert.equal(rebound,403);
  assert.equal((await fetch(`${url}/api/status`,{headers:{Origin:'https://example.com'}})).status,403);assert.equal((await fetch(`${url}/api/preflight`,{method:'POST',headers:{Origin:url,'Content-Type':'text/plain'},body:'{}'})).status,415);assert.equal(calls,0);
});
test('malformed, duplicate, unknown or oversized bodies preserve original handler boundary',async t=>{
  let calls=0;const fake={preflight:async()=>{calls++;return {ok:true};},reserve:async(value:unknown)=>{if(!value||Object.keys(value as object).some(k=>!['planId','checkId'].includes(k)))throw new Error('DEPLOYMENT_REQUEST_INVALID');calls++;return {ok:true};}} as unknown as MetaMaskDeploymentService;const {url}=await start(t,fake),headers={Origin:url,'Content-Type':'application/json'};
  for(const body of ['{','{"extra":true}','[]'])assert.equal((await fetch(`${url}/api/preflight`,{method:'POST',headers,body})).status===200,false);
  assert.equal((await fetch(`${url}/api/reserve`,{method:'POST',headers,body:'{"planId":"a","planId":"b"}'})).status,400);
  assert.equal((await fetch(`${url}/api/reserve`,{method:'POST',headers,body:'{"planId":"a","plan\\u0049d":"b"}'})).status,400);
  assert.equal((await fetch(`${url}/api/reserve`,{method:'POST',headers,body:'{"privateKey":"forbidden"}'})).status,409);
  assert.equal((await fetch(`${url}/api/preflight`,{method:'POST',headers,body:JSON.stringify({large:'x'.repeat(5000)})})).status,413);assert.equal(calls,0);
  assert.equal((await fetch(`${url}/api/preflight`,{method:'POST',headers,body:'{}'})).status,200);assert.equal(calls,1);
});
