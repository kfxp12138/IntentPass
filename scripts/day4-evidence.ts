import {z} from 'zod';
import {digest,uint,address} from '../packages/protocol/src/schemas.js';
import {completeUnitRun} from './verification-outcome.js';
const time=z.iso.datetime(),contracts=z.object({scope:z.literal('LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES'),status:z.literal('PASS'),startedAt:time,endedAt:time,exitCode:z.literal(0),tests:z.object({passed:z.number().int().min(68),failed:z.literal(0),skipped:z.literal(0)})});
const demo=z.object({scope:z.literal('LOCAL_MONAD_NATIVE_EXECUTION_TEST_DOUBLES_NOT_PUBLIC_MONAD_OR_CVA'),status:z.literal('PASS'),timestamp:time,orderId:digest,finalBalances:z.object({buyer:z.literal('980'),seller:z.literal('20'),escrow:z.literal('0')}),transactions:z.array(z.object({step:z.string(),hash:digest,block:uint,status:z.enum(['success','reverted'])})).length(28),worker:z.object({restart:z.literal('CONFIRMED'),lostResponse:z.literal('RECONCILED'),lostResponseSends:z.literal(1)}),funding:z.object({sends:z.literal(2)}),orders:z.array(z.object({chainId:z.literal('31337'),arbiter:address,state:z.enum(['ALLOCATED_PAID','ALLOCATED_REFUND']),accounting:z.object({balance:z.literal('0'),outstanding:z.literal('0'),locked:z.literal('0')})})).length(3)});
const proof=z.object({status:z.literal('CONFIRMED'),scope:z.literal('LOCAL_TEST_DEPLOYMENT_CREATION_PROOF'),chainId:z.literal('31337'),hash:digest,contractAddress:address,officialIntegrationVerified:z.literal(false),transactionsSent:z.literal(0)});
export function day4LocalEvidence(input:{startedAt:string;endedAt:string;exits:(number|null)[];unit:string;contracts:unknown;demo:unknown;creationProof:unknown;minimumTests:number}){
  try{
    const c=contracts.parse(input.contracts),d=demo.parse(input.demo),p=proof.parse(input.creationProof),start=Date.parse(time.parse(input.startedAt)),end=Date.parse(time.parse(input.endedAt));
    if(end<start||input.exits.length!==6||input.exits.some(v=>v!==0)||!completeUnitRun(input.unit,input.minimumTests)||Date.parse(c.startedAt)<start||Date.parse(c.endedAt)<Date.parse(c.startedAt)||Date.parse(c.endedAt)>end||Date.parse(d.timestamp)<start||Date.parse(d.timestamp)>end)return false;
    if(new Set(d.transactions.map(t=>t.hash.toLowerCase())).size!==28||!d.transactions.some(t=>t.step==='deploy:ContextVoteEscrow'&&t.hash.toLowerCase()===p.hash.toLowerCase()&&t.status==='success')||!d.transactions.some(t=>t.step==='submit:concurrent-replay-rejected'&&t.status==='reverted')||!d.orders.every(o=>o.arbiter.toLowerCase()===p.contractAddress.toLowerCase())||d.orders.filter(o=>o.state==='ALLOCATED_PAID').length!==2||d.orders.filter(o=>o.state==='ALLOCATED_REFUND').length!==1)return false;
    return true;
  }catch{return false;}
}
