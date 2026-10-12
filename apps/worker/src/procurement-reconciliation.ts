import {resolve} from 'node:path';
import {readdirSync,existsSync} from 'node:fs';
import {createPublicClient,type Address} from 'viem';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {readPrivateServiceJson} from '../../../scripts/create-privy-service-wallets.js';
import {BackgroundVault} from '../../../packages/storage/src/background-vault.js';
import {ExecutionScopeSchema} from '../../../packages/automation/src/background-scope.js';
import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import {configuredBrowserApi} from '../../web/src/browser-api.js';
import {configuredWithdrawalApi} from '../../web/src/configured-withdrawal-api.js';
import {checkWithdrawalReceipt} from '../../../packages/protocol/src/withdrawal.js';
import type {WorkflowResult} from './workflow-worker.js';
import {pacedHttp} from '../../../packages/adapters/src/paced-rpc.js';
import {PurchasePreflightReader} from '../../../packages/protocol/src/purchase-preflight.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {address} from '../../../packages/protocol/src/schemas.js';
import {checkExpiredUnfunded,inspectExpiredUnfunded} from './expired-procurement.js';
/** Original-order GET/RPC-only recovery. Never starts procurement, signs, renews,
 * approves, submits, delivers, votes or withdraws again. */
export async function reconcileProcurement(directory:string,environment:NodeJS.ProcessEnv=process.env,clock=Date.now):Promise<WorkflowResult>{
  let vault:BackgroundVault|undefined,api:ReturnType<typeof configuredWithdrawalApi>;
  try{
    const reference=z.object({scopeHash:z.string().regex(/^[a-f0-9]{64}$/),sellerSubject:z.string().min(1).max(512)}).strict().parse(readPrivateServiceJson(resolve(directory,'job-reference.json')));
    const path=resolve(directory,'vault'),files=readdirSync(path).filter(name=>/^authorization-[a-f0-9]{64}\.json$/.test(name));if(files.length!==1)return {status:'UNKNOWN',nextAt:clock()+15000};
    vault=new BackgroundVault(path);
    const {scope}=z.object({scope:ExecutionScopeSchema}).strict().parse(vault.open('checkpoint',createHash('sha256').update(`${reference.scopeHash}:runtime-scope`).digest('hex'),reference.scopeHash));
    const original=z.object({payload:AuthorizationPayloadSchema,dataset:z.array(z.number())}).strict().parse(vault.open('authorization',files[0].slice('authorization-'.length,-'.json'.length),reference.scopeHash));
    const browser=configuredBrowserApi(environment);if(!browser||JSON.stringify(browser.configuration.recoveryDeployment)!==JSON.stringify(scope.deployment))return {status:'UNKNOWN',nextAt:clock()+15000};
    api=configuredWithdrawalApi(environment,browser);if(!api)return {status:'UNKNOWN',nextAt:clock()+15000};
    const request={payload:original.payload,beneficiary:original.payload.intent.payee},record=api.store.get(reference.sellerSubject,request);
    if(!record?.hash){
      if(!environment.MONAD_RPC_URL||!environment.ELIGIBILITY_GATE_ADDRESS)return {status:'UNKNOWN',nextAt:clock()+15000};
      if(original.payload.policy.taskId.toLowerCase()!==scope.taskId.toLowerCase()||original.payload.intent.datasetHash.toLowerCase()!==scope.datasetHash.toLowerCase()||original.payload.intent.buyer.toLowerCase()!==scope.buyer.toLowerCase()||original.payload.intent.seller.toLowerCase()!==scope.seller.toLowerCase())throw Error('EXPIRY_JOB_CONTEXT_MISMATCH');
      const d=scope.deployment,reader=new PurchasePreflightReader(createPublicClient({transport:pacedHttp(environment.MONAD_RPC_URL,{timeout:20000})}),{chainId:d.chainId,arbiter:d.arbiter as Address,asset:d.asset as Address,gate:address.parse(environment.ELIGIBILITY_GATE_ADDRESS) as Address,reviewer:d.reviewer as Address,committeeHash:committeeHash(d.committee)},d.executor);
      const observation=await inspectExpiredUnfunded(original.payload,d,input=>reader.read(input));
      if(!observation)return {status:'UNKNOWN',nextAt:clock()+15000};
      const id=createHash('sha256').update(`${reference.scopeHash}:trace:expired-unfunded`).digest('hex');
      if(existsSync(resolve(path,`checkpoint-${id}.json`))){if(!checkExpiredUnfunded(original.payload,vault.open('checkpoint',id,reference.scopeHash)))throw Error('EXPIRY_PROOF_INVALID');}
      else vault.save('checkpoint',id,reference.scopeHash,observation);
      // Append a failed job outcome. Its UNKNOWN funding attempt, signatures,
      // nonce and dispatch remain immutable and are never made retryable.
      return {status:'FAILED'};
    }
    const receipt=checkWithdrawalReceipt({...request,hash:record.hash},await api.receipt({...request,hash:record.hash},[request.beneficiary]));
    if(receipt.status==='REVERTED')return {status:'FAILED'};
    if(receipt.status!=='CONFIRMED'||receipt.order.state!=='ALLOCATED_PAID'||receipt.transferredAmount!==original.payload.intent.price)return {status:'UNKNOWN',nextAt:clock()+15000};
    return {status:'COMPLETE',output:{status:'CONFIRMED',orderId:original.payload.intent.orderId,payoutHash:receipt.hash}};
  }catch{return {status:'UNKNOWN',nextAt:clock()+15000};}finally{api?.store.close();vault?.dispose();}
}
