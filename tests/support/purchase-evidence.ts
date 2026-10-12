import {originalAuthorizationFixture,readTestHash} from './original-authorization.js';
import {ProposalService} from '../../apps/web/src/services/propose.js';
import {ReviewService} from '../../apps/web/src/services/review.js';
import {PurchaseFlow,type PurchasePort} from '../../apps/web/src/purchase-flow.js';
import {BrowserSession,type BrowserAuthPort} from '../../apps/web/src/browser-session.js';
import {createApp} from '../../apps/web/src/server.js';
import {PurchaseClient} from '../../packages/protocol/src/purchase-client.js';
import {PreflightRequestSchema} from '../../packages/protocol/src/purchase-preflight.js';
import {receiptTypedData,grantTypedData,committeeHash} from '../../packages/protocol/src/index.js';
import {questionConfigHash,type JevResult} from '../../packages/adapters/src/jev-review.js';
import {AuthenticationRejected} from '../../packages/adapters/src/privy-auth.js';
import type {EvidenceBundle} from '../../packages/protocol/src/review-evidence.js';
import type {Address} from 'viem';
import type {Principal} from '../../packages/adapters/src/privy-auth.js';
import type {EscrowDeployment} from '../../packages/protocol/src/escrow-read.js';
export async function purchaseEvidenceFixture(options:{background?:boolean}={}){
  const x=await originalAuthorizationFixture(options.background?'10143':'31337',{singleReportBackground:options.background}),model='jev-1.13.0',ev=x.payload.evidence;if(ev.schemaVersion!==2)throw Error('LOCAL_FIXTURE_SALT_REQUIRED');
  const deployment:EscrowDeployment={chainId:x.deployment.chainId,arbiter:x.deployment.arbiter as Address,asset:x.deployment.asset as Address,reviewer:x.deployment.reviewer as Address,gate:x.deployment.asset as Address,committeeHash:committeeHash(x.deployment.committee)},configuration={privyAppId:'local-evidence-app',meraRpId:'localhost',recoveryDeployment:x.deployment,purchaseRule:{model,minConfidence:.9,questionConfigHash:questionConfigHash(.9)}};
  const entry={quote:x.payload.quote,documents:[{id:'license',subjectQuoteId:x.payload.quote.quoteId,text:'Commercial report license needs more evidence.'},{id:'limitation',subjectQuoteId:x.payload.quote.quoteId,text:'Keep this original limitation in every review.'}]};
  let principal:Principal={subject:'local-evidence-buyer',wallets:[x.buyer.address]};
  let task={policy:x.payload.policy,taskInput:{dataset:x.dataset,buyer:x.buyer.address,seller:x.seller.address},evidence:{...ev,documents:[] as EvidenceBundle['documents']}},planner=0,jev=0,signatures=0,now=1000n,choice:'SUPPORTED'|'INSUFFICIENT'|'CONTRADICTED'='INSUFFICIENT';const reviewed:unknown[]=[];
  const proposal=new ProposalService({model:'LOCAL_PLANNER_DOUBLE',select:async()=>{planner++;return {quoteId:entry.quote.quoteId,evidenceIds:['license']};}},{get:async id=>id.toLowerCase()===entry.quote.quoteId.toLowerCase()?entry:undefined},deployment,{bond:x.payload.intent.bond,deliverySeconds:'1000',settlementSeconds:'2000'},()=>now);
  const review=new ReviewService({model,evaluate:async state=>{jev++;reviewed.push(structuredClone(state));const answer={type:'choice' as const,choice,confidence:1,probabilities:{SUPPORTED:choice==='SUPPORTED'?1:0,INSUFFICIENT:choice==='INSUFFICIENT'?1:0,CONTRADICTED:choice==='CONTRADICTED'?1:0}};return {model,answers:{service:answer,purpose:answer,provenance:answer},usage:{input_tokens:12,output_tokens:3}} satisfies JevResult;}},deployment,.9,{address:x.reviewer.address,sign:(r,d)=>x.reviewer.signTypedData(receiptTypedData(r,d))},()=>now);
  const authPort:BrowserAuthPort={initialize:async()=>{},sendCode:async()=>{},login:async()=>{},token:async()=>'local-evidence-token',logout:async()=>{}},session=new BrowserSession(async()=>authPort,async url=>new Response(JSON.stringify(url==='/api/config'?configuration:principal)));
  // Actual EOA signing, deliberately not real Privy signing or provider evidence.
  session.signGrant=async grant=>{signatures++;return x.buyer.signTypedData(grantTypedData(grant));};
  const port:PurchasePort={catalog:async()=>({entries:[entry]}),propose:input=>proposal.propose(input,principal),review:input=>review.review(input,principal),preflight:async input=>{const {grant:g}=PreflightRequestSchema.parse(input);return {chainId:g.chainId,arbiter:g.arbiter,asset:g.asset,buyer:g.owner,orderId:g.orderId,contextHash:g.contextHash,nonce:g.nonce,amount:g.amount,deadline:g.deadline,state:'UNREGISTERED',consumed:false,revoked:false,transferEligible:true,balance:'100',allowance:'0',blockers:['EXACT_ALLOWANCE_REQUIRED'],block:{number:'100',hash:readTestHash(11),timestamp:String(now),finality:'finalized'},canSubmitPayment:false};}};
  const flow=new PurchaseFlow(()=>task,session,port,()=>now),supplement=(id='additional-1',text='Additional commercial license evidence.')=>({id,subjectQuoteId:entry.quote.quoteId,text});
  const auth={authenticate:async(token:string)=>{if(token!=='local-evidence-token')throw new AuthenticationRejected();return principal;}};
  return {...x,model,entry,configuration,principal:()=>structuredClone(principal),session,port,flow,supplement,task:()=>task,clock:()=>now,setTime:(value:bigint)=>{now=value;},setChoice:(value:typeof choice)=>{choice=value;},setPrincipal:(value:typeof principal)=>{principal=value;},setTask:(value:typeof task)=>{task=value;},updateEvidence:(evidence:EvidenceBundle)=>{if(evidence.schemaVersion!==2)throw Error('LOCAL_FIXTURE_SALT_REQUIRED');task={...task,evidence:structuredClone(evidence)};},counts:()=>({planner,jev,signatures}),reviewed,
    http:async()=>{const app=await createApp({dependencyPrebundling:false,browserApi:{configuration,auth},catalogApi:{auth,list:async()=>({entries:[entry]})},proposeApi:{auth,service:proposal},reviewApi:{auth,service:review}});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const address=app.server.address();if(!address||typeof address==='string')throw Error('LOCAL_PORT_UNAVAILABLE');const url=`http://127.0.0.1:${address.port}`,client=new PurchaseClient(url,async()=>'local-evidence-token',undefined,()=>now);return {url,client,close:()=>app.close()};}};
}
