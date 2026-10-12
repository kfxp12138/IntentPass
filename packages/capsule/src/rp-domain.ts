import {CapsuleError} from './crypto.js';
/** IP literals are secure loopback contexts but are not WebAuthn RP domains. */
export function isIpRpId(hostname:string){return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)||hostname.includes(':')||hostname.startsWith('[');}
export function requirePasskeyDomain(rpId:string){if(isIpRpId(rpId))throw new CapsuleError('PASSKEY_DOMAIN_REQUIRED');}
export function localPasskeyUrl(origin:string){
  const u=new URL(origin);if(u.hostname!=='127.0.0.1'&&u.hostname!=='[::1]')return undefined;
  if(u.protocol!=='http:'&&u.protocol!=='https:')return undefined;
  return `${u.protocol}//localhost${u.port?':'+u.port:''}/#recovery`;
}
