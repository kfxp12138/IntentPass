import {connectGeneralWallet} from './privy-general-connection.js';
import {GeneralConnectionPlanSchema} from '../../../packages/protocol/src/general-connection.js';
import {submitPrivyVote} from './privy-vote-wallet.js';
import {withdrawPrivyOrder} from './privy-withdrawal-wallet.js';
import {WithdrawalRequestSchema,verifyWithdrawalRequest} from '../../../packages/protocol/src/withdrawal.js';
import {WithdrawalReserveResponseSchema,checkWithdrawalRecord} from '../../../packages/protocol/src/withdrawal-api.js';
import {VoteRequestSchema} from '../../../packages/protocol/src/vote.js';
import {AcceptanceReserveRequestSchema,verifyAcceptanceSignature} from '../../../packages/protocol/src/acceptance-api.js';
import {deliverPrivyOrder,signPrivyAcceptance} from './privy-fulfillment-wallet.js';
import {DeliveryReserveRequestSchema} from '../../../packages/protocol/src/delivery-api.js';
import {approvePrivyAsset} from './privy-asset-approval.js';
import {verifyOriginalAuthorization} from '../../../packages/capsule/src/recovery.js';
import {AuthorizationPayloadSchema} from '../../../packages/capsule/src/format.js';
import type {ApprovalStep} from '../../../packages/capsule/src/asset-approval.js';
import {z} from 'zod';
import {BrowserConfigurationSchema,VerifiedSessionSchema,type BrowserConfiguration} from '../../../packages/capsule/src/session-schema.js';
import {CapabilityGrantSchema} from '../../../packages/protocol/src/schemas.js';
import {verifyGrantSignature} from '../../../packages/protocol/src/typed-data.js';
import {monad,monadTestnet} from 'viem/chains';
import {createWalletBridge,signPrivyGrant,inspectPrivyWalletConnection,WalletSignatureNotRequested,type WalletBridge,type WalletConnection} from './privy-grant-wallet.js';
import {createPrivySetupWallet,readPrivySetupWallets,type SetupWallets} from './privy-setup-wallet.js';
import {requestEmailCode} from './email-code.js';
import {UnsignedDemoQuoteSchema} from '../../../packages/protocol/src/demo-quotes.js';
import {SignedQuoteSchema} from '../../../packages/protocol/src/schemas.js';
import {signPrivyDemoQuote} from './privy-quote-wallet.js';
import {verifyQuoteSignature,termsHash} from '../../../packages/protocol/src/typed-data.js';
import {withWalletOperation} from './privy-wallet-operation.js';
import {getAddress} from 'viem';
import {address} from '../../../packages/protocol/src/schemas.js';
import {LoginSessionStorage,type LoginRole} from './login-session-storage.js';
export interface BrowserAuthPort {connectGeneralWallet?(input:unknown,role:'buyer'|'seller',active:()=>void):Promise<{status:'OWNER_REQUEST_COMPLETED'}>;readonly remembered?:boolean;setRemember?(value:boolean):void;initialize():Promise<void>;sendCode(email:string):Promise<void>;login(email:string,code:string):Promise<void>;token():Promise<string|null>;logout():Promise<void>;inspectWalletConnection?(wallet:string,active:()=>void):Promise<WalletConnection>;setupWallets?(subject:string,active:()=>void):Promise<SetupWallets>;createSetupWallet?(subject:string,confirmation:boolean,active:()=>void):Promise<SetupWallets>;signQuote?(input:unknown,subject:string,reserve:()=>Promise<boolean>,active:()=>void):Promise<string>;withdrawOrder?(input:unknown,reservation:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void):ReturnType<typeof withdrawPrivyOrder>;submitVote?(input:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void):ReturnType<typeof submitPrivyVote>;signAcceptance?(input:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void):ReturnType<typeof signPrivyAcceptance>;deliverOrder?(input:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void):ReturnType<typeof deliverPrivyOrder>;signGrant?(grant:unknown):Promise<string>;approveAsset?(payload:unknown,step:ApprovalStep,read:(request:unknown)=>Promise<unknown>,active:()=>void):ReturnType<typeof approvePrivyAsset>;}
export type BrowserAuthFactory=(configuration:BrowserConfiguration,options?:{role:LoginRole;storage?:LoginSessionStorage})=>Promise<BrowserAuthPort>;
export const createBrowserAuth:BrowserAuthFactory=async(configuration,options)=>{
  const {default:Privy}=await import('@privy-io/js-sdk-core');
  const storage=options?.storage??new LoginSessionStorage(configuration.privyAppId,configuration.privyClientId,options?.role??'buyer');
  let loggedIn=false,disposed=false;
  const chain=[monad,monadTestnet].find(chain=>String(chain.id)===configuration.recoveryDeployment?.chainId),bridges=new Set<WalletBridge>();
  const client=new Privy({appId:configuration.privyAppId,clientId:configuration.privyClientId,
    storage:{get:key=>storage.get(key),put:(key,value)=>{if(!disposed)storage.put(key,value);},del:key=>storage.del(key),getKeys:()=>storage.getKeys()},
    ...(chain?{supportedChains:[chain]}:{}),sessions:{mode:'single-user',cookieWriteBehavior:'never'},logger:{level:'NONE',info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}}});
  // In single-user mode authenticate carries the existing bearer token and can
  // link the new email to that user. A different login requires explicit logout.
  const requireLoggedOut=async()=>{
    storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');
    const authenticated=loggedIn||!!await client.getAccessToken();
    storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');
    if(authenticated)throw new Error('LOGIN_SWITCH_ACCOUNT_REQUIRED');
  };
  const bridgeFactory=(sdk:Parameters<typeof createWalletBridge>[0],appId:string)=>{storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');const bridge=createWalletBridge(sdk,appId),managed={dispose:()=>{bridge.dispose();bridges.delete(managed);}};bridges.add(managed);return managed;};
  return {connectGeneralWallet:(input,role,active)=>connectGeneralWallet(input,role,configuration,client,()=>{active();storage.assertActive();if(disposed)throw Error('SESSION_CHANGED');},bridgeFactory),get remembered(){return storage.remembered;},setRemember:value=>storage.setRemember(value),initialize:async()=>{await client.initialize();storage.assertActive();loggedIn=!!await client.getAccessToken();},sendCode:email=>withWalletOperation(client,async()=>{storage.assertActive();await requireLoggedOut();await requestEmailCode(value=>client.auth.email.sendCode(value),email);}),
    login:async(email,code)=>withWalletOperation(client,async()=>{storage.assertActive();await requireLoggedOut();await client.auth.email.loginWithCode(email,code,'login-or-sign-up',{embedded:{ethereum:{createOnLogin:'off'},solana:{createOnLogin:'off'}}});storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');loggedIn=true;}),token:async()=>{storage.assertActive();return client.getAccessToken();},
    inspectWalletConnection:async(wallet,active)=>{storage.assertActive();if(disposed)throw Error('SESSION_CHANGED');if(!chain)throw Error('WALLET_CONFIGURATION_REQUIRED');return inspectPrivyWalletConnection(wallet,String(chain.id),client,configuration.privyAppId,()=>{active();storage.assertActive();if(disposed)throw Error('SESSION_CHANGED');},bridgeFactory);},
    setupWallets:(subject,active)=>readPrivySetupWallets(subject,client,()=>{active();storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');}),
    signQuote:(input,subject,reserve,active)=>{storage.assertActive();if(disposed)throw Error('SESSION_CHANGED');if(!configuration.recoveryDeployment)throw Error('WALLET_CONFIGURATION_REQUIRED');return signPrivyDemoQuote(input,subject,true,configuration.recoveryDeployment,client,configuration.privyAppId,reserve,()=>{active();storage.assertActive();if(disposed)throw Error('SESSION_CHANGED');},bridgeFactory);},
    createSetupWallet:(subject,confirmation,active)=>createPrivySetupWallet(subject,confirmation,client,configuration.privyAppId,()=>{active();storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');},bridgeFactory),
    signGrant:async grant=>{
      storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');
      if(!chain||!configuration.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');
      return signPrivyGrant(grant,configuration.recoveryDeployment,client,configuration.privyAppId,(sdk,appId)=>{
        storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');
        const bridge=createWalletBridge(sdk,appId),managed={dispose:()=>{bridge.dispose();bridges.delete(managed);}};bridges.add(managed);return managed;
      });
    },withdrawOrder:async(input,reservation,read,active)=>{storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');if(!chain||!configuration.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');return withdrawPrivyOrder(input,reservation,true,configuration.recoveryDeployment,client,configuration.privyAppId,read,()=>{active();storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');},bridgeFactory);},submitVote:async(input,read,active)=>{storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');if(!chain||!configuration.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');return submitPrivyVote(input,true,configuration.recoveryDeployment,client,configuration.privyAppId,read,()=>{active();storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');},undefined,bridgeFactory);},signAcceptance:async(input,read,active)=>{storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');if(!chain||!configuration.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');return signPrivyAcceptance(input,true,configuration.recoveryDeployment,client,configuration.privyAppId,read,()=>{active();storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');},undefined,bridgeFactory);},deliverOrder:async(input,read,active)=>{storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');if(!chain||!configuration.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');return deliverPrivyOrder(input,true,configuration.recoveryDeployment,client,configuration.privyAppId,read,()=>{active();storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');},undefined,bridgeFactory);},approveAsset:async(payload,step,read,active)=>{storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');if(!chain||!configuration.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');return approvePrivyAsset(payload,configuration.recoveryDeployment,step,client,configuration.privyAppId,read,()=>{active();storage.assertActive();if(disposed)throw new Error('SESSION_CHANGED');},undefined,bridgeFactory);},logout:async()=>{disposed=true;for(const bridge of bridges)bridge.dispose();let active=false;try{storage.assertActive();active=true;}catch{/* The old role session may already be expired or replaced. */}try{if(loggedIn&&active)await client.auth.logout();}finally{loggedIn=false;storage.clear();}}};
};
export class BrowserSession {
  private port:BrowserAuthPort|undefined;
  private loading:Promise<BrowserConfiguration>|undefined;
  private initializing:Promise<BrowserAuthPort>|undefined;
  private epoch=0;
  private readonly generationListeners=new Set<()=>void>();
  private readonly setupUnknownSubjects=new Set<string>();
  private setupCreating=false;
  private setupEpoch=0;
  private loginsPending=0;
  private authenticated=false;
  get hasAuthenticatedSession(){return this.authenticated;}
  get generation(){return this.epoch;}
  onGenerationChange(listener:()=>void){this.generationListeners.add(listener);return ()=>{this.generationListeners.delete(listener);};}
  private invalidateSetup(){this.setupEpoch++;for(const listener of this.generationListeners){try{listener();}catch{/* A view listener cannot block session invalidation. */}}}
  private advanceEpoch(){this.epoch++;this.invalidateSetup();}
  constructor(private factory:BrowserAuthFactory=createBrowserAuth,private transport:typeof fetch=fetch,private readonly options:{role:LoginRole}={role:'buyer'}){}
  get remembered(){return this.port?.remembered===true;}
  private async getJson(path:string,token?:string) {
    // Native browser fetch requires the Window receiver, not this session object.
    const response=await this.transport.call(globalThis,path,{headers:token?{Authorization:`Bearer ${token}`}:{},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`SESSION_HTTP_${response.status}`);
    const reader=response.body?.getReader();if(!reader)throw new Error('SESSION_RESPONSE_INVALID');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw new Error('SESSION_RESPONSE_INVALID');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  configuration() {
    return this.loading??=this.getJson('/api/config').then(value=>BrowserConfigurationSchema.parse(value)).catch(error=>{this.loading=undefined;throw error;});
  }
  private async auth() {
    if(this.port)return this.port;
    if(!this.initializing){
      const epoch=this.epoch;
      const pending=this.configuration().then(configuration=>this.factory(configuration,this.options)).then(async port=>{await port.initialize();if(epoch!==this.epoch){await port.logout();throw new Error('SESSION_CHANGED');}this.port=port;return port;});
      this.initializing=pending;
      void pending.finally(()=>{if(this.initializing===pending)this.initializing=undefined;}).catch(()=>{});
    }
    return this.initializing;
  }
  async sendCode(email:string){z.email().max(254).parse(email);const epoch=this.epoch;await(await this.auth()).sendCode(email);if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');}
  async login(email:string,code:string,remember=false){z.email().max(254).parse(email);z.string().regex(/^[0-9]{6}$/).parse(code);const epoch=this.epoch;this.loginsPending++;this.invalidateSetup();try{const port=await this.auth();port.setRemember?.(remember);await port.login(email,code);if(epoch!==this.epoch){await port.logout();throw new Error('SESSION_CHANGED');}this.authenticated=true;return await this.verified();}finally{this.loginsPending--;this.invalidateSetup();}}
  async restore(){
    const epoch=this.epoch,port=await this.auth(),token=await port.token();
    if(epoch!==this.epoch)throw Error('SESSION_CHANGED');
    if(!token)return null;
    if(token.length>16384)throw Error('SESSION_RESPONSE_INVALID');
    this.authenticated=true;
    try{const principal=VerifiedSessionSchema.parse(await this.getJson('/api/session',token));if(epoch!==this.epoch)throw Error('SESSION_CHANGED');return principal;}
    catch(error){if(epoch===this.epoch&&error instanceof Error&&error.message==='SESSION_HTTP_401')await this.logout();throw error;}
  }
  async connectGeneral(input:unknown,role:'buyer'|'seller',confirmation:boolean,active:()=>void=()=>{}){if(confirmation!==true)throw Error('GENERAL_CONNECTION_CONFIRMATION_REQUIRED');const plan=GeneralConnectionPlanSchema.parse(input),epoch=this.epoch,principal=await this.verified(),address=plan.roles.find(r=>r.role===role)!.address;const guard=()=>{active();if(epoch!==this.epoch)throw Error('SESSION_CHANGED');};guard();if(!principal.wallets.some(w=>w.toLowerCase()===address.toLowerCase()))throw Error('GENERAL_CONNECTION_OWNER_REQUIRED');const port=await this.auth();guard();if(!port.connectGeneralWallet)throw Error('GENERAL_CONNECTION_UNAVAILABLE');const result=await port.connectGeneralWallet(plan,role,guard);guard();return result;}
  async token(){const epoch=this.epoch,token=await(await this.auth()).token();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');if(!token||token.length>16384)throw new Error('LOGIN_REQUIRED');return token;}
  async verified(){const epoch=this.epoch,token=await this.token();const session=VerifiedSessionSchema.parse(await this.getJson('/api/session',token));if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');return session;}
  private async setup(create:boolean,confirmation:boolean=false):Promise<SetupWallets>{
    if(create&&confirmation!==true)throw new Error('WALLET_SETUP_CONFIRMATION_REQUIRED');
    if(this.loginsPending)throw new Error('WALLET_SETUP_LOGIN_PENDING');
    if(create&&this.setupCreating)throw new Error('WALLET_SIGNATURE_PENDING');
    if(create)this.setupCreating=true;
    const epoch=this.epoch,setupEpoch=this.setupEpoch,guard=()=>{if(epoch!==this.epoch||setupEpoch!==this.setupEpoch||this.loginsPending)throw new Error('SESSION_CHANGED');};let subject:string|undefined,returnedFromCreate=false;
    try{
      const principal=await this.verified();guard();subject=principal.subject;const port=await this.auth();guard();
      const unknown=this.setupUnknownSubjects.has(subject),operation=create&&!unknown?port.createSetupWallet:port.setupWallets;
      if(!operation)throw new Error('WALLET_CONFIGURATION_REQUIRED');
      const result=create&&!unknown?await port.createSetupWallet!(subject,true,guard):await port.setupWallets!(subject,guard);returnedFromCreate=create&&!unknown;guard();
      const current=await this.verified();guard();if(current.subject!==subject||result.subject!==subject)throw new Error('SESSION_CHANGED');
      const candidates=z.array(address).max(128).parse(result.addresses).map(value=>getAddress(value));
      const addresses=[...new Set(candidates)].filter(value=>current.wallets.some(wallet=>wallet.toLowerCase()===value.toLowerCase()));
      if((unknown||returnedFromCreate)&&!addresses.length)throw new Error('WALLET_SETUP_CREATION_OUTCOME_UNKNOWN');
      return {subject,addresses};
    }catch(error){if(create&&subject&&(returnedFromCreate||(error instanceof Error&&error.message==='WALLET_SETUP_CREATION_OUTCOME_UNKNOWN')))this.setupUnknownSubjects.add(subject);throw error;}
    finally{if(create)this.setupCreating=false;}
  }
  setupWallets(){return this.setup(false);}
  createSetupWallet(confirmation:boolean){return this.setup(true,confirmation);}
  async signDemoQuote(input:unknown,confirmation:boolean,reserve:()=>Promise<boolean>,assertActive:()=>void=()=>{}){
    if(confirmation!==true)throw Error('DEMO_QUOTE_CONFIRMATION_REQUIRED');assertActive();const q=Object.freeze(UnsignedDemoQuoteSchema.parse(input)),epoch=this.epoch,principal=await this.verified(),configuration=await this.configuration(),d=configuration.recoveryDeployment;
    const guard=()=>{assertActive();if(this.epoch!==epoch)throw Error('SESSION_CHANGED');};guard();
    const now=BigInt(Math.floor(Date.now()/1000));if(!d||d.chainId!=='10143'||q.asset.toLowerCase()!==d.asset.toLowerCase()||q.seller.toLowerCase()!==q.payee.toLowerCase()||q.amount!=='10'||q.serviceTermsHash.toLowerCase()!==termsHash(q.serviceTerms).toLowerCase()||BigInt(q.expiresAt)<=now||BigInt(q.expiresAt)>now+86400n)throw Error('DEMO_QUOTE_SCOPE_INVALID');
    if(!principal.wallets.some(w=>w.toLowerCase()===q.seller.toLowerCase()))throw Error('DEMO_QUOTE_SELLER_LOGIN_REQUIRED');
    const port=await this.auth();guard();if(!port.signQuote)throw Error('WALLET_CONFIGURATION_REQUIRED');
    const current=async()=>{const p=await this.verified();guard();if(p.subject!==principal.subject||!p.wallets.some(w=>w.toLowerCase()===q.seller.toLowerCase()))throw Error('SESSION_CHANGED');};
    const signature=await port.signQuote(q,principal.subject,async()=>{await current();const result=await reserve();await current();return result;},guard);await current();guard();const signed=SignedQuoteSchema.parse({...q,signature});if(!await verifyQuoteSignature(signed,{chainId:d.chainId,arbiter:d.arbiter}))throw Error('DEMO_QUOTE_SIGNATURE_INVALID');guard();return signed;
  }
  async walletConnection(wallet:string,active:()=>void=()=>{}):Promise<WalletConnection>{
    const expected=address.parse(wallet),epoch=this.epoch,principal=await this.verified(),config=await this.configuration();
    const guard=()=>{active();if(epoch!==this.epoch)throw Error('SESSION_CHANGED');};guard();
    if(!principal.wallets.some(w=>w.toLowerCase()===expected.toLowerCase()))throw Error('WALLET_OWNER_MISMATCH');
    if(!config.recoveryDeployment)throw Error('WALLET_CONFIGURATION_REQUIRED');
    const port=await this.auth();guard();if(!port.inspectWalletConnection)throw Error('WALLET_CONFIGURATION_REQUIRED');
    const result=await port.inspectWalletConnection(expected,guard);guard();
    const current=await this.verified();guard();
    if(current.subject!==principal.subject||!current.wallets.some(w=>w.toLowerCase()===expected.toLowerCase()))throw Error('SESSION_CHANGED');
    if(result.status!=='READY'||result.chainId!==config.recoveryDeployment.chainId||result.wallet.toLowerCase()!==expected.toLowerCase())throw Error('WALLET_CONNECTION_RESPONSE_INVALID');
    return result;
  }
  async signGrant(input:unknown) {
    let portInvoked=false;
    try{
    const grant=Object.freeze(CapabilityGrantSchema.parse(input)),epoch=this.epoch,principal=await this.verified(),config=await this.configuration(),d=config.recoveryDeployment;
    const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
    if(!d||grant.chainId!==d.chainId||!eq(grant.arbiter,d.arbiter)||!eq(grant.asset,d.asset)||!eq(grant.executor,d.executor))throw new Error('WALLET_GRANT_DEPLOYMENT_MISMATCH');
    if(!principal.wallets.some(w=>eq(w,grant.owner)))throw new Error('WALLET_OWNER_MISMATCH');
    if(BigInt(grant.deadline)<=BigInt(Math.floor(Date.now()/1000)))throw new Error('AUTHORIZATION_EXPIRED');
    const port=await this.auth();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');if(!port.signGrant)throw new Error('WALLET_CONFIGURATION_REQUIRED');
    portInvoked=true;const signature=await port.signGrant(grant);if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');
    const current=await this.verified();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');
    if(current.subject!==principal.subject)throw new Error('SESSION_CHANGED');
    if(!current.wallets.some(w=>eq(w,grant.owner)))throw new Error('WALLET_OWNER_MISMATCH');
    if(BigInt(grant.deadline)<=BigInt(Math.floor(Date.now()/1000)))throw new Error('AUTHORIZATION_EXPIRED');
    if(!await verifyGrantSignature(grant,signature as `0x${string}`))throw new Error('WALLET_OWNER_SIGNATURE_INVALID');
    if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');return signature;
    }catch(error){if(error instanceof WalletSignatureNotRequested)throw error;if(!portInvoked)throw new WalletSignatureNotRequested(error);throw error;}
  }
  async approveAsset(input:unknown,step:ApprovalStep,read:(request:unknown)=>Promise<unknown>,assertActive:()=>void){
    const original=AuthorizationPayloadSchema.parse(input),epoch=this.epoch,principal=await this.verified(),config=await this.configuration();
    const guard=()=>{assertActive();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');};guard();
    if(!config.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');
    const payload=await verifyOriginalAuthorization(original,principal.wallets,config.recoveryDeployment);guard();
    if(BigInt(payload.grant.deadline)<=BigInt(Math.floor(Date.now()/1000)))throw new Error('AUTHORIZATION_EXPIRED');
    const current=async()=>{const now=await this.verified();guard();if(now.subject!==principal.subject||!now.wallets.some(w=>w.toLowerCase()===payload.grant.owner.toLowerCase()))throw new Error('SESSION_CHANGED');};
    const port=await this.auth();await current();guard();if(!port.approveAsset)throw new Error('WALLET_CONFIGURATION_REQUIRED');
    return port.approveAsset(payload,step,async request=>{await current();const result=await read(request);await current();return result;},guard);
  }
  async deliverOrder(input:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void){
    const request=DeliveryReserveRequestSchema.parse(input),epoch=this.epoch,principal=await this.verified(),config=await this.configuration(),guard=()=>{active();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');};guard();
    if(!config.recoveryDeployment)throw new Error('WALLET_CONFIGURATION_REQUIRED');if(!principal.wallets.some(w=>w.toLowerCase()===request.payload.intent.seller.toLowerCase()))throw new Error('FULFILLMENT_ROLE_MISMATCH');
    await verifyOriginalAuthorization(request.payload,[request.payload.intent.buyer],config.recoveryDeployment);guard();
    const current=async()=>{const p=await this.verified();guard();if(p.subject!==principal.subject||!p.wallets.some(w=>w.toLowerCase()===request.payload.intent.seller.toLowerCase()))throw new Error('SESSION_CHANGED');};
    const port=await this.auth();await current();guard();if(!port.deliverOrder)throw new Error('WALLET_CONFIGURATION_REQUIRED');
    const result=await port.deliverOrder(request,async candidate=>{await current();const result=await read(candidate);await current();return result;},guard);await current();guard();return result;
  }
  async signAcceptance(input:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void){
    const request=AcceptanceReserveRequestSchema.parse(input),epoch=this.epoch,principal=await this.verified(),config=await this.configuration(),guard=()=>{active();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');};guard();
    const d=config.recoveryDeployment;if(!d)throw new Error('WALLET_CONFIGURATION_REQUIRED');const actor=d.committee[request.memberIndex];if(!principal.wallets.some(w=>w.toLowerCase()===actor.toLowerCase()))throw new Error('FULFILLMENT_ROLE_MISMATCH');
    await verifyOriginalAuthorization(request.payload,[request.payload.intent.buyer],d);guard();const current=async()=>{const p=await this.verified();guard();if(p.subject!==principal.subject||!p.wallets.some(w=>w.toLowerCase()===actor.toLowerCase()))throw new Error('SESSION_CHANGED');};
    const port=await this.auth();await current();guard();if(!port.signAcceptance)throw new Error('WALLET_CONFIGURATION_REQUIRED');const result=await port.signAcceptance(request,async candidate=>{await current();const result=await read(candidate);await current();return result;},guard);await current();guard();return result;
  }
  async submitVote(input:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void){
    const request=VoteRequestSchema.parse(input),epoch=this.epoch,principal=await this.verified(),config=await this.configuration(),guard=()=>{active();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');};guard();const d=config.recoveryDeployment;if(!d)throw new Error('WALLET_CONFIGURATION_REQUIRED');const actor=d.committee[request.memberIndex];if(!principal.wallets.some(w=>w.toLowerCase()===actor.toLowerCase()))throw new Error('FULFILLMENT_ROLE_MISMATCH');
    await verifyOriginalAuthorization(request.payload,[request.payload.intent.buyer],d);await verifyAcceptanceSignature(request,d.committee);guard();const current=async()=>{const p=await this.verified();guard();if(p.subject!==principal.subject||!p.wallets.some(w=>w.toLowerCase()===actor.toLowerCase()))throw new Error('SESSION_CHANGED');};
    const port=await this.auth();await current();guard();if(!port.submitVote)throw new Error('WALLET_CONFIGURATION_REQUIRED');const result=await port.submitVote(request,async candidate=>{await current();const result=await read(candidate);await current();return result;},guard);await current();guard();return result;
  }
  async logout(){this.authenticated=false;this.advanceEpoch();const port=this.port;this.port=undefined;this.initializing=undefined;try{await port?.logout();}finally{this.advanceEpoch();}}
  async withdrawOrder(input:unknown,reservation:unknown,read:(request:unknown)=>Promise<unknown>,active:()=>void){
    const request=WithdrawalRequestSchema.parse(input),ticket=WithdrawalReserveResponseSchema.parse(reservation),epoch=this.epoch,principal=await this.verified(),config=await this.configuration(),guard=()=>{active();if(epoch!==this.epoch)throw new Error('SESSION_CHANGED');};guard();const d=config.recoveryDeployment;if(!d)throw new Error('WALLET_CONFIGURATION_REQUIRED');await verifyWithdrawalRequest(request,principal.wallets,d);guard();if(!('created'in ticket)||!ticket.created)throw new Error('WITHDRAWAL_FRESH_RESERVATION_REQUIRED');checkWithdrawalRecord(request,ticket.record);
    const current=async()=>{const p=await this.verified();guard();if(p.subject!==principal.subject||!p.wallets.some(w=>w.toLowerCase()===request.beneficiary.toLowerCase()))throw new Error('SESSION_CHANGED');};
    const port=await this.auth();await current();guard();if(!port.withdrawOrder)throw new Error('WALLET_CONFIGURATION_REQUIRED');const result=await port.withdrawOrder(request,ticket,async candidate=>{await current();const result=await read(candidate);await current();return result;},guard);await current();guard();return result;
  }
}
export const browserSession=new BrowserSession();
