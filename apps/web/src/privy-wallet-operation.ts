/** One protected-context operation per SDK, shared by signing and asset approval. */
const active=new WeakSet<object>();
export async function withWalletOperation<T>(sdk:object,work:()=>Promise<T>):Promise<T>{
  if(active.has(sdk))throw new Error('WALLET_SIGNATURE_PENDING');
  active.add(sdk);try{return await work();}finally{active.delete(sdk);}
}
