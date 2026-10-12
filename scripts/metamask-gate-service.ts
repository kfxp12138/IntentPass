import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Address,Hex} from 'viem';
import {CleanverseBootstrapConfigSchema,inspectCleanverseBootstrap,type CleanverseBootstrapReadPort} from '../packages/protocol/src/cleanverse-bootstrap.js';
import {verifyCleanverseGateCreation} from '../packages/protocol/src/cleanverse-gate-proof.js';
import type {CleanverseGateProofPort} from '../packages/protocol/src/cleanverse-gate-proof-types.js';
import {DeploymentAttemptStore} from '../packages/storage/src/deployment-attempt-store.js';
import {metamaskGatePlan,validateMetaMaskPreflight,type MetaMaskGateStatus,type MetaMaskPreflight} from './metamask-types.js';
const hex=(value:bigint)=>`0x${value.toString(16)}` as Hex;
const equal=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))frozen(item);Object.freeze(value);}return value;}
export interface MetaMaskGateReadPort extends CleanverseBootstrapReadPort{
  estimate(transaction:{account:Address;data:Hex;value:bigint;nonce:number;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}):Promise<bigint>;
  fees():Promise<{maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}>;
  proof:CleanverseGateProofPort;
}
/** Fixed nonce N creates only the gate. Escrow N+1 needs a separate fresh handoff. */
export class MetaMaskGateDeploymentService{
  readonly plan;private readonly config;private readonly gateArtifact;private readonly escrowArtifact;
  private readonly proofConfig;private checks=new Map<string,MetaMaskPreflight>();
  constructor(private options:{config:unknown;gateArtifact:unknown;escrowArtifact:unknown;nonce:bigint;sourceCommit:string;sourceClean:()=>boolean;store:DeploymentAttemptStore;port:MetaMaskGateReadPort;clock?:()=>number}){
    this.config=frozen(CleanverseBootstrapConfigSchema.parse(options.config));
    this.gateArtifact=frozen(structuredClone(options.gateArtifact));this.escrowArtifact=frozen(structuredClone(options.escrowArtifact));
    this.plan=frozen(metamaskGatePlan(this.config,this.gateArtifact,this.escrowArtifact,options.nonce,options.sourceCommit));
    this.proofConfig=frozen({chainId:this.plan.chainId,deployer:this.plan.deployer,asset:this.plan.asset,validator:this.plan.validator,policy:this.plan.policy,pool:this.plan.pool,nonce:BigInt(this.plan.gateNonce)});
  }
  status():MetaMaskGateStatus{
    const attempt=this.options.store.get(this.plan.planId),clean=this.options.sourceClean();
    return {scope:'LOCAL_OPERATOR_CLEANVERSE_GATE_HANDOFF',ready:clean&&!attempt,blockers:[...(!clean?['SOURCE_REVISION_CHANGED']:[]),...(attempt?['DEPLOYMENT_ATTEMPT_ALREADY_RESERVED']:[])],plan:this.plan,attempt,officialIntegrationVerified:false,transactionsSentByServer:0};
  }
  private clean(){if(!this.options.sourceClean())throw new Error('SOURCE_REVISION_CHANGED');}
  private now(){return (this.options.clock??Date.now)();}
  async preflight(){
    this.clean();if(this.options.store.get(this.plan.planId))throw new Error('DEPLOYMENT_ATTEMPT_ALREADY_RESERVED');
    const port=this.options.port,{draft,inspection}=await inspectCleanverseBootstrap(this.config,this.gateArtifact,this.escrowArtifact,port);
    if(inspection.status!=='INSPECTED')throw new Error('DEPLOYMENT_BALANCE_REQUIRED');
    if(BigInt(inspection.nonce)!==BigInt(this.plan.gateNonce)||!equal(draft.escrow.predictedAddress,this.plan.pool)||!equal(draft.gate.transaction.data,this.plan.data))throw new Error('DEPLOYMENT_FIXED_GATE_NONCE_CHANGED');
    const [fees,balance]=await Promise.all([port.fees(),port.currentBalance(this.plan.deployer as Address)]);
    if(fees.maxFeePerGas<=0n||fees.maxPriorityFeePerGas<0n||fees.maxPriorityFeePerGas>fees.maxFeePerGas)throw new Error('DEPLOYMENT_GAS_OR_FEES_INVALID');
    const estimate=await port.estimate({account:this.plan.deployer as Address,data:this.plan.data as Hex,value:0n,nonce:Number(BigInt(this.plan.gateNonce)),...fees}),gas=estimate+(estimate+4n)/5n;
    if(estimate<=0n||gas>30_000_000n)throw new Error('DEPLOYMENT_GAS_OR_FEES_INVALID');
    const block=BigInt(inspection.block.number),[chain,canonical,pending,latest]=await Promise.all([port.chainId(),port.block(block),port.nonce(this.plan.deployer as Address,'pending'),port.nonce(this.plan.deployer as Address,'latest')]);
    if(chain!==10143||canonical.number!==block||canonical.hash!==inspection.block.hash)throw new Error('DEPLOYMENT_SNAPSHOT_CHANGED');
    if(pending!==BigInt(this.plan.gateNonce)||latest!==pending)throw new Error('DEPLOYMENT_FIXED_GATE_NONCE_CHANGED');
    this.clean();
    const check=frozen(validateMetaMaskPreflight(this.plan,{planId:this.plan.planId,checkId:randomUUID(),checkedAt:new Date(this.now()).toISOString(),predictedAddress:draft.gate.predictedAddress,balance:String(balance),estimatedMaxCost:String(gas*fees.maxFeePerGas),transaction:{from:this.plan.deployer,chainId:'0x279f',data:this.plan.data,value:'0x0',nonce:this.plan.gateNonce,gas:hex(gas),maxFeePerGas:hex(fees.maxFeePerGas),maxPriorityFeePerGas:hex(fees.maxPriorityFeePerGas)}}));
    this.checks.clear();this.checks.set(check.checkId,check);return check;
  }
  async reserve(input:unknown){
    const request=z.object({planId:z.literal(this.plan.planId),checkId:z.string().uuid()}).strict().parse(input),old=this.checks.get(request.checkId);this.checks.delete(request.checkId);
    if(!old||this.now()-Date.parse(old.checkedAt)>60_000||this.now()<Date.parse(old.checkedAt))throw new Error('DEPLOYMENT_PREFLIGHT_EXPIRED');
    const fresh=await this.preflight();this.checks.clear();
    if(JSON.stringify(fresh.transaction)!==JSON.stringify(old.transaction)||!equal(fresh.predictedAddress,old.predictedAddress))throw new Error('DEPLOYMENT_PREFLIGHT_CHANGED');
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
    const port=this.options.port.proof,checkedPort:CleanverseGateProofPort={...port,transaction:async hash=>{
      const tx=await port.transaction(hash);if(!tx)return null;
      const fees=tx as typeof tx&{gas?:bigint;maxFeePerGas?:bigint|null;maxPriorityFeePerGas?:bigint|null};
      if(BigInt(tx.nonce)!==BigInt(old.nonce)||fees.gas===undefined||fees.gas<=0n||fees.gas>BigInt(old.gas)||fees.maxFeePerGas==null||fees.maxFeePerGas<=0n||fees.maxPriorityFeePerGas==null||fees.maxPriorityFeePerGas<0n||fees.maxPriorityFeePerGas>fees.maxFeePerGas||fees.maxFeePerGas>BigInt(old.maxFeePerGas)||fees.maxPriorityFeePerGas>BigInt(old.maxPriorityFeePerGas))throw new Error('DEPLOYMENT_RESERVED_TRANSACTION_MISMATCH');
      return tx;
    }};
    const proof=await verifyCleanverseGateCreation(this.proofConfig,this.gateArtifact,old.transactionHash,checkedPort);
    if(old.status==='CONFIRMED'&&proof.status!=='CONFIRMED'||old.status==='REVERTED'&&proof.status!=='REVERTED')throw new Error('DEPLOYMENT_TERMINAL_OBSERVATION_CONFLICT');
    const attempt=proof.status==='CONFIRMED'?this.options.store.markConfirmed(old.planId,old.attemptId,old.transactionHash,proof.contractAddress!):proof.status==='REVERTED'?this.options.store.markReverted(old.planId,old.attemptId,old.transactionHash):old;
    return {attempt,proof};
  }
}
