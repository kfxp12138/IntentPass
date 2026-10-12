import {decodeEventLog,TransactionNotFoundError,TransactionReceiptNotFoundError,type Hex,type Address,type PublicClient} from 'viem';
import {digest} from '../../protocol/src/schemas.js';
import {verifyOriginalAuthorization,RecoveryDeploymentSchema,type RecoveryDeployment} from './recovery.js';
import {encodeFunctionData} from 'viem';
import {exactApprovalAbi,type ApprovalStep} from './asset-approval.js';
const approvalEvent=[{type:'event',name:'Approval',inputs:[{name:'owner',type:'address',indexed:true},{name:'spender',type:'address',indexed:true},{name:'value',type:'uint256',indexed:false}]}] as const;
const allowanceAbi=[{type:'function',name:'allowance',stateMutability:'view',inputs:[{name:'owner',type:'address'},{name:'spender',type:'address'}],outputs:[{name:'',type:'uint256'}]}] as const;
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Read-only reconciliation. Hash alone cannot prove approval or current allowance.
 * Event is ordinary ERC-20 ABI, not a claim of official Cleanverse integration.
 */
export class ExactApprovalReader {
  private deployment:RecoveryDeployment;
  constructor(private client:PublicClient,deployment:RecoveryDeployment){this.deployment=RecoveryDeploymentSchema.parse(deployment);}
  async read(input:unknown,wallets:string[],step:ApprovalStep,transactionHash:string){
    const hash=digest.parse(transactionHash) as Hex,d=this.deployment,p=await verifyOriginalAuthorization(input,wallets,d),g=p.grant;
    if(step!=='RESET'&&step!=='SET')throw new Error('APPROVAL_STEP_INVALID');
    if(String(await this.client.getChainId())!==d.chainId)throw new Error('CHAIN_MISMATCH');
    const amount=step==='RESET'?'0':g.amount,data=encodeFunctionData({abi:exactApprovalAbi,functionName:'approve',args:[g.arbiter as Address,BigInt(amount)]});
    let receipt,transaction;
    try{[receipt,transaction]=await Promise.all([this.client.getTransactionReceipt({hash}),this.client.getTransaction({hash})]);}
    catch(error){if(error instanceof TransactionNotFoundError||error instanceof TransactionReceiptNotFoundError)return {status:'PENDING' as const,hash,canSubmitPayment:false as const};throw error;}
    if(!eq(transaction.hash,hash)||!eq(receipt.transactionHash,hash)||!transaction.to||!eq(transaction.to,g.asset)||!eq(transaction.from,g.owner)
      ||transaction.input.toLowerCase()!==data.toLowerCase()||transaction.value!==0n||String(transaction.chainId)!==d.chainId
      ||transaction.blockHash!==receipt.blockHash||transaction.blockNumber!==receipt.blockNumber)throw new Error('APPROVAL_TRANSACTION_MISMATCH');
    const final=await this.client.getBlock({blockTag:'finalized'});
    if(final.number===null||!final.hash)throw new Error('BLOCK_UNAVAILABLE');
    if(receipt.blockNumber>final.number)return {status:'PENDING' as const,hash,canSubmitPayment:false as const};
    if((await this.client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    if(receipt.status==='success'){
      const matching=receipt.logs.filter(log=>{
        if(!eq(log.address,g.asset)||log.removed)return false;
        try{const event=decodeEventLog({abi:approvalEvent,data:log.data,topics:log.topics,strict:true});return eq(event.args.owner,g.owner)&&eq(event.args.spender,g.arbiter)&&event.args.value===BigInt(amount);}catch{return false;}
      });
      if(matching.length!==1)throw new Error('APPROVAL_EFFECT_UNPROVEN');
    }
    const allowance=await this.client.readContract({address:g.asset as Address,abi:allowanceAbi,functionName:'allowance',args:[g.owner as Address,g.arbiter as Address],blockNumber:final.number});
    if((await this.client.getBlock({blockNumber:final.number})).hash!==final.hash)throw new Error('CHAIN_SNAPSHOT_CHANGED');
    return Object.freeze({status:receipt.status==='success'?'CONFIRMED' as const:'REVERTED' as const,hash,orderId:g.orderId,step,approvedAmount:amount,
      currentAllowance:String(allowance),exactAllowance:allowance===BigInt(g.amount),block:{number:String(final.number),hash:final.hash},canSubmitPayment:false as const});
  }
}
