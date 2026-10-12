// Local subprocess double only. No real JEV, Privy request, wallet key or network access.
import {ReviewStore} from '../../packages/storage/src/review-store.js';
import {ReviewService,type ReceiptSigner} from '../../apps/web/src/services/review.js';
import {ReviewRequestSchema} from '../../packages/protocol/src/draft.js';
import type {EscrowDeployment} from '../../packages/protocol/src/escrow-read.js';
const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const data=JSON.parse(Buffer.concat(chunks).toString('utf8')),request=ReviewRequestSchema.parse(data.request),deployment=data.deployment as EscrowDeployment,mode=process.argv[2];
if(!['race','pending','signing'].includes(mode))throw new Error('LOCAL_REVIEW_WORKER_MODE_INVALID');
const store=new ReviewStore(data.path);let calls=0,signs=0;
const forever=<T>()=>new Promise<T>(()=>{setInterval(()=>{},60000);});
const jev={model:'jev-1.13.0',evaluate:async()=>{
  calls++;if(mode==='pending'){process.stdout.write(JSON.stringify({phase:'MODEL_STARTED'})+'\n');return forever<never>();}
  await new Promise(resolve=>setTimeout(resolve,200));const choice=mode==='signing'?'SUPPORTED' as const:'INSUFFICIENT' as const,answer={type:'choice' as const,choice,confidence:1,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,CONTRADICTED:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0}};
  return {model:'jev-1.13.0',answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:12,output_tokens:3}};
}};
const signer:ReceiptSigner|undefined=mode==='signing'?{address:deployment.reviewer,sign:async()=>{signs++;process.stdout.write(JSON.stringify({phase:'SIGNING_STARTED'})+'\n');return forever<`0x${string}`>();}}:undefined;
try{const service=new ReviewService(jev,deployment,.9,signer,()=>1000n,store),result=await service.review(request,{subject:'local-worker-subject',wallets:[request.intent.buyer as `0x${string}`]});process.stdout.write(JSON.stringify({calls,signs,result})+'\n');}finally{store.close();}
