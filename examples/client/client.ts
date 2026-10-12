import {z} from 'zod';
import {PurchaseClient} from '../../packages/protocol/src/purchase-client.js';
import {FundingSubmitRequestSchema,FundingReconcileRequestSchema} from '../../packages/protocol/src/funding-api.js';
import {AllocationRequestSchema} from '../../packages/protocol/src/allocation.js';
import {AllocationTriggerRequestSchema,AllocationAttemptReconcileRequestSchema} from '../../packages/protocol/src/allocation-api.js';
import {digest} from '../../packages/protocol/src/schemas.js';
import {LocalSdkReadRequestSchema,LocalSdkSessionInputSchema,LocalSdkReadResultSchema} from '../../packages/protocol/src/local-sdk-read.js';
import {LocalSdkWorkflowRequestSchema,LocalSdkWorkflowSessionSchema,LocalSdkWorkflowResultSchema} from '../../packages/protocol/src/local-sdk-read.js';
import {WorkflowIdSchema,WorkflowSubmitRequestSchema} from '../../packages/protocol/src/workflow-api.js';
import {LocalSdkProcurementRequestSchema,LocalSdkProcurementSessionSchema,LocalSdkProcurementReceiptSchema,sdkProcurementSubmission} from '../../packages/protocol/src/local-sdk-procurement.js';
export interface ExampleIO {input:()=>Promise<unknown>;out:(value:unknown)=>void;error:(code:string)=>void;transport?:typeof fetch;}
const modes=['health','catalog','propose','review','prepare','finalize','preflight','submit','reconcile','order','check-order','check-workflow','workflows','workflow-submit','workflow-output','workflow-cancel','procure','prepare-allocation','query-allocation','reconcile-allocation','trigger-allocation'] as const;
/** Independent public SDK caller: no UI imports, wallet keys, arbitrary RPC,
 * background tasks, signing or automatic retries. One operation per command.
 */
