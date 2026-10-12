import {z} from 'zod';
import {createPublicClient,http,type Address,type Hex,type PublicClient} from 'viem';
import {monadTestnet} from 'viem/chains';
import {EscrowReader,OrderSnapshotSchema,digest,address} from '../../packages/protocol/src/index.js';

const DeploymentSchema=z.object({chainId:z.literal('10143'),arbiter:address,asset:address,gate:address,reviewer:address,committeeHash:digest}).strict();
export const PublicDeploymentManifestSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('PROJECT_CONFIGURED_TESTNET_DEPLOYMENT_NOT_INDEPENDENT_CREATION_PROOF'),deployment:DeploymentSchema}).strict();
export function publicRpcUrl(value:string=monadTestnet.rpcUrls.default.http[0]){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('PUBLIC_CHAIN_ENDPOINT_INVALID');
  return u.href;
}
/** Independent use of the exported SDK reader. No website, login, wallet,
 * signer or transaction sender is constructed. The manifest is a project pin,
 * not a claim that contract creation/provider provenance has been verified. */
export async function readPublicOrder(input:unknown,orderId:string,client:PublicClient){
  const manifest=PublicDeploymentManifestSchema.parse(structuredClone(input)),d=Object.freeze(manifest.deployment),id=digest.parse(orderId) as Hex;
  // Bind only the three read capabilities used by EscrowReader.
  const reads=Object.freeze({getChainId:client.getChainId.bind(client),getBlock:client.getBlock.bind(client),readContract:client.readContract.bind(client)});
  const tip=await reads.getBlock({blockTag:'finalized'});
  if(tip.number===null||tip.hash===null)throw Error('PUBLIC_FINALIZED_BLOCK_UNAVAILABLE');
  const reader=new EscrowReader(reads as unknown as PublicClient,{...d,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:d.gate as Address,reviewer:d.reviewer as Address,committeeHash:d.committeeHash as Hex});
  const snapshot=OrderSnapshotSchema.parse(await reader.readAt(id,tip.number));
  if(snapshot.block.hash!==tip.hash||snapshot.block.timestamp!==String(tip.timestamp))throw Error('PUBLIC_CHAIN_ANCHOR_CHANGED');
  return {schemaVersion:1,status:'ORDER_READ_VERIFIED' as const,scope:'PUBLIC_FINALIZED_SDK_ORDER_READ_NOT_AUTHENTICATED_PURCHASE_ACCEPTANCE' as const,
    snapshot,signaturesRequested:0,transactionsSent:0,limits:['Public chain state only; no model review, authenticated purchase, deployment creation or provider-origin acceptance.','Project manifest pins the expected contracts and roles.']};
}
export interface ChainExampleIO{manifest:unknown;out:(value:unknown)=>void;error:(code:string)=>void;client?:PublicClient;}
export async function runChainExample(args:readonly string[],env:Record<string,string|undefined>,io:ChainExampleIO){
  try{
    if(args.length!==1)throw Error('PUBLIC_CHAIN_USAGE_INVALID');
    const orderId=digest.parse(args[0]),endpoint=publicRpcUrl(env.INTENTPASS_RPC_URL);
    const client=io.client??createPublicClient({ccipRead:false,transport:http(endpoint,{retryCount:0,timeout:10000,fetchOptions:{redirect:'error'}})});
    io.out(await readPublicOrder(io.manifest,orderId,client));return 0;
  }catch(error){const code=error instanceof Error?error.message:'';io.error(['PUBLIC_CHAIN_USAGE_INVALID','PUBLIC_CHAIN_ENDPOINT_INVALID','PUBLIC_CHAIN_ANCHOR_CHANGED','PUBLIC_FINALIZED_BLOCK_UNAVAILABLE','CHAIN_MISMATCH','DEPLOYMENT_MISMATCH','ESCROW_INSOLVENT','CHAIN_SNAPSHOT_CHANGED'].includes(code)?code:'PUBLIC_CHAIN_READ_UNAVAILABLE');return 1;}
}
