import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {escrowAbi} from '../packages/protocol/src/escrow-abi.js';
const artifact=JSON.parse(readFileSync('contracts/out/ContextVoteEscrow.sol/ContextVoteEscrow.json','utf8'));
for(const item of escrowAbi) {
  const actual=artifact.abi.find((v:{type:string;name?:string})=>v.type===item.type&&v.name===item.name);
  assert.deepEqual(item,actual,`Contract/SDK ABI drift: ${item.name}`);
}
for(const name of ['submit','settle','timeout','orders','withdraw','credits','withdrawn']) assert.ok(escrowAbi.some(v=>v.type==='function'&&v.name===name));
console.log('PASS: SDK ABI matches compiled escrow artifact');
