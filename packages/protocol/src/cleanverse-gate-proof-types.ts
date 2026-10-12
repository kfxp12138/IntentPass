import {z} from 'zod';
import type {Address,Hex,Transaction,TransactionReceipt} from 'viem';
import {address} from './schemas.js';
const nonzero=address.refine(value=>BigInt(value)!==0n);
export const CleanverseGateConfigSchema=z.object({chainId:z.literal('10143'),deployer:nonzero,asset:nonzero,validator:nonzero,policy:nonzero,pool:nonzero,
  nonce:z.bigint().nonnegative().max(BigInt(Number.MAX_SAFE_INTEGER)-1n)}).strict();
export type CleanverseGateConfig=z.infer<typeof CleanverseGateConfigSchema>;
export interface CleanverseGateProofPort{
  blockTag:'finalized';chainId():Promise<number>;
  block(number?:bigint):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
  transaction(hash:Hex):Promise<(Pick<Transaction,'hash'|'from'|'to'|'input'|'value'|'nonce'|'blockNumber'|'blockHash'>&{chainId?:number})|null>;
  receipt(hash:Hex):Promise<Pick<TransactionReceipt,'transactionHash'|'from'|'to'|'status'|'contractAddress'|'blockNumber'|'blockHash'>|null>;
  code(address:Address,blockNumber:bigint):Promise<Hex|undefined>;
  configuration(address:Address,blockNumber:bigint):Promise<{asset:string;validator:string;policy:string;pool:string}>;
}
