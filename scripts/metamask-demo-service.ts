import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getContractAddress,type Address,type Hex} from 'viem';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {demoDependencyPlan,inspectDemoDependency,verifyDemoDependencyCreation,type DemoDependencyReadPort} from './demo-dependency.js';
import {validateMetaMaskPreflight,type MetaMaskStatus,type MetaMaskPreflight} from './metamask-types.js';
import {MetaMaskPreflightRejected} from './metamask-preflight-rejection.js';
const hex=(value:bigint)=>`0x${value.toString(16)}` as Hex;
/** Fixed test dependency creation only. No key, signer or broadcast exists here. */
export class MetaMaskDemoDependencyService{
  readonly plan;private checks=new Map<string,MetaMaskPreflight>();
  constructor(private options:{dependency:'ASSET'|'GATE';config:unknown;artifact:unknown;assetArtifact?:unknown;sourceCommit:string;sourceClean:()=>boolean;store:DeploymentAttemptStore;port:DemoDependencyReadPort;clock?:()=>number}){this.plan=demoDependencyPlan(options.dependency,options.config,options.artifact,options.sourceCommit);}
  private clean(){if(!this.options.sourceClean())throw Error('SOURCE_REVISION_CHANGED');}
  private now(){return (this.options.clock??Date.now)();}
  status():MetaMaskStatus{const attempt=this.options.store.get(this.plan.planId),clean=this.options.sourceClean();return {scope:'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF',ready:clean&&!attempt,blockers:[...(!clean?['SOURCE_REVISION_CHANGED']:[]),...(attempt?['DEPLOYMENT_ATTEMPT_ALREADY_RESERVED']:[])],plan:this.plan,attempt,officialIntegrationVerified:false,transactionsSentByServer:0};}
  async preflight(){
    this.clean();if(this.options.store.get(this.plan.planId))throw Error('DEPLOYMENT_ATTEMPT_ALREADY_RESERVED');
    const p=this.options.port,account=this.plan.deployer as Address;
    if(await p.chainId()!==10143)throw Error('DEPLOYMENT_CHAIN_MISMATCH');
    const block=await p.block();if(block.number===null||block.hash===null)throw Error('DEPLOYMENT_FINALIZED_BLOCK_UNAVAILABLE');
    const [nonce,latest,balance,fees,accountCode]=await Promise.all([p.nonce(account,'pending'),p.nonce(account,'latest'),p.balance(account),p.fees(),p.code(account,block.number)]);
    if(accountCode&&accountCode!=='0x')throw Error('DEPLOYMENT_CONTRACT_ACCOUNT_UNSUPPORTED');
    if(nonce!==latest||nonce<0n||nonce>BigInt(Number.MAX_SAFE_INTEGER))throw Error('DEPLOYMENT_NONCE_UNAVAILABLE_OR_PENDING');
    const predicted=getContractAddress({from:account,nonce});if([account,this.plan.asset,this.plan.recipient].some(value=>value?.toLowerCase()===predicted.toLowerCase()))throw Error('DEPLOYMENT_FUTURE_ADDRESS_ROLE_CONFLICT');
    if(this.plan.dependency==='GATE'){
      if(!this.options.assetArtifact||!this.plan.asset)throw Error('DEPLOYMENT_DEMO_ASSET_ARTIFACT_REQUIRED');
      const tokenPlan=demoDependencyPlan('ASSET',{chainId:'10143',deployer:account},this.options.assetArtifact,this.plan.sourceCommit);
      await inspectDemoDependency(tokenPlan,this.options.assetArtifact,this.plan.asset as Address,block.number,p);
    }
    const estimated=await p.estimate({account,data:this.plan.data as Hex,value:0n,nonce:Number(nonce),...fees}),gas=estimated+(estimated+4n)/5n;
    if(estimated<=0n||gas>30_000_000n||fees.maxFeePerGas<=0n||fees.maxPriorityFeePerGas<0n||fees.maxPriorityFeePerGas>fees.maxFeePerGas)throw Error('DEPLOYMENT_GAS_OR_FEES_INVALID');
    const [finalPending,finalLatest,finalBalance]=await Promise.all([p.nonce(account,'pending'),p.nonce(account,'latest'),p.balance(account)]);
    if(finalPending!==nonce||finalLatest!==nonce)throw Error('DEPLOYMENT_PREFLIGHT_CHANGED');
    if(finalBalance<gas*fees.maxFeePerGas)throw Error('DEPLOYMENT_BALANCE_REQUIRED');
    const again=await p.block(block.number);if(again.number!==block.number||again.hash!==block.hash||await p.chainId()!==10143)throw Error('DEPLOYMENT_SNAPSHOT_CHANGED');this.clean();
    if(balance<0n)throw Error('DEPLOYMENT_BALANCE_REQUIRED');
    const check=validateMetaMaskPreflight(this.plan,{planId:this.plan.planId,checkId:randomUUID(),checkedAt:new Date(this.now()).toISOString(),predictedAddress:predicted,balance:String(finalBalance),estimatedMaxCost:String(gas*fees.maxFeePerGas),transaction:{from:account,chainId:'0x279f',data:this.plan.data,value:'0x0',nonce:hex(nonce),gas:hex(gas),maxFeePerGas:hex(fees.maxFeePerGas),maxPriorityFeePerGas:hex(fees.maxPriorityFeePerGas)}});
    this.checks.clear();this.checks.set(check.checkId,check);return check;
  }
  async reserve(input:unknown){
    const r=z.object({planId:z.literal(this.plan.planId),checkId:z.string().uuid()}).strict().parse(input),old=this.checks.get(r.checkId);this.checks.delete(r.checkId);
    if(!old||this.now()-Date.parse(old.checkedAt)>60_000||this.now()<Date.parse(old.checkedAt))throw new MetaMaskPreflightRejected('DEPLOYMENT_PREFLIGHT_EXPIRED');
    const fresh=await this.preflight().catch(error=>{if(error instanceof Error&&error.message==='DEPLOYMENT_PREFLIGHT_CHANGED')throw new MetaMaskPreflightRejected('DEPLOYMENT_PREFLIGHT_CHANGED');throw error;});
    this.checks.clear();if(JSON.stringify(fresh.transaction)!==JSON.stringify(old.transaction)||fresh.predictedAddress.toLowerCase()!==old.predictedAddress.toLowerCase())throw new MetaMaskPreflightRejected('DEPLOYMENT_PREFLIGHT_CHANGED');
    this.clean();const tx=fresh.transaction,attempt=this.options.store.reserve({planId:this.plan.planId,sourceCommit:this.plan.sourceCommit,chainId:'10143',deployer:this.plan.deployer,initCodeHash:this.plan.initCodeHash,nonce:tx.nonce,gas:tx.gas,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas});
    return {attempt,preflight:{...fresh,checkId:old.checkId}};
  }
  recordHash(input:unknown){const r=z.object({planId:z.literal(this.plan.planId),attemptId:z.string().uuid(),transactionHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict().parse(input);return this.options.store.recordHash(r.planId,r.attemptId,r.transactionHash);}
  async reconcile(){
    const old=this.options.store.get(this.plan.planId);if(!old?.transactionHash)return {attempt:old,proof:null};
    const p=this.options.port,checkedPort:DemoDependencyReadPort={chainId:p.chainId.bind(p),block:p.block.bind(p),code:p.code.bind(p),nonce:p.nonce.bind(p),balance:p.balance.bind(p),fees:p.fees.bind(p),estimate:p.estimate.bind(p),token:p.token.bind(p),gate:p.gate.bind(p),receipt:p.receipt.bind(p),transaction:async hash=>{
      const tx=await p.transaction(hash);if(!tx)return null;
      if(!Number.isSafeInteger(tx.nonce)||tx.nonce<0||BigInt(tx.nonce)!==BigInt(old.nonce)||tx.gas<=0n||tx.gas>BigInt(old.gas)||tx.maxFeePerGas==null||tx.maxPriorityFeePerGas==null||tx.maxFeePerGas<=0n||tx.maxPriorityFeePerGas<0n||tx.maxPriorityFeePerGas>tx.maxFeePerGas||tx.maxFeePerGas>BigInt(old.maxFeePerGas)||tx.maxPriorityFeePerGas>BigInt(old.maxPriorityFeePerGas))throw Error('DEPLOYMENT_RESERVED_TRANSACTION_MISMATCH');return tx;
    }};
    const proof=await verifyDemoDependencyCreation(this.plan,this.options.artifact,old.transactionHash as Hex,checkedPort);
    if(old.status==='CONFIRMED'&&proof.status!=='CONFIRMED'||old.status==='REVERTED'&&proof.status!=='REVERTED')throw Error('DEPLOYMENT_TERMINAL_OBSERVATION_CONFLICT');
    const attempt=proof.status==='CONFIRMED'?this.options.store.markConfirmed(old.planId,old.attemptId,old.transactionHash,proof.contractAddress as Address):proof.status==='REVERTED'?this.options.store.markReverted(old.planId,old.attemptId,old.transactionHash):old;
    return {attempt,proof};
  }
}
