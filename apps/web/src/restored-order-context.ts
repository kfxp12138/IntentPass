import {MemoryPayloadSchema,AuthorizationPayloadSchema,KeyReferenceSchema} from '../../../packages/capsule/src/format.js';
import {recoverAuthorization,type RecoveryDeployment,type RecoveryReader} from '../../../packages/capsule/src/recovery.js';
import {policyHash} from '../../../packages/protocol/src/index.js';
import {createReport} from '../../../packages/protocol/src/report.js';
import {buyerDeliveryHandoff} from './role-handoff.js';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Two decrypted namespaces share one original task and Passkey locator. RAM
 * only: no signer, nonce issuer, allowance, submit endpoint or automatic export.
 */
export class RestoredOrderContext {
  private memory:ReturnType<typeof MemoryPayloadSchema.parse>|undefined;
  private authorization:ReturnType<typeof AuthorizationPayloadSchema.parse>|undefined;
  private reference:ReturnType<typeof KeyReferenceSchema.parse>|undefined;
  private original:Awaited<ReturnType<typeof recoverAuthorization>>|undefined;
  private signedConstraint:ReturnType<typeof AuthorizationPayloadSchema.parse>|undefined;
  private busy=false;
  get memoryPayload(){return this.memory?structuredClone(this.memory):undefined;}
  get originalPayload(){return this.authorization?structuredClone(this.authorization):undefined;}
  get order(){return this.original?structuredClone(this.original.order):undefined;}
  get hasAuthorization(){return !!this.authorization;}
  lockSignedOriginal(input:unknown){const p=AuthorizationPayloadSchema.parse(input);if(this.busy)throw new Error('RESTORED_OPERATION_PENDING');if(this.signedConstraint&&JSON.stringify(this.signedConstraint)!==JSON.stringify(p)||this.authorization&&JSON.stringify(this.authorization)!==JSON.stringify(p))throw new Error('RESTORED_AUTHORIZATION_LOCKED');if(this.memory)this.pair(this.memory,p);this.signedConstraint=structuredClone(p);}
  refresh(wallets:readonly string[],deployment:RecoveryDeployment,reader:RecoveryReader,active:()=>void=()=>{}){if(!this.authorization||!this.reference)throw new Error('RESTORED_AUTHORIZATION_REQUIRED');return this.restoreAuthorization(this.authorization,this.reference,wallets,deployment,reader,active);}
  get canHandoff(){return !!this.authorization&&!!this.memory?.taskInput&&this.original?.continuation!=='NOT_FUNDED';}
  private checkReference(input:unknown){const reference=KeyReferenceSchema.parse(input);if(this.reference&&JSON.stringify(reference)!==JSON.stringify(this.reference))throw new Error('RESTORED_PASSKEY_MISMATCH');return reference;}
  private pair(memory:ReturnType<typeof MemoryPayloadSchema.parse>,authorization:ReturnType<typeof AuthorizationPayloadSchema.parse>){const m=memory.evidence,a=authorization.evidence;if((m.schemaVersion===2||a.schemaVersion===2)&&(m.schemaVersion!==2||a.schemaVersion!==2||!eq(m.salt,a.salt)||m.taskText!==a.taskText))throw new Error('RESTORED_TASK_MISMATCH');if(!eq(policyHash(memory.policy),policyHash(authorization.policy))||memory.taskInput&&(!eq(memory.taskInput.buyer,authorization.intent.buyer)||!eq(memory.taskInput.seller,authorization.intent.seller)||!eq(createReport(memory.taskInput.dataset).datasetHash,authorization.intent.datasetHash)))throw new Error('RESTORED_TASK_MISMATCH');}
  restoreMemory(input:unknown,reference:unknown){if(this.busy)throw new Error('RESTORED_OPERATION_PENDING');const p=MemoryPayloadSchema.parse(input),ref=this.checkReference(reference);if(p.taskInput&&!eq(createReport(p.taskInput.dataset).datasetHash,p.policy.datasetHash))throw new Error('RESTORED_TASK_MISMATCH');if(this.memory&&JSON.stringify(this.memory)!==JSON.stringify(p))throw new Error('RESTORED_MEMORY_LOCKED');if(this.authorization)this.pair(p,this.authorization);if(this.signedConstraint)this.pair(p,this.signedConstraint);this.memory=structuredClone(p);this.reference=ref;return this.memoryPayload!;}
  async restoreAuthorization(input:unknown,reference:unknown,wallets:readonly string[],deployment:RecoveryDeployment,reader:RecoveryReader,active:()=>void=()=>{}){if(this.busy)throw new Error('RESTORED_OPERATION_PENDING');this.busy=true;try{active();const p=AuthorizationPayloadSchema.parse(input),ref=this.checkReference(reference);if(this.authorization&&JSON.stringify(this.authorization)!==JSON.stringify(p)||this.signedConstraint&&JSON.stringify(this.signedConstraint)!==JSON.stringify(p))throw new Error('RESTORED_AUTHORIZATION_LOCKED');if(this.memory)this.pair(this.memory,p);let result:Awaited<ReturnType<typeof recoverAuthorization>>;try{result=await recoverAuthorization(p,wallets,deployment,{read:async id=>{active();const order=await reader.read(id);active();return order;}});}catch(error){active();throw error;}active();const old=this.original?.order,n=result.order;if(old&&(BigInt(n.block.number)<BigInt(old.block.number)||n.block.number===old.block.number&&!eq(n.block.hash,old.block.hash)||old.state.startsWith('ALLOCATED_')&&n.state!==old.state))throw new Error('RESTORED_SNAPSHOT_CHANGED');this.authorization=structuredClone(p);this.reference=ref;this.original=structuredClone(result);return structuredClone(result);}finally{this.busy=false;}}
  async handoff(wallets:readonly string[],deployment:RecoveryDeployment,confirmation:boolean){if(!this.canHandoff||!this.authorization||!this.memory?.taskInput)throw new Error('RESTORED_PAIR_REQUIRED');return buyerDeliveryHandoff(this.authorization,this.memory.taskInput.dataset,wallets,deployment,confirmation);}
  continuationInput(){if(!this.authorization||!this.original||this.original.continuation==='NOT_FUNDED')throw new Error('RESTORED_FUNDED_ORDER_REQUIRED');return {payload:structuredClone(this.authorization)};}
  clear(){if(this.busy)throw new Error('RESTORED_OPERATION_PENDING');this.memory=undefined;this.authorization=undefined;this.original=undefined;this.reference=undefined;this.signedConstraint=undefined;}
}
