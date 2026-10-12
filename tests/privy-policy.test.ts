import test from 'node:test';
import assert from 'node:assert/strict';
import {getAddress} from 'viem';
import {semanticPrivyPolicyRules} from '../packages/adapters/src/privy-policy.js';
const address='0xbcf119a20e2a62d2ab4a29647be04d1c2bc8b047',checksum=getAddress(address);
test('decoded calldata only canonicalizes ABI-declared address parameters and retains ambiguous/string values exactly',()=>{
  const rules=(value:string,type:string)=>[{method:'eth_sendTransaction',action:'ALLOW',conditions:[{field_source:'ethereum_calldata',field:'approve.spender',operator:'eq',value,abi:[{type:'function',name:'approve',inputs:[{name:'spender',type}]}]}]}];
  assert.deepEqual(semanticPrivyPolicyRules(rules(address,'address')),semanticPrivyPolicyRules(rules(checksum,'address')));
  const wrong=rules(address,'address');wrong[0].conditions[0].field='params.spender';const wrongCase=structuredClone(wrong);wrongCase[0].conditions[0].value=checksum;assert.notDeepEqual(semanticPrivyPolicyRules(wrong),semanticPrivyPolicyRules(wrongCase));
  assert.notDeepEqual(semanticPrivyPolicyRules(rules(address,'string')),semanticPrivyPolicyRules(rules(checksum,'string')));
  const a=rules(address,'address'),b=rules(checksum,'address');a[0].conditions[0].abi.push({type:'function',name:'other',inputs:[{name:'spender',type:'string'}]});b[0].conditions[0].abi.push({type:'function',name:'other',inputs:[{name:'spender',type:'string'}]});
  assert.deepEqual(semanticPrivyPolicyRules(a),semanticPrivyPolicyRules(b));
  a[0].conditions[0].abi.push({type:'function',name:'approve',inputs:[{name:'spender',type:'string'}]});b[0].conditions[0].abi.push({type:'function',name:'approve',inputs:[{name:'spender',type:'string'}]});
  assert.notDeepEqual(semanticPrivyPolicyRules(a),semanticPrivyPolicyRules(b));
});
test('provider checksummed values preserve exact declared address scope without mutating either input',()=>{
  const conditions=[{field_source:'ethereum_transaction',field:'to',operator:'eq',value:address},{field_source:'ethereum_typed_data_domain',field:'verifyingContract',operator:'eq',value:address},{field_source:'ethereum_typed_data_message',field:'reviewer',operator:'eq',value:address,typed_data:{primary_type:'DecisionReceipt',types:{DecisionReceipt:[{name:'reviewer',type:'address'}]}}}];
  const a=[{method:'fixed',action:'ALLOW',conditions}],b=structuredClone(a);b[0].conditions.forEach(c=>c.value=checksum);
  assert.deepEqual(semanticPrivyPolicyRules(a),semanticPrivyPolicyRules(b));assert.equal(b[0].conditions[0].value,checksum);assert.equal(a[0].conditions[0].value,address);
});
test('other message types, operators, extra conditions and different underlying addresses cannot broaden policy equality',()=>{
  const base=[{method:'eth_signTypedData_v4',action:'ALLOW',conditions:[{field_source:'ethereum_typed_data_message',field:'label',operator:'eq',value:address,typed_data:{primary_type:'Receipt',types:{Receipt:[{name:'label',type:'string'}]}}}]}];
  const changed=structuredClone(base);changed[0].conditions[0].value=checksum;assert.notDeepEqual(semanticPrivyPolicyRules(base),semanticPrivyPolicyRules(changed));
  const transaction=[{method:'eth_sendTransaction',action:'ALLOW',conditions:[{field_source:'ethereum_transaction',field:'to',operator:'eq',value:address}]}];
  for(const change of [{value:'0x'+'22'.repeat(20)},{operator:'ne'},{field:'value'}]){const x=structuredClone(transaction);Object.assign(x[0].conditions[0],change);assert.notDeepEqual(semanticPrivyPolicyRules(transaction),semanticPrivyPolicyRules(x));}
  const extra=structuredClone(transaction);extra[0].conditions.push({...extra[0].conditions[0]});assert.notDeepEqual(semanticPrivyPolicyRules(transaction),semanticPrivyPolicyRules(extra));
});
