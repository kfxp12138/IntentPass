import type {Address} from 'viem';
import {address} from '../../../packages/protocol/src/schemas.js';
import {browserSession} from './browser-session.js';

export const walletSetupControls=`<div id="wallet-setup-controls"><h2>Your linked wallet</h2><p class="hint">Check the embedded Privy wallet linked to this account. MetaMask accounts and separate service wallets are not automatically linked here.</p><button id="read-setup-wallets" type="button">Check my wallet</button><ul id="setup-wallet-addresses" hidden aria-label="Verified public wallet addresses"></ul><label><input id="setup-wallet-consent" type="checkbox">Create a Privy wallet for this account for IntentPass testing.</label><button id="create-setup-wallet" type="button" disabled>Create test wallet</button><p class="hint">An existing wallet is checked first. These actions do not sign, transfer funds, install execution permissions or configure the committee.</p><p id="setup-wallet-feedback" role="status" aria-live="polite"></p></div>`;

export interface WalletSetupSession {
  readonly generation:number;
  setupWallets():Promise<{subject:string;addresses:Address[]}>;
  createSetupWallet(confirmation:boolean):Promise<{subject:string;addresses:Address[]}>;
  onGenerationChange(listener:()=>void):()=>void;
}

/** Shows only server-checked public embedded-wallet addresses; nothing is persisted here. */
export function attachWalletSetupControls(session:WalletSetupSession=browserSession){
  const get=<T extends HTMLElement>(id:string)=>document.querySelector<T>('#'+id)!,root=get<HTMLElement>('wallet-setup-controls'),read=get<HTMLButtonElement>('read-setup-wallets'),create=get<HTMLButtonElement>('create-setup-wallet'),consent=get<HTMLInputElement>('setup-wallet-consent'),addresses=get<HTMLElement>('setup-wallet-addresses'),feedback=get<HTMLElement>('setup-wallet-feedback');
  const login=document.querySelector<HTMLFormElement>('#login-form'),logout=document.querySelector<HTMLButtonElement>('#logout');
  let disposed=false,sequence=0,operation:{id:number;generation:number;kind:'read'|'create'}|undefined,creationUnknown=false;
  const connected=()=>!disposed&&[root,read,create,consent,addresses,feedback].every(node=>node.isConnected);
  const clearAddresses=()=>{addresses.textContent='';addresses.hidden=true;};
  const paint=()=>{if(!connected())return;read.disabled=!!operation;consent.disabled=!!operation||creationUnknown;create.disabled=!!operation||creationUnknown||!consent.checked;};
  const invalidate=()=>{
    if(!connected())return;
    if(operation?.kind==='create')creationUnknown=true;
    sequence++;operation=undefined;clearAddresses();consent.checked=false;
    feedback.textContent='The account changed. Check its linked wallet again.';paint();
  };
  const show=(values:Address[])=>{
    if(!Array.isArray(values)||values.length>128)throw new Error('SETUP_WALLET_RESPONSE_INVALID');
    const verified=values.map(value=>address.parse(value));
    if(new Set(verified.map(value=>value.toLowerCase())).size!==verified.length)throw new Error('SETUP_WALLET_RESPONSE_INVALID');
    for(const value of verified){const row=document.createElement('li');row.textContent=value;addresses.append(row);}
    addresses.hidden=verified.length===0;return verified.length;
  };
  const run=async(kind:'read'|'create')=>{
    if(!connected()||operation||kind==='create'&&(creationUnknown||!consent.checked))return;
    const current={id:++sequence,generation:session.generation,kind};operation=current;clearAddresses();
    consent.checked=false;feedback.textContent=kind==='read'?'Checking this account’s wallet…':'Creating and checking this account’s test wallet…';paint();
    const active=()=>{if(!connected()||operation!==current||sequence!==current.id||session.generation!==current.generation)throw new Error('SESSION_CHANGED');};
    try{
      const result=kind==='read'?await session.setupWallets():await session.createSetupWallet(true);active();
      if(kind==='create'&&!result.addresses.length)throw new Error('SETUP_WALLET_RESPONSE_INVALID');
      const count=show(result.addresses);active();
      creationUnknown=false;
      if(count)feedback.textContent='The linked Privy wallet is verified. Keep its public address for role configuration.';
      else feedback.textContent='No embedded wallet was found. Confirm the option above if you need to create a test wallet.';
    }catch(error){
      if(connected()&&operation===current&&sequence===current.id&&session.generation===current.generation){
        const frameNotReady=kind==='create'&&error instanceof Error&&error.message==='WALLET_FRAME_UNAVAILABLE';
        const loginRequired=kind==='read'&&error instanceof Error&&(error.message==='LOGIN_REQUIRED'||error.message==='SESSION_HTTP_401');
        clearAddresses();if(kind==='create')creationUnknown=!frameNotReady;
        feedback.textContent=frameNotReady?'The wallet component is not connected. No creation request was sent. Check the connection first.':kind==='create'?'Creation is unconfirmed. Read the original wallet before attempting another creation.':loginRequired?'Sign in with the email used to create the original wallet, then check it. Do not create another wallet.':'The wallet could not be verified. Check the session and connection; this does not mean it is missing. Do not recreate an existing wallet.';
      }
    }finally{
      if(connected()&&operation===current&&sequence===current.id&&session.generation===current.generation){operation=undefined;paint();}
    }
  };
  const readClick=()=>{void run('read');},createClick=()=>{void run('create');},consentChange=()=>paint();
  read.addEventListener('click',readClick);create.addEventListener('click',createClick);consent.addEventListener('change',consentChange);
  login?.addEventListener('submit',invalidate,true);logout?.addEventListener('click',invalidate,true);
  const unsubscribe=session.onGenerationChange(invalidate);
  const dispose=()=>{
    if(disposed)return;
    if(connected()){clearAddresses();consent.checked=false;feedback.textContent='';}
    disposed=true;sequence++;operation=undefined;unsubscribe();
    read.removeEventListener('click',readClick);create.removeEventListener('click',createClick);consent.removeEventListener('change',consentChange);
    login?.removeEventListener('submit',invalidate,true);logout?.removeEventListener('click',invalidate,true);window.removeEventListener('pagehide',dispose);
  };
  window.addEventListener('pagehide',dispose);clearAddresses();consent.checked=false;paint();return dispose;
}
