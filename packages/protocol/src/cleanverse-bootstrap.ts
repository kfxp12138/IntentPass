import {z} from 'zod';
import {concatHex,encodeAbiParameters,getContractAddress,keccak256,type Address,type Hex} from 'viem';
import {address} from './schemas.js';
import {deploymentDraft,type DeploymentReadPort} from './deployment.js';

const nonzero=address.refine(value=>BigInt(value)!==0n);
export const CleanverseBootstrapConfigSchema=z.object({
  chainId:z.literal('10143'),deployer:nonzero,asset:nonzero,validator:nonzero,policy:nonzero,
  reviewer:nonzero,committee:z.tuple([nonzero,nonzero,nonzero])
}).strict().superRefine((value,context)=>{
  if(new Set(value.committee.map(member=>member.toLowerCase())).size!==3)
    context.addIssue({code:'custom',message:'COMMITTEE_INVALID',path:['committee']});
});
export type CleanverseBootstrapConfig=z.infer<typeof CleanverseBootstrapConfigSchema>;
const equal=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
const hasCode=(value:Hex|undefined)=>!!value&&value!=='0x';
const maxNonce=BigInt(Number.MAX_SAFE_INTEGER)-1n;

/** Two fixed, unsigned CREATE drafts. This does not reserve nonce or send either transaction. */
export function cleanverseBootstrapDraft(input:unknown,gateArtifact:unknown,escrowArtifact:unknown,nonce:bigint){
  const config=CleanverseBootstrapConfigSchema.parse(input);
  if(typeof nonce!=='bigint'||nonce<0n||nonce>maxNonce)throw new Error('BOOTSTRAP_NONCE_INVALID');
  const gateAddress=getContractAddress({from:config.deployer as Address,nonce});
  const escrowAddress=getContractAddress({from:config.deployer as Address,nonce:nonce+1n});
  if(equal(gateAddress,escrowAddress)||[config.deployer,config.asset,config.validator,config.policy,config.reviewer,...config.committee]
    .some(value=>equal(value,gateAddress)||equal(value,escrowAddress)))throw new Error('BOOTSTRAP_FUTURE_ADDRESS_ROLE_CONFLICT');
  const gate=z.object({abi:z.array(z.unknown()),bytecode:z.object({object:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/)})}).passthrough().parse(gateArtifact);
  const constructors=gate.abi.filter((entry):entry is {type:'constructor';stateMutability:string;inputs:{type:string}[]}=>
    !!entry&&typeof entry==='object'&&'type' in entry&&entry.type==='constructor');
  if(constructors.length!==1||constructors[0].stateMutability!=='nonpayable'
    ||JSON.stringify(constructors[0].inputs?.map(entry=>entry.type))!==JSON.stringify(['address','address','address','address']))
    throw new Error('BOOTSTRAP_GATE_CONSTRUCTOR_MISMATCH');
  const gateArgs=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],
    [config.asset as Address,config.validator as Address,config.policy as Address,escrowAddress]);
  const gateData=concatHex([gate.bytecode.object as Hex,gateArgs]);
  const escrow=deploymentDraft({chainId:config.chainId,deployer:config.deployer,asset:config.asset,gate:gateAddress,
    reviewer:config.reviewer,committee:config.committee},escrowArtifact);
  for(const data of [gateData,escrow.transaction.data])if((data.length-2)/2>49152)throw new Error('BOOTSTRAP_INITCODE_TOO_LARGE');
  return {
    scope:'SEQUENTIAL_UNSIGNED_CLEANVERSE_GATE_AND_ESCROW_DRAFT',config,
    gate:{predictedAddress:gateAddress,constructorArgs:gateArgs,initCodeHash:keccak256(gateData),
      transaction:{from:config.deployer,chainId:'10143',nonce:String(nonce),data:gateData,value:'0'}},
    escrow:{predictedAddress:escrowAddress,constructorArgs:escrow.constructorArgs,initCodeHash:escrow.initCodeHash,
      committeeHash:escrow.committeeHash,transaction:{...escrow.transaction,nonce:String(nonce+1n)}},
    canExecute:false as const,officialIntegrationVerified:false as const,nonceReserved:false as const,
    gasSufficiencyVerified:false as const,gateCreationVerified:false as const,
    notes:['Same EOA creates gate at nonce N, then escrow at nonce N+1; gate.pool and escrow.gate are fixed to these predicted addresses.',
      'No gas or fee bounds, signature, reservation, broadcast or gate receipt are supplied.',
      'Any intervening wallet transaction invalidates this sequence; do not send the second draft blindly.',
      'After gate creation, verify its original finalized receipt/runtime and refresh escrow nonce, dependencies, gas and fees with the existing constrained handoff.',
      'Official asset provenance, validator behavior, pool registration, custody eligibility and actual funds remain unverified.']
  };
}

