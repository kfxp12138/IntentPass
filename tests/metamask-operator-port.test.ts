import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configuredMetaMaskOperatorPort} from '../scripts/metamask-operator-port.js';

test('unset and empty port retain ephemeral binding while canonical usable decimal ports are preserved',()=>{
  assert.equal(configuredMetaMaskOperatorPort(undefined),0);assert.equal(configuredMetaMaskOperatorPort(''),0);
  for(const value of ['1024','3000','55424','65535'])assert.equal(configuredMetaMaskOperatorPort(value),Number(value));
});
test('port rejects privilege and range boundaries noncanonical quantities and coercible inputs',()=>{
  for(const value of ['0','1023','65536','99999999999999999999','01024','055424','+55424','-55424','55424.0','5e4',
    ' 55424','55424 ','55424\n','0xd880','Infinity','NaN',null,55424,true,{}])
    assert.throws(()=>configuredMetaMaskOperatorPort(value),{message:'METAMASK_OPERATOR_PORT_INVALID'});
});

// Actual entrypoint invocations use an empty isolated cwd and an explicit public
// environment only. Invalid configuration exits before compiler, database,
// provider, wallet, or HTTP listener work; no private env file exists there.
test('both operator entrypoints reject invalid port before preparing or listening and never fall back',t=>{
  const cwd=mkdtempSync(join(tmpdir(),'intentpass-operator-port-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const loader=fileURLToPath(import.meta.resolve('tsx'));
  for(const [script,args] of [['serve-metamask-deployment.ts',[]],['serve-demo-dependency.ts',['--asset']]] as const){
    for(const port of ['1023','65536','55424x']){
      const run=spawnSync(process.execPath,['--experimental-sqlite','--import',loader,resolve('scripts',script),...args],{
        cwd,env:{METAMASK_OPERATOR_PORT:port,NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:15_000,maxBuffer:16_000});
      assert.equal(run.error,undefined);assert.equal(run.signal,null);assert.equal(run.status,1);
      assert.equal(run.stdout,'');assert.equal(run.stderr.trim(),'METAMASK_OPERATOR_PORT_INVALID');
      assert.deepEqual(readdirSync(cwd),[]);
    }
  }
});
