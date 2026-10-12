// LOCAL PROCESS TEST ONLY. Competes for a queue lease; never sends a transaction.
import {SettlementStore} from '../../packages/storage/src/settlement-store.js';
const store=new SettlementStore(process.argv[2]);
process.once('message',message=>{
  const key=String(message),attempt=store.acquire(key,'settle',1000);
  store.close();process.send!({type:'result',attempt:attempt??null},()=>process.disconnect());
});
process.send!({type:'ready'});