export interface CleanverseBootstrapReadPort extends DeploymentReadPort {
  nonce(address:Address,tag:'latest'|'pending'):Promise<bigint>;
  currentBalance(address:Address):Promise<bigint>;
  assetPolicy(address:Address,blockNumber:bigint):Promise<Address>;
}
export async function inspectCleanverseBootstrap(input:unknown,gateArtifact:unknown,escrowArtifact:unknown,port:CleanverseBootstrapReadPort){
  const config=CleanverseBootstrapConfigSchema.parse(input);
  if(await port.chainId()!==10143)throw new Error('BOOTSTRAP_CHAIN_MISMATCH');
  const block=await port.block();if(block.number===null||block.hash===null)throw new Error('BOOTSTRAP_FINALIZED_BLOCK_UNAVAILABLE');
  const [pending,latest]=await Promise.all([port.nonce(config.deployer as Address,'pending'),port.nonce(config.deployer as Address,'latest')]);
  if(pending!==latest)throw new Error('BOOTSTRAP_PENDING_TRANSACTION');
  const draft=cleanverseBootstrapDraft(config,gateArtifact,escrowArtifact,pending);
  const addresses=[config.asset,config.validator,config.policy,config.deployer,draft.gate.predictedAddress,draft.escrow.predictedAddress] as Address[];
  const [codes,policy,balance]=await Promise.all([Promise.all(addresses.map(value=>port.code(value,block.number!))),
    port.assetPolicy(config.asset as Address,block.number),port.currentBalance(config.deployer as Address)]);
  if(codes.slice(0,3).some(value=>!hasCode(value)))throw new Error('BOOTSTRAP_DEPENDENCY_CODE_MISSING');
  if(hasCode(codes[3]))throw new Error('BOOTSTRAP_CONTRACT_ACCOUNT_UNSUPPORTED');
  if(codes.slice(4).some(hasCode))throw new Error('BOOTSTRAP_PREDICTED_ADDRESS_OCCUPIED');
  if(!equal(policy,config.policy))throw new Error('BOOTSTRAP_ASSET_POLICY_MISMATCH');
  if(balance<0n)throw new Error('BOOTSTRAP_BALANCE_INVALID');
  const [recheckBlock,recheckChain,recheckPending,recheckLatest]=await Promise.all([
    port.block(block.number),port.chainId(),port.nonce(config.deployer as Address,'pending'),port.nonce(config.deployer as Address,'latest')]);
  if(recheckBlock.hash!==block.hash||recheckChain!==10143)throw new Error('BOOTSTRAP_SNAPSHOT_CHANGED');
  if(recheckPending!==pending||recheckLatest!==pending)throw new Error('BOOTSTRAP_NONCE_CHANGED');
  return {draft,inspection:{scope:'FINALIZED_DEPENDENCY_CODES_POLICY_LINK_AND_STABLE_EOA_NONCE_ONLY',status:balance===0n?'BLOCKED':'INSPECTED',
    block:{number:String(block.number),hash:block.hash,timestamp:String(block.timestamp)},nativeBalance:String(balance),nonce:String(pending),
    dependencyCodeHashes:codes.slice(0,3).map(value=>keccak256(value!)),policyLinked:true,nonceRechecked:true,
    canExecute:false as const,officialIntegrationVerified:false as const,gasSufficiencyVerified:false as const}};
}
