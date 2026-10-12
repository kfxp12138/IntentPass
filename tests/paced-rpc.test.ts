import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createPublicClient} from 'viem';
import {pacedHttp} from '../packages/adapters/src/paced-rpc.js';
test('separate clients share the endpoint start limit, preserve requests and never retry an ambiguous RPC error',async()=>{
  const arrivals:number[]=[],methods:string[]=[],server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const input=JSON.parse(data);arrivals.push(performance.now());methods.push(input.method);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(input.method==='eth_call'?{jsonrpc:'2.0',id:input.id,error:{code:-32011,message:'LOCAL TEST FAILURE'}}:{jsonrpc:'2.0',id:input.id,result:'0x64'}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`,a=createPublicClient({transport:pacedHttp(url)}),b=createPublicClient({transport:pacedHttp(url)});
  try{await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).request({method:'eth_blockNumber'})));assert.equal(arrivals.length,20);for(const start of arrivals)assert.ok(arrivals.filter(t=>t>=start&&t<start+1000).length<=9);assert.ok(arrivals[19]-arrivals[0]>=2250);assert.deepEqual(new Set(methods),new Set(['eth_blockNumber']));await assert.rejects(a.request({method:'eth_call',params:[{to:'0x0000000000000000000000000000000000000001'},'latest']}));assert.equal(methods.filter(m=>m==='eth_call').length,1);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
test('paced RPC retains explicit redirect rejection and never forwards a request to its redirect target',async()=>{
  let forwarded=0;const target=createServer((_req,res)=>{forwarded++;res.end('unexpected');});await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const dest=target.address();assert.ok(dest&&typeof dest!=='string');
  const origin=createServer((_req,res)=>{res.writeHead(307,{Location:`http://127.0.0.1:${dest.port}/`});res.end();});await new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve));const source=origin.address();assert.ok(source&&typeof source!=='string');
  try{const client=createPublicClient({transport:pacedHttp(`http://127.0.0.1:${source.port}`,{fetchOptions:{redirect:'error'}})});await assert.rejects(client.request({method:'eth_blockNumber'}));assert.equal(forwarded,0);}finally{await Promise.all([new Promise<void>(resolve=>origin.close(()=>resolve())),new Promise<void>(resolve=>target.close(()=>resolve()))]);}
});
