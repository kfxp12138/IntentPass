import {z} from 'zod';
import {encodeAbiParameters,concatHex,keccak256,type Address,type Hex} from 'viem';
import {address} from './schemas.js';
import {committeeHash} from './escrow.js';
const nonzero=address.refine(v=>BigInt(v)!==0n);
const DeploymentConfigBase=z.object({chainId:z.enum(['143','10143']),deployer:nonzero,asset:nonzero,gate:nonzero,reviewer:nonzero,committee:z.tuple([nonzero,nonzero,nonzero])}).strict();
const uniqueMembers=(v:{committee:string[]},c:z.RefinementCtx)=>{if(new Set(v.committee.map(a=>a.toLowerCase())).size!==3)c.addIssue({code:'custom',message:'COMMITTEE_INVALID',path:['committee']});};
export const DeploymentConfigSchema=DeploymentConfigBase.superRefine(uniqueMembers);
const LocalDeploymentConfigSchema=DeploymentConfigBase.extend({chainId:z.literal('31337')}).superRefine(uniqueMembers);
export type DeploymentConfig=z.infer<typeof DeploymentConfigSchema>;
export function deploymentDraft(input:unknown,artifact:unknown,options:{local?:true}={}){
  const config=(options.local?LocalDeploymentConfigSchema:DeploymentConfigSchema).parse(input);
  const parsed=z.object({abi:z.array(z.unknown()),bytecode:z.object({object:z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/)})}).passthrough().parse(artifact);
  const constructors=parsed.abi.filter((v):v is {type:'constructor';inputs:{type:string}[];stateMutability:string}=>!!v&&typeof v==='object'&&'type' in v&&v.type==='constructor');
  if(constructors.length!==1||constructors[0].stateMutability!=='nonpayable'||JSON.stringify(constructors[0].inputs?.map(v=>v.type))!==JSON.stringify(['address','address','address','address[3]']))throw new Error('DEPLOYMENT_CONSTRUCTOR_MISMATCH');
  const args=encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address[3]'}],[config.asset as Address,config.gate as Address,config.reviewer as Address,config.committee as [Address,Address,Address]]);
  const data=concatHex([parsed.bytecode.object as Hex,args]);
  return {scope:options.local?'LOCAL_TEST_UNSIGNED_ESCROW_CREATION_DRAFT':'UNSIGNED_ESCROW_CREATION_DRAFT',config,committeeHash:committeeHash(config.committee),constructorArgs:args,creationBytecodeHash:keccak256(parsed.bytecode.object as Hex),initCodeHash:keccak256(data),transaction:{from:config.deployer,chainId:config.chainId,data,value:'0'},canExecute:false as const,officialIntegrationVerified:false as const,adminPowers:[] as string[],notes:['Direct creation; no proxy or mutable escrow administrator.','No nonce, gas, fee or predicted address fixed; executor must refresh them.','Asset and gate behavior, official provenance, deployment receipt and actual funding are not proven.']};
}
export interface DeploymentReadPort {
  chainId():Promise<number>;
  block(number?:bigint):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
  code(address:Address,blockNumber:bigint):Promise<Hex|undefined>;
  balance(address:Address,blockNumber:bigint):Promise<bigint>;
}
export async function inspectDeployment(input:unknown,port:DeploymentReadPort){
  const config=DeploymentConfigSchema.parse(input);
  if(String(await port.chainId())!==config.chainId)throw new Error('DEPLOYMENT_CHAIN_MISMATCH');
  const block=await port.block();if(block.number===null||block.hash===null)throw new Error('DEPLOYMENT_FINALIZED_BLOCK_UNAVAILABLE');
  const [asset,gate,deployer,balance]=await Promise.all([port.code(config.asset as Address,block.number),port.code(config.gate as Address,block.number),port.code(config.deployer as Address,block.number),port.balance(config.deployer as Address,block.number)]);
  if((await port.block(block.number)).hash!==block.hash||String(await port.chainId())!==config.chainId)throw new Error('DEPLOYMENT_SNAPSHOT_CHANGED');
  if(!asset||asset==='0x'||!gate||gate==='0x')throw new Error('DEPLOYMENT_DEPENDENCY_CODE_MISSING');
  // This draft represents an EOA creation transaction, not a smart-wallet call.
  if(deployer&&deployer!=='0x')throw new Error('DEPLOYMENT_CONTRACT_ACCOUNT_UNSUPPORTED');
  if(balance<0n)throw new Error('DEPLOYMENT_BALANCE_INVALID');
  return {scope:'FINALIZED_DEPENDENCY_CODE_AND_NATIVE_BALANCE_ONLY',status:balance===0n?'BLOCKED':'INSPECTED',block:{number:String(block.number),hash:block.hash,timestamp:String(block.timestamp)},assetCodeHash:keccak256(asset),gateCodeHash:keccak256(gate),nativeBalance:String(balance),canExecute:false as const,gasSufficiencyVerified:false as const,officialIntegrationVerified:false as const};
}
