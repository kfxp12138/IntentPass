import {createHash} from 'node:crypto';
import {JsonValueSchema,type JsonValue} from '../../protocol/src/workflow-api.js';
export * from '../../protocol/src/workflow-api.js';
export function canonicalJson(input:unknown):string{const value=JsonValueSchema.parse(input);const sort=(v:JsonValue):JsonValue=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;return JSON.stringify(sort(value));}
export function workflowDigest(input:unknown){return createHash('sha256').update(canonicalJson(input)).digest('hex');}
