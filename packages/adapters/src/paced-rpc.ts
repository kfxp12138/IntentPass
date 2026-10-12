import {http,type Transport} from 'viem';
/** Shared start-rate limit for one configured RPC endpoint. No retry or payload change. */
const queues=new Map<string,{tail:Promise<void>;lastStart:number}>();
export function pacedHttp(url:string|undefined,options:{timeout?:number;fetchOptions?:RequestInit}={}):Transport{
  if(!url)throw Error('RPC_ENDPOINT_REQUIRED');const endpoint=url;
  const base=http(url,{...options,retryCount:0});
  return config=>{
    const transport=base(config);
    const request:typeof transport.request=async(args,requestOptions)=>{
      let queue=queues.get(endpoint);if(!queue){queue={tail:Promise.resolve(),lastStart:-Infinity};queues.set(endpoint,queue);}
      const current=queue,gate=current.tail.then(async()=>{let remaining=125-(performance.now()-current.lastStart);while(remaining>0){await new Promise<void>(resolve=>setTimeout(resolve,remaining));remaining=125-(performance.now()-current.lastStart);}current.lastStart=performance.now();});
      current.tail=gate.catch(()=>{});await gate;
      return transport.request(args,{...requestOptions,retryCount:0});
    };
    return {...transport,request};
  };
}
