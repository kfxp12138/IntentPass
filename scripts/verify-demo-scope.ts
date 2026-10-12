import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {configuredAssetMode} from '../packages/protocol/src/asset-mode.js';
import {integrationStatus} from '../packages/adapters/src/status.js';
import {captureReleaseSource,sameReleaseSource} from './release-source.js';
import {demoChainFlowObservation,readDemoChainFlowObservation,type DemoFlowObservation} from './demo-chain-flow-observation.js';
import {commandExit} from './verification-outcome.js';
const startedAt=new Date().toISOString();
if(existsSync('.env'))loadEnvFile('.env');
if(configuredAssetMode(process.env)!=='demo-erc20'){console.error('DEMO_PROFILE_REQUIRED');process.exit(1);}
const day=Number(process.argv[2]??4);if(!Number.isInteger(day)||day<1||day>7){console.error('ARGUMENT_INVALID');process.exit(1);}
const counts=[0,7,7,8,6,7,7,7],changes:Record<string,string>={
  'D1-06':'Official identity and custody qualification removed by owner. Actual demo asset/gate/escrow creation proofs are required separately.',
  'D4-01':'Actual Monad test ERC20 funding, two-member certification, settlement and beneficiary withdrawal with original receipts and ledgers are required.',
  'D4-02':'Original signed orders with wrong asset, buyer or context must be rejected on the actual deployed contract without funds or nonce changes; no identity claim.',
  'D4-03':'Actual direct-call signature, receipt and executor rejections are required.',
  'D4-04':'Actual Privy allowed execution and independent chain-simulation-success/provider-policy-denial pair are required.',
  'D4-05':'Actual insufficient balance/allowance, invalid settlement or failed withdrawal must preserve original ledger and allow only an explicit valid continuation.',
  'D4-06':'Actual authenticated browser and original public transaction status walkthrough are required.',
  'D7-03':'Actual pitch content and duration within 120 seconds are required; Cleanverse video removed by owner.',
  'D7-07':'Current product/Monad/Privy/Mera/JEV release checks must derive from actual evidence; no Cleanverse bounty claim.'
};
const items=Array.from({length:counts[day]!},(_,index)=>{const id=`D${day}-${String(index+1).padStart(2,'0')}`;return {id,status:id==='D1-06'?'REMOVED_BY_OWNER_SCOPE_CHANGE':id==='D3-07'?'EXCLUDED_BY_APPROVED_PACT_INSPIRED_ROUTE':'BLOCKED',reason:changes[id]??'Current-scope real or deterministic evidence has not yet been validated by this new readiness entry. No prior-release PASS is inherited.'};});
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),directory='artifacts/acceptance/demo-scope';mkdirSync(directory,{recursive:true});
let readOnlyChainFlow:Record<string,unknown>|null=null;
if(day===4){
  const invocationId=randomUUID(),childStartedAt=new Date().toISOString(),log=`${directory}/${invocationId}-chain-flow.log`;
  let observation:DemoFlowObservation={status:'FAIL',publicRpcInspectionAttempted:false,canPassD4:false};
  let binding:ReturnType<typeof readDemoChainFlowObservation>['binding']|null=null,exitCode:number|null=null,childEndedAt:string;
  try{
    const source=captureReleaseSource(),run=spawnSync(process.execPath,['--import','tsx','scripts/inspect-demo-chain-flow.ts','--invocation',invocationId],{encoding:'utf8',timeout:180000,maxBuffer:2_000_000});
    childEndedAt=new Date().toISOString();exitCode=commandExit(run);
    writeFileSync(log,(run.stdout??'')+(run.stderr??'')+(run.error?'\nDEMO_INSPECTION_COMMAND_ERROR':''),{flag:'wx'});
    if(!run.error&&!run.signal&&sameReleaseSource(source,captureReleaseSource())){
      const read=readDemoChainFlowObservation(process.cwd(),invocationId);binding=read.binding;
      observation=demoChainFlowObservation(read.record,{invocationId,startedAt:childStartedAt,endedAt:childEndedAt,source,exitCode});
    }
  }catch{/* Keep FAIL; never load a historical or caller-chosen proof. */}
  childEndedAt??=new Date().toISOString();
  readOnlyChainFlow={...observation,invocationId,startedAt:childStartedAt,endedAt:childEndedAt,exitCode,evidence:binding,log};
  if(observation.status==='FAIL'){items[0]!.status='FAIL';items[0]!.reason='This invocation\'s demo chain-flow diagnostic failed source, input or proof validation; no old report is accepted.';}
  else if(observation.status==='CHAIN_FLOW_VERIFIED')items[0]!.reason='Original configured test ERC20 funding, settlement and payee withdrawal effects verified. Original creation/provider associations, two certification transactions and remaining D4 requirements are still required.';
}
const status=readOnlyChainFlow?.status==='FAIL'?'FAIL':'BLOCKED';
const report={schemaVersion:2,startedAt,endedAt:new Date().toISOString(),scope:'CURRENT_DEMO_SCOPE_READINESS_AND_BOUND_CHAIN_DIAGNOSTICS_NOT_FINAL_ACCEPTANCE',stage:`D${day}`,assetMode:'demo-erc20',route:'context-vote-escrow / PACT-inspired',sourceCommit:revision.status===0?revision.stdout.trim():null,status,items,readOnlyChainFlow,configuration:integrationStatus(),removedRequirements:['Official CVI/CVA/validator/policy/pool registration','Cleanverse-specific video and bounty'],limits:['Only D4 consumes a new current-invocation configured ERC20 effects diagnostic; creation/provider/certification/media proof gates remain pending.','It cannot issue PASS from configuration, local mocks or historical reports.','Other seven-day requirements remain required under implementation-scope-v2.md.'],providerCallsAdded:0,signaturesRequested:0,transactionsSent:0};
const path=`${directory}/${Date.now()}-${randomUUID()}-day${day}.json`;writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,scope:report.scope,stage:report.stage,items,evidence:path}));process.exitCode=1;
