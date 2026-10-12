import {PrivyClient} from '@privy-io/node';
import {getAddress,isAddress,type Address} from 'viem';
export interface Principal {subject:string;wallets:Address[];}
export interface Authenticator {authenticate(token:string):Promise<Principal>;}
export class AuthenticationRejected extends Error {constructor(){super('AUTHENTICATION_REJECTED');}}
/** Server-only factory. Official origin, no redirects, diagnostics or automatic retries. */
export function createPrivyClient(config:{appId:string;appSecret:string;verificationKey?:string}) {
  if(!config.appId||!config.appSecret)throw new Error('AUTH_CONFIGURATION_REQUIRED');
  return new PrivyClient({appId:config.appId,appSecret:config.appSecret,apiUrl:'https://api.privy.io',fetchOptions:{redirect:'error'},maxRetries:0,timeout:20000,logLevel:'off',
    ...(config.verificationKey?{jwtVerificationKey:config.verificationKey}:{})});
}
export class PrivyAuthenticator implements Authenticator {
  constructor(private readonly client:PrivyClient){}
  async authenticate(token:string):Promise<Principal> {
    if(!token||token.length>16384||!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))throw new AuthenticationRejected();
    let claims;
    try {claims=await this.client.utils().auth().verifyAccessToken(token);}catch{throw new AuthenticationRejected();}
    if(claims.issued_at>Math.floor(Date.now()/1000)+30||!claims.user_id||!claims.session_id)throw new AuthenticationRejected();
    // Only the SDK-verified subject chooses the provider lookup; never a caller-supplied buyer.
    const user=await this.client.users()._get(claims.user_id);
    if(user.id!==claims.user_id)throw new AuthenticationRejected();
    const wallets=user.linked_accounts.flatMap(account=>account.type==='wallet'&&account.chain_type==='ethereum'&&isAddress(account.address)
      ?[getAddress(account.address)]:[]);
    return {subject:claims.user_id,wallets:[...new Set(wallets)]};
  }
}
