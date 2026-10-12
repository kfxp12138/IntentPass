import {erc20Abi} from 'viem';
import {isDeepStrictEqual} from 'node:util';
import {ExecutionScopeSchema,type ExecutionScope} from '../../automation/src/background-scope.js';
import {grantTypes} from '../../protocol/src/typed-data.js';
import {acceptanceTypedData,committeeHash} from '../../protocol/src/escrow.js';
import {escrowAbi} from '../../protocol/src/escrow-abi.js';
import {semanticPrivyPolicyRules} from './privy-policy.js';

export type BackgroundRole='buyer'|'seller';
const domainTypes=[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}];
/** Offline policy blueprints. Amount/task aggregate budget is additionally fenced
 * by the immutable single-job worker lease, not claimed as a Privy rolling limit.
 */
export function backgroundActorPolicy(input:unknown,role:BackgroundRole){
  const s=ExecutionScopeSchema.parse(input),d=s.deployment,actor=role==='buyer'?s.buyer:s.seller,index=d.committee.findIndex(w=>w.toLowerCase()===actor.toLowerCase());
  const authorityEnd=s.mode==='general-job'?s.profile.expiresAt:s.expiresAt,amountLimit=s.mode==='general-job'?s.profile.maxUnitsPerOrder:s.maxTotalUnits;
  const expires=authorityEnd===null?[]:[{field_source:'system' as const,field:'current_unix_timestamp' as const,operator:'lt' as const,value:authorityEnd}];
  const domain=[{field_source:'ethereum_typed_data_domain' as const,field:'chainId' as const,operator:'eq' as const,value:s.chainId},{field_source:'ethereum_typed_data_domain' as const,field:'verifyingContract' as const,operator:'eq' as const,value:d.arbiter.toLowerCase()}];
  const message=(types:unknown,primary_type:string,field:string,value:string,operator:'eq'|'lte'='eq')=>({field_source:'ethereum_typed_data_message' as const,field,operator,value,typed_data:{primary_type,types}});
  const rules:{name:string;method:'eth_signTypedData_v4'|'eth_sendTransaction';action:'ALLOW';conditions:unknown[]}[]=[];
  if(role==='buyer'){
    const types={EIP712Domain:domainTypes,...grantTypes};
    rules.push({name:'One-use Grant',method:'eth_signTypedData_v4',action:'ALLOW',conditions:[...expires,...domain,...Object.entries({schemaVersion:'1',owner:s.buyer.toLowerCase(),executor:d.executor.toLowerCase(),chainId:s.chainId,arbiter:d.arbiter.toLowerCase(),asset:d.asset.toLowerCase(),maxUses:'1'}).map(([field,value])=>message(types,'CapabilityGrant',field,value)),...(amountLimit===null?[]:[message(types,'CapabilityGrant','amount',amountLimit,'lte')]),...(authorityEnd===null?[]:[message(types,'CapabilityGrant','deadline',authorityEnd,'lte')])]});
  }
  const zero='0x'+'00'.repeat(32),acceptance=acceptanceTypedData({orderId:zero,contextHash:zero,evidenceHash:zero,committeeHash:committeeHash(d.committee),expiresAt:s.expiresAt},d);
  rules.push({name:'Committee Acceptance',method:'eth_signTypedData_v4',action:'ALLOW',conditions:[...expires,...domain,message({EIP712Domain:domainTypes,...acceptance.types},acceptance.primaryType,'committeeHash',committeeHash(d.committee)),...(authorityEnd===null?[]:[message({EIP712Domain:domainTypes,...acceptance.types},acceptance.primaryType,'expiresAt',authorityEnd,'lte')])]});
  const transaction=(name:'approve'|'deliver'|'accept'|'withdraw',to:string,extra:(abi:unknown)=>unknown[]=()=>[])=>{
    const abi=(name==='approve'?erc20Abi:escrowAbi).filter(v=>v.type==='function'&&v.name===name);
    rules.push({name:`IntentPass ${name}`,method:'eth_sendTransaction',action:'ALLOW',conditions:[...expires,
      {field_source:'ethereum_transaction',field:'chain_id',operator:'eq',value:s.chainId},
      {field_source:'ethereum_transaction',field:'to',operator:'eq',value:to.toLowerCase()},
      {field_source:'ethereum_transaction',field:'value',operator:'eq',value:'0'},
      {field_source:'ethereum_calldata',field:'function_name',operator:'eq',value:name,abi},...extra(abi)]});
  };
  if(role==='buyer')transaction('approve',d.asset,abi=>[{field_source:'ethereum_calldata',field:'approve.spender',operator:'eq',value:d.arbiter.toLowerCase(),abi},...(amountLimit===null?[]:[{field_source:'ethereum_calldata',field:'approve.amount',operator:'lte',value:amountLimit,abi}])]);
  else{transaction('deliver',d.arbiter);transaction('withdraw',d.arbiter);}
  transaction('accept',d.arbiter,abi=>[{field_source:'ethereum_calldata',field:'accept.memberIndex',operator:'eq',value:String(index),abi}]);
  return {name:`IntentPass background ${role}`,version:'1.0' as const,chain_type:'ethereum' as const,rules};
}
export interface BackgroundAuthority {role:BackgroundRole;walletId:string;signerId:string;policyId:string;}
export interface BackgroundAuthorityReadPort {wallet(id:string):Promise<unknown>;policy(id:string):Promise<unknown>;}
/** GET-only current scope proof. Key possession and RPC readiness remain separate. */
export async function inspectBackgroundAuthority(scope:ExecutionScope,authority:BackgroundAuthority,port:BackgroundAuthorityReadPort,now=BigInt(Math.floor(Date.now()/1000))){
  const s=ExecutionScopeSchema.parse(scope);if(now>=BigInt(s.expiresAt)||s.mode==='single-report-background'&&BigInt(s.expiresAt)>now+86400n)throw Error('BACKGROUND_SCOPE_EXPIRED');
  const address=authority.role==='buyer'?s.buyer:s.seller,w=await port.wallet(authority.walletId) as {id?:string;address?:string;chain_type?:string;archived_at?:unknown;additional_signers?:{signer_id:string;override_policy_ids:string[]}[]};
  const delegates=w.additional_signers?.filter(v=>v.signer_id===authority.signerId);
  if(w.id!==authority.walletId||w.address?.toLowerCase()!==address.toLowerCase()||w.chain_type!=='ethereum'||w.archived_at!=null||delegates?.length!==1||!isDeepStrictEqual(delegates[0].override_policy_ids,[authority.policyId]))throw Error('BACKGROUND_DELEGATION_REQUIRED');
  const policy=await port.policy(authority.policyId) as ReturnType<typeof backgroundActorPolicy>&{id:string};
  const expected=backgroundActorPolicy(s,authority.role);
  if(policy.id!==authority.policyId||policy.version!==expected.version||policy.chain_type!==expected.chain_type||!isDeepStrictEqual(semanticPrivyPolicyRules(policy.rules),semanticPrivyPolicyRules(expected.rules)))throw Error('BACKGROUND_POLICY_MISMATCH');
  return {role:authority.role,address,delegationAndPolicyVerified:true as const,keyPossessionVerified:false as const,canExecute:false as const};
}
