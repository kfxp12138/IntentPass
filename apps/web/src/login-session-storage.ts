import type {Storage as PrivyStorage} from '@privy-io/js-sdk-core';
import {z} from 'zod';

export type LoginRole='buyer'|'seller';
// Persist authentication only. Wallet shares, PRF material and task data stay out.
const keys=['privy:token','privy:pat','privy:refresh_token','privy:id-token'] as const;
const entry=z.object(Object.fromEntries(keys.map(key=>[key,z.string().max(16384).optional()]))).strict();
const record=z.object({version:z.literal(1),id:z.string().min(1).max(128),expiresAt:z.number().int().positive(),entries:entry}).strict();
const TAB_MS=8*60*60*1000,DEVICE_MS=7*24*60*60*1000;
type WebStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
function browserStorage(name:'sessionStorage'|'localStorage'):WebStorage|undefined{try{return globalThis[name];}catch{return undefined;}}

export class LoginSessionStorage implements PrivyStorage {
  private readonly memory=new Map<string,unknown>();
  private readonly name:string;
  private id:string=crypto.randomUUID();
  private expiresAt:number;
  private backing:WebStorage|undefined;
  private exists=false;
  private closed=false;
  private device=false;
  constructor(appId:string,clientId:string|undefined,role:LoginRole,
    private readonly tab:WebStorage|undefined=browserStorage('sessionStorage'),
    private readonly local:WebStorage|undefined=browserStorage('localStorage'),
    private readonly now:()=>number=Date.now){
    this.name=`intentpass:login:v1:${appId}:${clientId??''}:${role}`;
    this.expiresAt=now()+TAB_MS;this.backing=tab;
    for(const [source,device] of [[tab,false],[local,true]] as const){
      const saved=this.read(source);
      if(saved){this.backing=source;this.device=device;this.exists=true;this.id=saved.id;this.expiresAt=saved.expiresAt;break;}
    }
  }
  get remembered(){return this.device;}
  private read(source:WebStorage|undefined){
    if(!source)return undefined;
    let raw:string|null;try{raw=source.getItem(this.name);}catch{throw Error('LOGIN_STORAGE_UNAVAILABLE');}
    if(!raw)return undefined;
    let parsed:ReturnType<typeof record.safeParse>;
    try{parsed=record.safeParse(raw.length<=70000?JSON.parse(raw):null);}catch{parsed=record.safeParse(null);}
    if(!parsed.success||parsed.data.expiresAt<=this.now()){source.removeItem(this.name);return undefined;}
    return parsed.data;
  }
  assertActive(){
    if(this.closed)throw Error('SESSION_CHANGED');
    if(this.now()>=this.expiresAt)throw Error('LOGIN_SESSION_EXPIRED');
    const saved=this.read(this.backing);
    if((this.exists&&!saved)||(saved&&saved.id!==this.id))throw Error('SESSION_CHANGED');
  }
  setRemember(remember:boolean){
    this.assertActive();
    if(this.exists){
      if(Object.keys(this.read(this.backing)?.entries??{}).length)throw Error('LOGIN_SWITCH_ACCOUNT_REQUIRED');
      this.backing?.removeItem(this.name);this.exists=false;this.id=crypto.randomUUID();
    }
    if(remember&&!this.local)throw Error('LOGIN_STORAGE_UNAVAILABLE');
    this.device=remember;this.backing=remember?this.local:this.tab;
    this.expiresAt=this.now()+(remember?DEVICE_MS:TAB_MS);
  }
  get(key:string){this.assertActive();if((keys as readonly string[]).includes(key))return this.read(this.backing)?.entries[key]??this.memory.get(key);return this.memory.get(key);}
  put(key:string,value:unknown){
    this.assertActive();
    if((keys as readonly string[]).includes(key)){
      if(typeof value!=='string'||value.length>16384)throw Error('LOGIN_STORAGE_VALUE_INVALID');
      if(this.backing){
        const entries=this.read(this.backing)?.entries??{};
        try{this.backing.setItem(this.name,JSON.stringify({version:1,id:this.id,expiresAt:this.expiresAt,entries:{...entries,[key]:value}}));}catch{throw Error('LOGIN_STORAGE_UNAVAILABLE');}
        this.exists=true;return;
      }
    }
    this.memory.set(key,value);
  }
  del(key:string){
    this.assertActive();this.memory.delete(key);
    if((keys as readonly string[]).includes(key)&&this.exists){
      const saved=this.read(this.backing)!;delete saved.entries[key];
      this.backing!.setItem(this.name,JSON.stringify(saved));
    }
  }
  getKeys(){this.assertActive();return [...new Set([...this.memory.keys(),...Object.keys(this.read(this.backing)?.entries??{})])];}
  clear(){
    // An old tab must never delete a replacement session for this role.
    if(this.exists&&this.read(this.backing)?.id===this.id)this.backing?.removeItem(this.name);
    this.closed=true;this.memory.clear();
  }
}
