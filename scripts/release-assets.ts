import {z} from 'zod';
import {isAbsolute,extname} from 'node:path';
import {isIP} from 'node:net';
const file=z.string().min(1).max(4096).refine(isAbsolute),url=z.string().max(4096).refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!isIP(u.hostname.replace(/^\[|\]$/g,''))&&!['localhost','localhost.localdomain'].includes(u.hostname)&&!u.hostname.endsWith('.localhost')&&!u.hostname.endsWith('.local')&&!u.hostname.endsWith('.internal');}catch{return false;}});
const video=z.object({localPath:file,publicUrl:url}).strict();
export const ReleaseAssetsSchema=z.object({schemaVersion:z.literal(1),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),productUrl:url.nullable(),repositoryUrl:url.nullable(),technicalVideo:video.nullable(),pitchVideo:video.nullable(),cleanverseVideo:video.nullable(),logoPath:file.nullable(),submission:z.object({publicUrl:url,receiptPath:file}).strict().nullable()}).strict();
export function videoMetadata(output:string,limit:number){try{const r=z.object({format:z.object({duration:z.string()}),streams:z.array(z.object({codec_type:z.string()}))}).parse(JSON.parse(output)),duration=Number(r.format.duration);if(!Number.isFinite(duration)||duration<=0||duration>limit||!r.streams.some(s=>s.codec_type==='video'))return null;return {durationSeconds:duration,maximumSeconds:limit};}catch{return null;}}
export function logoSize(bytes:number){return Number.isSafeInteger(bytes)&&bytes>0&&bytes<=3000000;}

/** Suffix/size metadata only; content and final submission still require actual review. */
export function logoFileMetadata(path:string,bytes:number){return logoSize(bytes)&&['.png','.jpg','.jpeg','.webp'].includes(extname(path).toLowerCase());}
