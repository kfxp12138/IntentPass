/** viem infers the EIP-712 domain chain type from a number/bigint. Keep the
 * fixed small chain ID numeric in the domain, but all uint256 message values
 * decimal strings so JSON never loses amount or nonce precision.
 */
export function formatExampleOutput(value:unknown){return JSON.stringify(value,(key,item)=>{if(key==='domain'&&item&&typeof item==='object'&&typeof item.chainId==='bigint'){if(item.chainId<0n||item.chainId>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('EXAMPLE_OUTPUT_INVALID');return {...item,chainId:Number(item.chainId)};}return typeof item==='bigint'?item.toString():item;},2)+'\n';}
