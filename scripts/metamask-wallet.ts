import {z} from 'zod';
import {MetaMaskWalletPlanSchema,quantity,validateMetaMaskPreflight,type MetaMaskAttempt,type MetaMaskWalletPlan,type MetaMaskPreflight} from './metamask-types.js';
import {MetaMaskPreflightRejected} from './metamask-preflight-rejection.js';

export interface MetaMaskProvider {
  readonly isMetaMask?:boolean;
  request(input:{method:string;params?:unknown[]}):Promise<unknown>;
  on?(event:string,listener:(...args:unknown[])=>void):unknown;
  removeListener?(event:string,listener:(...args:unknown[])=>void):unknown;
}
export interface MetaMaskDeploymentBackend {
  reserve(input:{planId:string;checkId:string}):Promise<{attempt:MetaMaskAttempt;preflight:MetaMaskPreflight}>;
  recordHash(input:{planId:string;attemptId:string;transactionHash:string}):Promise<MetaMaskAttempt>;
}

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value=>BigInt(value)!==0n);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const attemptSchema=z.object({
  attemptId:z.string().uuid(),planId:hash,sourceCommit:z.string().regex(/^[0-9a-f]{40}$/),chainId:z.literal('10143'),
  deployer:address,initCodeHash:hash,nonce:quantity,gas:quantity,maxFeePerGas:quantity,maxPriorityFeePerGas:quantity,
  status:z.enum(['RESERVED','SUBMITTED','CONFIRMED','REVERTED']),transactionHash:hash.nullable(),contractAddress:address.nullable(),
  createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()
}).strict();
const equal=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
const fail=(code:string):never=>{throw new Error(code);};
function freeze<T>(value:T):T {
  if(value!==null&&typeof value==='object'){
    for(const item of Object.values(value))freeze(item);
    Object.freeze(value);
  }
  return value;
}
function parseAttempt(input:unknown):MetaMaskAttempt {
  try{return freeze(attemptSchema.parse(input));}catch{return fail('METAMASK_ATTEMPT_MISMATCH');}
}
function matchesPlan(record:MetaMaskAttempt,plan:MetaMaskWalletPlan,check:MetaMaskPreflight){
  const tx=check.transaction;
  return equal(record.planId,plan.planId)&&record.sourceCommit===plan.sourceCommit&&record.chainId===plan.chainId
    &&equal(record.deployer,plan.deployer)&&equal(record.initCodeHash,plan.initCodeHash)
    &&record.nonce===tx.nonce&&record.gas===tx.gas&&record.maxFeePerGas===tx.maxFeePerGas
    &&record.maxPriorityFeePerGas===tx.maxPriorityFeePerGas&&Date.parse(record.updatedAt)>=Date.parse(record.createdAt);
}

/** Browser-only, single-attempt deployment handoff. No keys or general signing. */
export class MetaMaskDeploymentFlow {
  private disposed=false;
  private busy=false;
  private reserved=false;
  private epoch=0;
  private invalidated=false;
  private eventsReady=false;
  private submission:{attempt:MetaMaskAttempt;transactionHash:string}|null=null;
  private listeners:Array<{event:string;listener:(...args:unknown[])=>void}>=[];

