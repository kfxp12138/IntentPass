import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {randomUUID} from 'node:crypto';

// Credentials, authorization headers and provider bodies never enter the record.
if(existsSync('.env'))loadEnvFile('.env');
const startedAt=new Date().toISOString(),appId=process.env.PRIVY_APP_ID,secret=process.env.PRIVY_APP_SECRET;
let result:{status:'PASS'|'BLOCKED'|'FAIL';httpStatus:number|null;walletsOnFirstPage?:number;hasNextPage?:boolean;errorCode?:string};
if(!appId||!secret)result={status:'BLOCKED',httpStatus:null,errorCode:'PRIVY_APPLICATION_CONFIGURATION_MISSING'};
else try{
  const response=await fetch('https://api.privy.io/v1/wallets',{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,'privy-app-id':appId,Accept:'application/json'}});
  if(!response.ok)result={status:response.status===401?'FAIL':'BLOCKED',httpStatus:response.status,errorCode:response.status===401?'PRIVY_APPLICATION_AUTH_REJECTED':'PRIVY_APPLICATION_READ_UNAVAILABLE'};
  else{
    const text=await response.text();
    if(Buffer.byteLength(text)>1024*1024)throw Error('PRIVY_RESPONSE_INVALID');
    const body:unknown=JSON.parse(text);
    if(!body||typeof body!=='object'||!('data' in body)||!Array.isArray(body.data))throw Error('PRIVY_RESPONSE_INVALID');
    result={status:'PASS',httpStatus:response.status,walletsOnFirstPage:body.data.length,hasNextPage:'next_cursor' in body&&typeof body.next_cursor==='string'&&body.next_cursor.length>0};
  }
}catch{result={status:'BLOCKED',httpStatus:null,errorCode:'PRIVY_APPLICATION_READ_UNAVAILABLE'};}
const record={startedAt,endedAt:new Date().toISOString(),scope:'REAL_PRIVY_APPLICATION_AUTHENTICATED_WALLET_LIST_ONLY',request:{method:'GET',endpoint:'https://api.privy.io/v1/wallets',attempts:appId&&secret?1:0},...result,applicationCredentialsRecorded:false,providerBodyRecorded:false,walletsCreated:0,policiesChanged:0,signaturesRequested:0,transactionsSent:0,limits:['Only application authentication and wallet-list response structure are checked.','No wallet ownership, live policy, transaction or chain acceptance is proved.']};
const directory='artifacts/acceptance/privy-application';mkdirSync(directory,{recursive:true});
writeFileSync(`${directory}/${Date.now()}-${randomUUID()}.json`,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record));process.exitCode=result.status==='PASS'?0:1;
