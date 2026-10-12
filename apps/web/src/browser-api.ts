import type {IncomingMessage,ServerResponse} from 'node:http';
import {AuthenticationRejected,type Authenticator,PrivyAuthenticator,createPrivyClient} from '../../../packages/adapters/src/privy-auth.js';
import {BrowserConfigurationSchema,VerifiedSessionSchema,type BrowserConfiguration} from '../../../packages/capsule/src/session-schema.js';
import {committeeHash} from '../../../packages/protocol/src/escrow.js';
import {assetConfigurationKey,configuredAssetAddress} from '../../../packages/protocol/src/asset-mode.js';
export interface BrowserApi {configuration:BrowserConfiguration;auth:Authenticator;}
export function configuredBrowserApi(env:NodeJS.ProcessEnv):BrowserApi|undefined {
  if(!env.PRIVY_APP_ID?.trim()||!env.PRIVY_APP_SECRET?.trim())return undefined;
  const keys=['MONAD_RPC_URL','CHAIN_ID','ARBITER_ADDRESS',assetConfigurationKey(env),'ELIGIBILITY_GATE_ADDRESS','REVIEWER_ADDRESS','COMMITTEE_ADDRESSES','PRIVY_EXECUTOR_ADDRESS'];
  const deployment=keys.some(key=>!env[key]?.trim())?null:{chainId:env.CHAIN_ID,arbiter:env.ARBITER_ADDRESS,asset:configuredAssetAddress(env),reviewer:env.REVIEWER_ADDRESS,committee:env.COMMITTEE_ADDRESSES!.split(',').map(v=>v.trim()),executor:env.PRIVY_EXECUTOR_ADDRESS};
  const configuration=BrowserConfigurationSchema.parse({privyAppId:env.PRIVY_APP_ID,...(env.PRIVY_CLIENT_ID?{privyClientId:env.PRIVY_CLIENT_ID}:{}),meraRpId:env.MERA_RP_ID||null,recoveryDeployment:deployment});
  if(configuration.recoveryDeployment)committeeHash(configuration.recoveryDeployment.committee);
  return {configuration,auth:new PrivyAuthenticator(createPrivyClient({appId:env.PRIVY_APP_ID,appSecret:env.PRIVY_APP_SECRET,verificationKey:env.PRIVY_JWT_VERIFICATION_KEY}))};
}
export async function serveBrowser(req:IncomingMessage,res:ServerResponse,path:string,api:BrowserApi) {
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.method!=='GET')return send(405,{code:'METHOD_NOT_ALLOWED'});
  if(path==='/api/config')return send(200,BrowserConfigurationSchema.parse(api.configuration));
  const token=req.headers.authorization;
  if(!token?.startsWith('Bearer ')||token.length>16400)return send(401,{code:'AUTHENTICATION_REQUIRED'});
  try{return send(200,VerifiedSessionSchema.parse(await api.auth.authenticate(token.slice(7))));}
  catch(error){return send(error instanceof AuthenticationRejected?401:503,{code:error instanceof AuthenticationRejected?'AUTHENTICATION_REJECTED':'SESSION_UNAVAILABLE'});}
}