  constructor(private readonly provider:MetaMaskProvider,private readonly backend:MetaMaskDeploymentBackend,
    private readonly options:{saveHash?:(attempt:MetaMaskAttempt,hash:string)=>void;currentProvider?:()=>MetaMaskProvider|undefined}={}){
    try{
      if(typeof provider.on!=='function'||typeof provider.removeListener!=='function')return;
      for(const event of ['accountsChanged','chainChanged','disconnect']){
        const listener=()=>{this.epoch++;this.invalidated=true;};
        this.listeners.push({event,listener});provider.on(event,listener);
      }
      this.eventsReady=true;
    }catch{this.removeListeners();}
  }
  private active(){
    if(this.disposed)fail('METAMASK_FLOW_DISPOSED');
    this.providerIdentity();
    try{if(this.provider.isMetaMask!==true)fail('METAMASK_PROVIDER_REQUIRED');}
    catch{fail('METAMASK_PROVIDER_REQUIRED');}
  }
  private providerIdentity(){
    try{if(this.options.currentProvider&&this.options.currentProvider()!==this.provider)fail('METAMASK_PROVIDER_CHANGED');}
    catch{fail('METAMASK_PROVIDER_CHANGED');}
  }
  private context(epoch:number){
    this.active();
    if(this.invalidated||this.epoch!==epoch)fail('METAMASK_CONTEXT_CHANGED');
  }
  private async read(method:string,params?:unknown[]):Promise<unknown>{
    try{return await this.provider.request(params===undefined?{method}:{method,params});}
    catch{return fail('METAMASK_WALLET_UNAVAILABLE');}
  }
  private account(input:unknown):string{
    try{return z.array(address).min(1).parse(input)[0];}catch{return fail('METAMASK_ACCOUNT_UNAVAILABLE');}
  }
  private amount(input:unknown):string{
    try{return quantity.parse(input);}catch{return fail('METAMASK_WALLET_RESPONSE_INVALID');}
  }
  private nonce(input:unknown):string{
    // Some MetaMask providers return a numeric transaction count. Keep this
    // compatibility local to nonce reads; plans and sent quantities stay strict.
    if(typeof input==='number'){
      if(!Number.isSafeInteger(input)||input<0||Object.is(input,-0))fail('METAMASK_WALLET_RESPONSE_INVALID');
      return this.amount(`0x${input.toString(16)}`);
    }
    return this.amount(input);
  }
  async connect():Promise<{account:string;chainId:string;balance:string}>{
    this.active();if(this.busy)fail('METAMASK_SEND_PENDING');
    const account=this.account(await this.read('eth_requestAccounts'));
    this.active();
    // Initial permission can emit accountsChanged; subsequent reads must be stable.
    const epoch=this.epoch;
    const chainId=this.amount(await this.read('eth_chainId'));this.active();
    if(this.epoch!==epoch)fail('METAMASK_CONTEXT_CHANGED');
    const balance=this.amount(await this.read('eth_getBalance',[account,'latest']));this.active();
    if(this.epoch!==epoch)fail('METAMASK_CONTEXT_CHANGED');
    this.invalidated=false;
    return {account,chainId,balance:BigInt(balance).toString()};
  }
  private async verifyWallet(plan:MetaMaskWalletPlan,check:MetaMaskPreflight,epoch:number){
    this.context(epoch);
    const selected=this.account(await this.read('eth_accounts'));this.context(epoch);
    if(!equal(selected,plan.deployer))fail('METAMASK_ACCOUNT_MISMATCH');
    const chain=this.amount(await this.read('eth_chainId'));this.context(epoch);
    if(chain!=='0x279f')fail('METAMASK_TESTNET_REQUIRED');
    const pending=this.nonce(await this.read('eth_getTransactionCount',[plan.deployer,'pending']));this.context(epoch);
    const latest=this.nonce(await this.read('eth_getTransactionCount',[plan.deployer,'latest']));this.context(epoch);
    if(pending!==latest||pending!==check.transaction.nonce)fail('METAMASK_NONCE_MISMATCH');
  }
  async checkWallet(plan:MetaMaskWalletPlan,check:MetaMaskPreflight):Promise<void>{
    this.active();
    if(this.busy)fail('METAMASK_SEND_PENDING');
    if(!this.eventsReady)fail('METAMASK_EVENTS_REQUIRED');
    this.busy=true;
    try{
      let fixedPlan:MetaMaskWalletPlan,fixedCheck:MetaMaskPreflight;
      try{fixedPlan=freeze(MetaMaskWalletPlanSchema.parse(plan));fixedCheck=freeze(validateMetaMaskPreflight(fixedPlan,check));}
      catch{return fail('METAMASK_PLAN_OR_PREFLIGHT_INVALID');}
      await this.verifyWallet(fixedPlan,fixedCheck,this.epoch);
    }finally{this.busy=false;}
  }
  get submitted():{attempt:MetaMaskAttempt;transactionHash:string}|null{
    return this.submission===null?null:structuredClone(this.submission);
  }
  async send(plan:MetaMaskWalletPlan,check:MetaMaskPreflight,confirmed:boolean):Promise<{attemptId:string;transactionHash:string}>{
    if(confirmed!==true)fail('METAMASK_CONFIRMATION_REQUIRED');
    this.active();
    if(this.busy)fail('METAMASK_SEND_PENDING');
    if(this.reserved)fail('METAMASK_ALREADY_RESERVED');
    if(!this.eventsReady)fail('METAMASK_EVENTS_REQUIRED');
    this.busy=true;
    try{
      let fixedPlan:MetaMaskWalletPlan,fixedCheck:MetaMaskPreflight;
      try{fixedPlan=freeze(MetaMaskWalletPlanSchema.parse(plan));fixedCheck=freeze(validateMetaMaskPreflight(fixedPlan,check));}
      catch{return fail('METAMASK_PLAN_OR_PREFLIGHT_INVALID');}
      const epoch=this.epoch;
      await this.verifyWallet(fixedPlan,fixedCheck,epoch);
      // Lock before the call: a lost response may still have durably reserved it.
      this.reserved=true;
      let response:{attempt:MetaMaskAttempt;preflight:MetaMaskPreflight};
      try{response=await this.backend.reserve({planId:fixedPlan.planId,checkId:fixedCheck.checkId});}
      catch(error){if(error instanceof MetaMaskPreflightRejected){this.reserved=false;throw error;}return fail('METAMASK_RESERVATION_OUTCOME_UNKNOWN');}
      this.context(epoch);
      let fresh:MetaMaskPreflight,attempt:MetaMaskAttempt;
      try{
        fresh=freeze(validateMetaMaskPreflight(fixedPlan,response.preflight));attempt=parseAttempt(response.attempt);
        if(fresh.planId!==fixedCheck.planId||fresh.checkId!==fixedCheck.checkId
          ||fresh.predictedAddress!==fixedCheck.predictedAddress
          ||JSON.stringify(fresh.transaction)!==JSON.stringify(fixedCheck.transaction)
          ||!matchesPlan(attempt,fixedPlan,fixedCheck)||attempt.status!=='RESERVED'
          ||attempt.transactionHash!==null||attempt.contractAddress!==null)fail('METAMASK_RESERVATION_MISMATCH');
      }catch{return fail('METAMASK_RESERVATION_MISMATCH');}
      await this.verifyWallet(fixedPlan,fixedCheck,epoch);
      this.context(epoch);
      let transactionHash:string;
      try{transactionHash=hash.parse(await this.provider.request({method:'eth_sendTransaction',params:[fixedCheck.transaction]}));}
      catch{return fail('METAMASK_SEND_OUTCOME_UNKNOWN');}
      // A wallet event after submission cannot erase the returned public hash.
      this.submission={attempt,transactionHash};
      let providerChanged=false;
      try{this.providerIdentity();}catch{providerChanged=true;}
      let saveFailed=false;
      try{this.options.saveHash?.(attempt,transactionHash);}catch{saveFailed=true;}
      let recorded:MetaMaskAttempt;
      try{recorded=parseAttempt(await this.backend.recordHash({planId:fixedPlan.planId,attemptId:attempt.attemptId,transactionHash}));}
      catch{return fail('METAMASK_HASH_RECORD_FAILED');}
      try{this.providerIdentity();}catch{providerChanged=true;}
      if(!matchesPlan(recorded,fixedPlan,fixedCheck)||recorded.attemptId!==attempt.attemptId
        ||recorded.createdAt!==attempt.createdAt||Date.parse(recorded.updatedAt)<Date.parse(attempt.updatedAt)
        ||recorded.transactionHash===null||!equal(recorded.transactionHash,transactionHash)
        ||recorded.status==='RESERVED'
        ||(recorded.status==='CONFIRMED'?recorded.contractAddress===null||!equal(recorded.contractAddress,fixedCheck.predictedAddress):recorded.contractAddress!==null))fail('METAMASK_HASH_RECORD_MISMATCH');
      if(saveFailed)fail('METAMASK_HASH_SAVE_FAILED');
      if(providerChanged)fail('METAMASK_PROVIDER_CHANGED');
      return {attemptId:attempt.attemptId,transactionHash};
    }finally{this.busy=false;}
  }
  private removeListeners(){
    this.eventsReady=false;
    for(const {event,listener} of this.listeners){try{this.provider.removeListener?.(event,listener);}catch{}}
    this.listeners=[];
  }
  dispose(){
    if(this.disposed)return;
    this.disposed=true;this.epoch++;this.invalidated=true;this.removeListeners();
  }
}
