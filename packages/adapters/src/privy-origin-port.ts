import type {PrivyClient} from '@privy-io/node';
import {ProviderIdSchema,type PrivyOriginPort} from '../../protocol/src/day4-origin-types.js';

/** A fixed, read-only SDK surface. The client and its authenticated transport
 * are supplied by the caller; constructing this port does not attest that a
 * custom transport is the official Privy API. */
export function privyOriginPort(client:PrivyClient):PrivyOriginPort{
  let reads:{transaction:(id:string)=>Promise<unknown>;wallet:(id:string)=>Promise<unknown>;policy:(id:string)=>Promise<unknown>};
  try{
    const transactions=client.transactions(),wallets=client.wallets(),policies=client.policies();
    reads=Object.freeze({transaction:transactions.get.bind(transactions),wallet:wallets.get.bind(wallets),policy:policies.get.bind(policies)});
  }catch{throw Error('PRIVY_ORIGIN_CLIENT_INVALID');}
  const id=(input:string)=>{
    if(!ProviderIdSchema.safeParse(input).success)throw Error('PRIVY_ORIGIN_ID_INVALID');
    return input;
  };
  return Object.freeze({transaction:async(input:string)=>reads.transaction(id(input)),wallet:async(input:string)=>reads.wallet(id(input)),
    policy:async(input:string)=>reads.policy(id(input))});
}
