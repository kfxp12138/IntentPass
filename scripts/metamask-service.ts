import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getContractAddress,type Address,type Hex} from 'viem';
import {DeploymentConfigSchema,inspectDeployment,type DeploymentReadPort} from '../packages/protocol/src/deployment.js';
import {verifyDeploymentCreation,verifyDeploymentRuntime,type DeploymentProofPort} from '../packages/protocol/src/deployment-proof.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {metamaskPlan,validateMetaMaskPreflight,type MetaMaskStatus,type MetaMaskPreflight} from './metamask-types.js';
import type {AssetMode} from '../packages/protocol/src/asset-mode.js';
import {MetaMaskPreflightRejected} from './metamask-preflight-rejection.js';
const hex=(v:bigint)=>`0x${v.toString(16)}` as Hex;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export interface MetaMaskReadPort extends DeploymentReadPort{
  nonce(address:Address,tag:'pending'|'latest'):Promise<bigint>;
  currentBalance(address:Address):Promise<bigint>;
  estimate(transaction:{account:Address;data:Hex;value:bigint;nonce:number;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}):Promise<bigint>;
  fees():Promise<{maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}>;
  gate(address:Address,block:bigint):Promise<{asset:Address;validator:Address;policy:Address;pool:Address;assetPolicy:Address}>;
  demoGate?(address:Address,block:bigint):Promise<{asset:Address}>;
  proof:DeploymentProofPort;
}
/** Operator-only creation; this service never holds a wallet key or broadcasts. */
export class MetaMaskDeploymentService{
  readonly plan;private checks=new Map<string,MetaMaskPreflight>();
  constructor(private options:{config:unknown;artifact:unknown;gateArtifact:unknown;assetMode?:AssetMode;sourceCommit:string;sourceClean:()=>boolean;store:DeploymentAttemptStore;port:MetaMaskReadPort;clock?:()=>number}){
    this.plan=metamaskPlan(options.config,options.artifact,options.sourceCommit);
  }
  status():MetaMaskStatus{
    const attempt=this.options.store.get(this.plan.planId),clean=this.options.sourceClean();
    return {scope:'LOCAL_OPERATOR_METAMASK_DEPLOYMENT_HANDOFF',ready:clean&&!attempt,blockers:[...(!clean?['SOURCE_REVISION_CHANGED']:[]),...(attempt?['DEPLOYMENT_ATTEMPT_ALREADY_RESERVED']:[])],plan:this.plan,attempt,officialIntegrationVerified:false,transactionsSentByServer:0};
  }
  private clean(){if(!this.options.sourceClean())throw new Error('SOURCE_REVISION_CHANGED');}
  private now(){return (this.options.clock??Date.now)();}
  async preflight(){
    this.clean();if(this.options.store.get(this.plan.planId))throw new Error('DEPLOYMENT_ATTEMPT_ALREADY_RESERVED');
    const config=DeploymentConfigSchema.parse(this.options.config),p=this.options.port;
    const inspection=await inspectDeployment(config,p);if(inspection.status!=='INSPECTED')throw new Error('DEPLOYMENT_BALANCE_REQUIRED');
    const [pending,latest,fees,currentBalance]=await Promise.all([p.nonce(config.deployer as Address,'pending'),p.nonce(config.deployer as Address,'latest'),p.fees(),p.currentBalance(config.deployer as Address)]);
    if(pending!==latest||pending<0n||pending>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('DEPLOYMENT_NONCE_UNAVAILABLE_OR_PENDING');
    const predicted=getContractAddress({from:config.deployer as Address,nonce:pending}),block=BigInt(inspection.block.number);
    if([config.deployer,config.asset,config.gate,config.reviewer,...config.committee].some(v=>eq(v,predicted)))throw new Error('DEPLOYMENT_FUTURE_ADDRESS_ROLE_CONFLICT');
    if(this.options.assetMode==='demo-erc20'){
      if(!p.demoGate)throw Error('DEPLOYMENT_FIXED_ASSET_READER_REQUIRED');
      const witness=await p.demoGate(config.gate as Address,block),gateCode=await p.code(config.gate as Address,block);
      if(!eq(witness.asset,config.asset)||!gateCode||gateCode==='0x')throw Error('DEPLOYMENT_FIXED_ASSET_GATE_MISMATCH');
      verifyDeploymentRuntime(this.options.gateArtifact,gateCode,[config.asset]);
    }else{
    const witness=await p.gate(config.gate as Address,block);
    if(!eq(witness.asset,config.asset)||!eq(witness.pool,predicted)||!eq(witness.assetPolicy,witness.policy))throw new Error('DEPLOYMENT_GATE_POOL_OR_ASSET_MISMATCH');
    const [gateCode,validatorCode,policyCode]=await Promise.all([p.code(config.gate as Address,block),p.code(witness.validator,block),p.code(witness.policy,block)]);
    if(!gateCode||gateCode==='0x'||!validatorCode||validatorCode==='0x'||!policyCode||policyCode==='0x')throw new Error('DEPLOYMENT_GATE_DEPENDENCY_MISSING');
    verifyDeploymentRuntime(this.options.gateArtifact,gateCode,[witness.asset,witness.validator,witness.policy,witness.pool]);
    }
    const gasEstimate=await p.estimate({account:config.deployer as Address,data:this.plan.data as Hex,value:0n,nonce:Number(pending),...fees}),gas=gasEstimate+(gasEstimate+4n)/5n;
    if(gasEstimate<=0n||gas>30_000_000n||fees.maxFeePerGas<=0n||fees.maxPriorityFeePerGas<0n||fees.maxPriorityFeePerGas>fees.maxFeePerGas)throw new Error('DEPLOYMENT_GAS_OR_FEES_INVALID');
    const [finalPending,finalLatest,finalBalance]=await Promise.all([p.nonce(config.deployer as Address,'pending'),p.nonce(config.deployer as Address,'latest'),p.currentBalance(config.deployer as Address)]);
    if(finalPending!==pending||finalLatest!==pending)throw Error('DEPLOYMENT_PREFLIGHT_CHANGED');
    if(finalBalance<gas*fees.maxFeePerGas)throw Error('DEPLOYMENT_BALANCE_REQUIRED');
    if(String(await p.chainId())!=='10143'||(await p.block(block)).hash!==inspection.block.hash)throw new Error('DEPLOYMENT_SNAPSHOT_CHANGED');
    this.clean();
    if(currentBalance<0n)throw Error('DEPLOYMENT_BALANCE_REQUIRED');
    const check=validateMetaMaskPreflight(this.plan,{planId:this.plan.planId,checkId:randomUUID(),checkedAt:new Date(this.now()).toISOString(),predictedAddress:predicted,balance:String(finalBalance),estimatedMaxCost:String(gas*fees.maxFeePerGas),transaction:{from:config.deployer,chainId:'0x279f',data:this.plan.data,value:'0x0',nonce:hex(pending),gas:hex(gas),maxFeePerGas:hex(fees.maxFeePerGas),maxPriorityFeePerGas:hex(fees.maxPriorityFeePerGas)}});
    this.checks.clear();this.checks.set(check.checkId,check);return check;
  }
  async reserve(input:unknown){
    const request=z.object({planId:z.literal(this.plan.planId),checkId:z.string().uuid()}).strict().parse(input),old=this.checks.get(request.checkId);
    this.checks.delete(request.checkId);
    if(!old||this.now()-Date.parse(old.checkedAt)>60_000||this.now()<Date.parse(old.checkedAt))throw new MetaMaskPreflightRejected('DEPLOYMENT_PREFLIGHT_EXPIRED');
    const fresh=await this.preflight().catch(error=>{if(error instanceof Error&&error.message==='DEPLOYMENT_PREFLIGHT_CHANGED')throw new MetaMaskPreflightRejected('DEPLOYMENT_PREFLIGHT_CHANGED');throw error;});this.checks.clear();
    if(JSON.stringify(fresh.transaction)!==JSON.stringify(old.transaction)||!eq(fresh.predictedAddress,old.predictedAddress))throw new MetaMaskPreflightRejected('DEPLOYMENT_PREFLIGHT_CHANGED');
    this.clean();const tx=fresh.transaction;
    const attempt=this.options.store.reserve({planId:this.plan.planId,sourceCommit:this.plan.sourceCommit,chainId:'10143',deployer:this.plan.deployer,initCodeHash:this.plan.initCodeHash,nonce:tx.nonce,gas:tx.gas,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas});
    return {attempt,preflight:{...fresh,checkId:old.checkId}};
  }
  recordHash(input:unknown){
    const request=z.object({planId:z.literal(this.plan.planId),attemptId:z.string().uuid(),transactionHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict().parse(input);
    return this.options.store.recordHash(request.planId,request.attemptId,request.transactionHash);
  }
  async reconcile(){
    const old=this.options.store.get(this.plan.planId);if(!old||!old.transactionHash)return {attempt:old,proof:null};
    const port=this.options.port.proof;
    const checkedPort:DeploymentProofPort={...port,transaction:async hash=>{
      const tx=await port.transaction(hash);if(!tx)return null;
      const feeTx=tx as typeof tx&{gas?:bigint;maxFeePerGas?:bigint|null;maxPriorityFeePerGas?:bigint|null};
      if(BigInt(tx.nonce)!==BigInt(old.nonce)||feeTx.gas===undefined||feeTx.gas>BigInt(old.gas)||feeTx.maxFeePerGas==null||feeTx.maxPriorityFeePerGas==null||feeTx.maxFeePerGas>BigInt(old.maxFeePerGas)||feeTx.maxPriorityFeePerGas>BigInt(old.maxPriorityFeePerGas))throw new Error('DEPLOYMENT_RESERVED_TRANSACTION_MISMATCH');
      return tx;
    }};
    const proof=await verifyDeploymentCreation(this.options.config,this.options.artifact,old.transactionHash,checkedPort);
    if(old.status==='CONFIRMED'&&proof.status!=='CONFIRMED'||old.status==='REVERTED'&&proof.status!=='REVERTED')throw new Error('DEPLOYMENT_TERMINAL_OBSERVATION_CONFLICT');
    const attempt=proof.status==='CONFIRMED'?this.options.store.markConfirmed(old.planId,old.attemptId,old.transactionHash,proof.contractAddress!):proof.status==='REVERTED'?this.options.store.markReverted(old.planId,old.attemptId,old.transactionHash):old;
    return {attempt,proof};
  }
}
