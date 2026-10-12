import type {IncomingMessage,ServerResponse} from 'node:http';
import {constants} from 'node:fs';
import {open,realpath,stat} from 'node:fs/promises';
import {extname,isAbsolute,join,relative,resolve,sep} from 'node:path';

export class WebPathRejected extends Error {
  constructor(readonly status:400|403){super('WEB_PATH_REJECTED');}
}
/** Decode once before URL normalization can hide traversal; no filesystem paths in errors. */
export function webRequestPath(url:string|undefined):string {
  const raw=(url??'/').split('?')[0];let path:string;
  try{path=decodeURIComponent(raw);}catch{throw new WebPathRejected(400);}
  if(!path.startsWith('/')||path.startsWith('//')||/[\\%#\u0000-\u001f\u007f]/.test(path))throw new WebPathRejected(400);
  if(path.split('/').some(part=>part==='.'||part==='..'))throw new WebPathRejected(403);
  return path;
}
const privateFile=(path:string)=>path.split(/[\\/]/).some(part=>/^\.env(?:\.|$)/i.test(part)||/\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(part)||/\.(?:pem|crt)$/i.test(part)||part==='.git');
export const privateFsDeny=['.env','.env.*','*.{crt,pem}','**/.git/**','**/*.{db,sqlite,sqlite3}','**/*.{db,sqlite,sqlite3}-*'];
/** Block filenames before Vite, and resolve aliases so a public symlink cannot expose a DB. */
export async function privateDevelopmentFile(path:string,webRoot:string):Promise<boolean> {
  if(privateFile(path))return true;
  const candidate=path.startsWith('/@fs/')?resolve('/',path.slice('/@fs/'.length)):resolve(webRoot,`.${path}`);
  try{return privateFile(await realpath(candidate));}catch{return false;}
}
const within=(root:string,file:string)=>{const r=relative(root,file);return r!==''&&!isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`);};
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.wasm':'application/wasm'};
const developmentPath=(path:string)=>/^\/(?:@[^/]*|src|packages|apps|node_modules|contracts|scripts|tests)(?:\/|$)/.test(path);
function reject(res:ServerResponse,status:number){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({code:status===403?'WEB_FILE_ACCESS_DENIED':status===405?'METHOD_NOT_ALLOWED':'NOT_FOUND'}));}

/** Production serves only built public assets. Vite is never constructed or mounted. */
export async function productionWeb(distDirectory:string) {
  let root:string;
  try{root=await realpath(distDirectory);if(!(await stat(root)).isDirectory())throw new Error();const index=await realpath(join(root,'index.html'));if(!within(root,index)||!(await stat(index)).isFile())throw new Error();}
  catch{throw new Error('PRODUCTION_BUILD_REQUIRED');}
  return async(req:IncomingMessage,res:ServerResponse,path:string)=>{
    if(req.method!=='GET'&&req.method!=='HEAD')return reject(res,405);
    if(privateFile(path)||path.split('/').some(part=>part.startsWith('.')))return reject(res,403);
    if(developmentPath(path))return reject(res,404);
    let file=path==='/'?join(root,'index.html'):resolve(root,`.${path}`),extension=extname(file).toLowerCase();
    if(!within(root,file))return reject(res,403);
    const navigation=path!=='/'&&!path.startsWith('/assets/')&&!extension&&(req.headers.accept??'').split(',').some(value=>value.trim().split(';')[0]==='text/html');
    if(navigation){file=join(root,'index.html');extension='.html';}
    if(!mime[extension]||extension==='.html'&&file!==join(root,'index.html'))return reject(res,404);
    let actual:string;
    try{actual=await realpath(file);}catch{return reject(res,404);}
    if(!within(root,actual)||privateFile(actual))return reject(res,403);
    let handle;
    try{handle=await open(actual,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()){await handle.close();return reject(res,404);}
      const immutable=path.startsWith('/assets/')&&/-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path);
      res.writeHead(200,{'Content-Type':mime[extension],'Content-Length':String(info.size),'Cache-Control':extension==='.html'?'no-store':immutable?'public, max-age=31536000, immutable':'no-cache'});
      if(req.method==='HEAD'){await handle.close();res.end();return;}
      const stream=handle.createReadStream();stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
    }catch{if(handle)await handle.close().catch(()=>{});if(res.headersSent)res.destroy();else reject(res,404);}
  };
}