export async function runExample(args:readonly string[],env:Record<string,string|undefined>,io:ExampleIO):Promise<number>{
  try{const mode=args[0]??'health',flags=args.slice(1);if(!modes.includes(mode as typeof modes[number])||new Set(flags).size!==flags.length||flags.some(v=>!['--confirm','--print-payload','--local-session-input','--local-procurement-input'].includes(v)))throw new Error('EXAMPLE_USAGE_INVALID');
    const localSession=flags.includes('--local-session-input');if(localSession&&(!['check-order','check-workflow'].includes(mode)||flags.length!==1))throw new Error('EXAMPLE_USAGE_INVALID');
    const localProcurement=flags.includes('--local-procurement-input');if(localProcurement&&(mode!=='procure'||flags.length!==2||!flags.includes('--confirm')))throw Error('EXAMPLE_USAGE_INVALID');
    if(flags.includes('--confirm')&&!['submit','trigger-allocation','workflow-submit','workflow-cancel','procure'].includes(mode))throw new Error('EXAMPLE_USAGE_INVALID');if(['submit','trigger-allocation','workflow-submit','workflow-cancel','procure'].includes(mode)&&!flags.includes('--confirm'))throw new Error('EXAMPLE_CONFIRMATION_REQUIRED');
    let requestInput:unknown,token=env.INTENTPASS_TOKEN,expectedSubject:string|undefined;
    if(localSession){const local=(mode==='check-workflow'?LocalSdkWorkflowSessionSchema:LocalSdkSessionInputSchema).parse(await io.input());requestInput={orderId:local.orderId,...('jobId'in local?{jobId:local.jobId}:{})};token=local.token;expectedSubject=local.expectedSubject;}
    if(localProcurement){const {token:t,expectedSubject:s,...request}=LocalSdkProcurementSessionSchema.parse(await io.input());token=t;expectedSubject=s;requestInput=request;}
    const client=new PurchaseClient(env.INTENTPASS_URL??'http://127.0.0.1:3000',async()=>{if(!token)throw new Error('LOGIN_REQUIRED');return token;},io.transport);
    let result:unknown;if(mode==='health')result=await client.health();
    else if(mode==='catalog')result=await client.catalog();
    else if(mode==='workflows')result=await client.workflows();
    else {const input=localSession||localProcurement?requestInput:await io.input();switch(mode){
      case 'procure':{
        const r=LocalSdkProcurementRequestSchema.parse(input),before=await client.session();
        if(expectedSubject&&before.subject!==expectedSubject||!before.wallets.some(w=>w.toLowerCase()===r.memory.taskInput.buyer.toLowerCase()))throw Error('AUTHORIZATION_SESSION_CHANGED');
        const job=await client.submitWorkflow({submission:sdkProcurementSubmission(r),confirm:true}),after=await client.session();
        const wallets=(values:readonly string[])=>[...new Set(values.map(w=>w.toLowerCase()))].sort().join(',');
        if(before.subject!==after.subject||wallets(before.wallets)!==wallets(after.wallets))throw Error('AUTHORIZATION_SESSION_CHANGED');
        result=LocalSdkProcurementReceiptSchema.parse({status:'WORKFLOW_SUBMISSION_RECORDED',jobId:job.id,jobStatus:job.status,taskId:r.memory.policy.taskId,walletAddresses:after.wallets,sessionVerifiedBeforeAfter:true,paymentVerified:false});break;
      }
      case 'propose':result=await client.propose(input);break;
      case 'review':result=await client.review(input);break;
      case 'prepare':result=await client.prepareOrder(input);break;
      case 'finalize':{const r=z.object({payload:z.unknown(),ownerSignature:z.string().regex(/^0x[0-9a-fA-F]{130}$/)}).strict().parse(input);result=await client.finalizeOriginal(r.payload,r.ownerSignature);break;}
      case 'preflight':result=await client.preflight(input);break;
      case 'submit':result=await client.submitOriginal(FundingSubmitRequestSchema.parse(input));break;
      case 'reconcile':result=await client.reconcileFunding(FundingReconcileRequestSchema.parse(input));break;
      case 'order':{const r=z.object({orderId:digest}).strict().parse(input);result=await client.order(r.orderId);break;}
      case 'workflow-submit':{const r=WorkflowSubmitRequestSchema.safeExtend({confirm:z.literal(true)}).parse(input);result=await client.submitWorkflow(r);break;}
      case 'workflow-output':{const r=z.object({jobId:WorkflowIdSchema}).strict().parse(input);result=await client.workflowOutput(r.jobId);break;}
      case 'workflow-cancel':{const r=z.object({jobId:WorkflowIdSchema,confirm:z.literal(true)}).strict().parse(input);result=await client.cancelWorkflow(r.jobId,r.confirm);break;}
      case 'check-workflow':{
        const r=LocalSdkWorkflowRequestSchema.parse(input),before=await client.session();
        if(expectedSubject&&before.subject!==expectedSubject)throw Error('AUTHORIZATION_SESSION_CHANGED');
        const output=await client.workflowOutput(r.jobId),confirmed=z.object({status:z.literal('CONFIRMED'),orderId:digest,payoutHash:digest}).strict().parse(output.outputs.procurement);
        if(output.status!=='SUCCEEDED'||confirmed.orderId.toLowerCase()!==r.orderId.toLowerCase())throw Error('WORKFLOW_RESPONSE_MISMATCH');
        const order=await client.order(r.orderId),after=await client.session(),wallets=(w:readonly string[])=>[...new Set(w.map(a=>a.toLowerCase()))].sort().join(',');
        if(before.subject!==after.subject||wallets(before.wallets)!==wallets(after.wallets))throw Error('AUTHORIZATION_SESSION_CHANGED');
        result=LocalSdkWorkflowResultSchema.parse({schemaVersion:1,status:'AUTHENTICATED_WORKFLOW_ORDER_READ',scope:'INDEPENDENT_NODE_SDK_COMPLETED_WORKFLOW_AND_CHAIN_READ_NOT_NEW_PURCHASE_ACCEPTANCE',jobId:r.jobId,workflowStatus:output.status,recordedPayoutHash:confirmed.payoutHash,walletAddresses:after.wallets,order,sessionVerifiedBeforeAfter:true,canExecute:false,signaturesRequested:0,transactionsSent:0});break;
      }
      case 'check-order':{
        const r=LocalSdkReadRequestSchema.parse(input),before=await client.session(),order=await client.order(r.orderId),after=await client.session();
        const wallets=(values:readonly string[])=>[...new Set(values.map(w=>w.toLowerCase()))].sort().join(',');
        if(expectedSubject&&before.subject!==expectedSubject||before.subject!==after.subject||wallets(before.wallets)!==wallets(after.wallets))throw Error('AUTHORIZATION_SESSION_CHANGED');
        result=LocalSdkReadResultSchema.parse({schemaVersion:1,status:'AUTHENTICATED_ORDER_READ',scope:'INDEPENDENT_NODE_SDK_SESSION_AND_ORDER_READ_NOT_FULL_PURCHASE_ACCEPTANCE',walletAddresses:after.wallets,order,sessionVerifiedBeforeAfter:true,canExecute:false,signaturesRequested:0,transactionsSent:0});break;
      }
      case 'prepare-allocation':result=await client.prepareAllocation(AllocationRequestSchema.parse(input));break;
      case 'query-allocation':result=await client.queryAllocation(AllocationRequestSchema.parse(input));break;
      case 'reconcile-allocation':result=await client.reconcileAllocation(AllocationAttemptReconcileRequestSchema.parse(input));break;
      case 'trigger-allocation':result=await client.triggerAllocation(AllocationTriggerRequestSchema.parse(input));break;
    }}
    const value=result as Record<string,any>;if(['catalog','propose','review','prepare','finalize'].includes(mode)&&!flags.includes('--print-payload')){
      if(mode==='catalog')io.out({quotes:value.entries.map((e:any)=>({quoteId:e.quote.quoteId,seller:e.quote.seller,payee:e.quote.payee,asset:e.quote.asset,amount:e.quote.amount})),privateOutput:false});
      else if(mode==='propose')io.out({status:value.status,...(value.intent?{orderId:value.intent.orderId}:{}),...(value.code?{code:value.code}:{}),privateOutput:false});
      else if(mode==='review')io.out({decision:value.decision,source:value.source,executable:value.executable??false,...(value.receipt?{contextHash:value.receipt.contextHash}:{}),privateOutput:false});
      else io.out({orderId:value.payload.intent.orderId,contextHash:value.payload.grant.contextHash,nonce:value.payload.grant.nonce,chainStatusChecked:false,canSubmitPayment:false,...(mode==='prepare'?{typedData:value.typedData}:{}),privateOutput:false});
    }else if(mode==='workflow-output'&&!flags.includes('--print-payload'))io.out({id:value.id,status:value.status,completedSteps:Object.keys(value.outputs),privateOutput:false});else io.out(result);
    return ['REJECT','ABSTAIN','FAILED','ATTENTION','RECONCILING'].includes(value.status)||['FAILED','ATTENTION','RECONCILING'].includes(value.jobStatus)||mode==='review'&&(value.decision!=='PASS'||value.executable!==true)||mode==='preflight'&&value.blockers?.length>0||value.error||['UNKNOWN','BLOCKED','REVERTED'].includes(value.record?.status)||value.receipt?.status==='REVERTED'?1:0;
  }catch(error){const message=error instanceof Error?error.message:'';const code=['EXAMPLE_USAGE_INVALID','EXAMPLE_CONFIRMATION_REQUIRED','LOGIN_REQUIRED','EXAMPLE_SERVICE_UNAVAILABLE','EXAMPLE_RESPONSE_TOO_LARGE','PURCHASE_ENDPOINT_INVALID','AUTHORIZATION_CONFIGURATION_REQUIRED','AUTHORIZATION_SESSION_CHANGED','EXECUTABLE_PASS_REQUIRED','AUTHORIZATION_EXPIRED'].includes(message)?message:'EXAMPLE_OPERATION_UNAVAILABLE';io.error(code);return 1;}
}
