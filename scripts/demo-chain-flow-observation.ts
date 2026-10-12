import {z} from 'zod';
import {createHash} from 'node:crypto';
import {constants,lstatSync,realpathSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {digest} from '../packages/protocol/src/schemas.js';
import {allocatedAmount} from '../packages/protocol/src/withdrawal.js';
import {Day4ChainFlowDeploymentSchema,Day4ChainFlowProofSchema} from '../packages/protocol/src/day4-chain-flow-types.js';
import {sameReleaseSource,type ReleaseSourceSnapshot} from './release-source.js';
import {strictJsonParse} from './strict-json.js';

export const demoFlowConfigurationNames=['CHAIN_ID','ARBITER_ADDRESS','ASSET_ADDRESS','ELIGIBILITY_GATE_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','PRIVY_EXECUTOR_ADDRESS','MONAD_RPC_URL','D4_CHAIN_FLOW_PATH'] as const;
const identity=z.object({orderId:digest,contextHash:digest,transactions:z.object({funding:digest,allocation:digest,withdrawal:digest}).strict()}).strict();
/** A new envelope for configured ERC20 effects; it never promotes a legacy report. */
export const DemoChainFlowReportSchema=z.object({
  schemaVersion:z.literal(2),invocationId:z.string().uuid(),assetMode:z.literal('demo-erc20'),scope:z.literal('READ_ONLY_DEMO_ORIGINAL_CHAIN_FLOW_NOT_FULL_D4_ACCEPTANCE'),
  startedAt:z.iso.datetime(),endedAt:z.iso.datetime(),source:z.unknown(),sourceStable:z.boolean(),worktreeDirty:z.boolean(),
  status:z.enum(['CHAIN_FLOW_VERIFIED','BLOCKED','FAIL']),reason:z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  missing:z.array(z.enum(demoFlowConfigurationNames)),deployment:Day4ChainFlowDeploymentSchema.nullable(),requestIdentity:identity.nullable(),inspection:Day4ChainFlowProofSchema.nullable(),
  publicRpcInspectionAttempted:z.boolean(),privateInputReadAttempted:z.boolean(),exitCode:z.union([z.literal(0),z.literal(1)]),
  financialAcceptanceStatus:z.literal('BLOCKED'),canPassD4:z.literal(false),canExecute:z.literal(false),identityVerification:z.literal(false),
  officialIntegrationVerified:z.literal(false),privyOriginVerified:z.literal(false),deploymentCreationVerified:z.literal(false),
  signaturesRequested:z.literal(0),transactionsSent:z.literal(0),limits:z.array(z.string()).min(1)
}).strict().superRefine((v,c)=>{
  const bad=()=>c.addIssue({code:'custom',message:'DEMO_CHAIN_FLOW_REPORT_INVALID'}),eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(Date.parse(v.endedAt)<Date.parse(v.startedAt))bad();
  if(v.status==='CHAIN_FLOW_VERIFIED'){
    const p=v.inspection,d=v.deployment,r=v.requestIdentity;
    if(!p||!d||!r||v.exitCode!==0||!v.sourceStable||!v.publicRpcInspectionAttempted||!v.privateInputReadAttempted||v.missing.length){bad();return;}
    if(!eq(p.asset,d.asset)||!eq(p.arbiter,d.arbiter)||!eq(p.orderId,r.orderId)||!eq(p.contextHash,r.contextHash)
      ||!eq(p.transactions.funding.from,d.executor)||!eq(p.transactions.allocation.from,d.executor)
      ||(['funding','allocation','withdrawal'] as const).some(step=>!eq(p.transactions[step].hash,r.transactions[step])))bad();
    const o=p.finalOrder,sameActor=eq(o.buyer,o.payee);
    let remaining=0n;
    if(BigInt(o.price)<=0n||o.credits.payee!=='0'||o.withdrawn.payee!==p.transactions.withdrawal.amount
      ||((o.voteMask&1)>0?1:0)+((o.voteMask&2)>0?1:0)+((o.voteMask&4)>0?1:0)<2)bad();
    if(sameActor&&(o.credits.buyer!==o.credits.payee||o.withdrawn.buyer!==o.withdrawn.payee))bad();
    for(const slot of ['buyer','payee'] as const){
      if(slot==='payee'&&sameActor)continue;
      const total=allocatedAmount(o,o[slot]),credit=BigInt(o.credits[slot]),withdrawn=BigInt(o.withdrawn[slot]);
      if(credit+withdrawn!==total||withdrawn!==0n&&withdrawn!==total)bad();remaining+=credit;
    }
    if(remaining>BigInt(o.accounting.outstanding)||BigInt(o.accounting.balance)<BigInt(o.accounting.locked)+BigInt(o.accounting.outstanding))bad();
  }else if(v.exitCode!==1||v.inspection!==null)bad();
  if(v.status==='BLOCKED'&&!['DEMO_CHAIN_FLOW_CONFIGURATION_MISSING','DEMO_CHAIN_FLOW_READ_UNAVAILABLE','DAY4_FLOW_READ_UNAVAILABLE','DAY4_FLOW_TRANSACTION_PENDING'].includes(v.reason))bad();
  if(v.reason==='DEMO_CHAIN_FLOW_CONFIGURATION_MISSING'&&(!v.missing.length||v.publicRpcInspectionAttempted||v.privateInputReadAttempted||v.deployment!==null||v.requestIdentity!==null))bad();
});
export type DemoChainFlowReport=z.infer<typeof DemoChainFlowReportSchema>;
export type DemoFlowObservation={status:'CHAIN_FLOW_VERIFIED'|'BLOCKED'|'FAIL';publicRpcInspectionAttempted:boolean;canPassD4:false};
/** The parent chooses this run's UUID, never a provider or report-supplied path. */
export function readDemoChainFlowObservation(root:string,id:string){
  const invocationId=z.string().uuid().parse(id),path=`artifacts/acceptance/demo-chain-flow/${invocationId}.json`,base=resolve(root),absolute=resolve(base,path);
  if(realpathSync(base)!==base||realpathSync(absolute)!==absolute)throw Error('DEMO_CHAIN_FLOW_EVIDENCE_INVALID');
  const before=lstatSync(absolute);
  if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>1_048_576)throw Error('DEMO_CHAIN_FLOW_EVIDENCE_INVALID');
  const same=(s:NonNullable<ReturnType<typeof lstatSync>>)=>s.isFile()&&s.ino===before.ino&&s.dev===before.dev&&s.size===before.size&&s.mtimeMs===before.mtimeMs;
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(before.size);
  try{
    if(!same(fstatSync(fd)))throw Error('DEMO_CHAIN_FLOW_EVIDENCE_CHANGED');
    let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;}
    if(offset!==before.size||!same(fstatSync(fd))||!same(lstatSync(absolute))||realpathSync(absolute)!==absolute)throw Error('DEMO_CHAIN_FLOW_EVIDENCE_CHANGED');
  }finally{closeSync(fd);}
  const record=strictJsonParse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  return {record,binding:{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
}
/** Only an exact current invocation, matching actual source bytes, is consumed. */
export function demoChainFlowObservation(input:unknown,expected:{invocationId:string;startedAt:string;endedAt:string;source:ReleaseSourceSnapshot;exitCode:number|null}):DemoFlowObservation{
  const invalid:DemoFlowObservation={status:'FAIL',publicRpcInspectionAttempted:false,canPassD4:false};
  try{
    const o=DemoChainFlowReportSchema.parse(input),start=Date.parse(expected.startedAt),end=Date.parse(expected.endedAt);
    if(o.invocationId!==expected.invocationId||!Number.isFinite(start)||!Number.isFinite(end)||end<start||Date.parse(o.startedAt)<start||Date.parse(o.endedAt)>end
      ||o.exitCode!==expected.exitCode||!o.sourceStable||!sameReleaseSource(o.source,expected.source))return invalid;
    return {status:o.status,publicRpcInspectionAttempted:o.publicRpcInspectionAttempted,canPassD4:false};
  }catch{return invalid;}
}
