import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {z} from 'zod';
import {OrderSnapshotSchema} from '../packages/protocol/src/escrow-read.js';
import {inspectReleaseEvidence,readStableReleaseJson} from './release-review.js';
import {Day5BrowserContextSchema,Day5PublicEvidenceSchema} from './day5-review-types.js';
import {auditBytes} from './public-audit.js';

/** Checks the recorded public snapshot's contents and stable bytes, not RPC provenance or finality. */
export function inspectDay5OrderEvidence(root:string,order:z.infer<typeof Day5BrowserContextSchema>['originalOrder'],bindings:z.infer<typeof Day5PublicEvidenceSchema>[]){
  const observation=order?.finalizedObservation;
  if(!order||!observation)throw Error('FINALIZED_OBSERVATION_REQUIRED');
  const candidates=bindings.filter(binding=>binding.sha256===observation.evidenceSha256);
  if(candidates.length!==1)throw Error('FINALIZED_OBSERVATION_EVIDENCE_MISMATCH');
  const binding=candidates[0];
  if(!binding.path.endsWith('.json')||binding.bytes>65536)throw Error('FINALIZED_OBSERVATION_JSON_REQUIRED');
  // Public path containment, symlinks, privacy and original bytes checked before
  // and after the bounded stable JSON read. Never accept an arbitrary private path.
  inspectReleaseEvidence(root,binding);
  let bytes:Buffer;
  try{bytes=readStableReleaseJson(resolve(root,binding.path));}catch(error){if(error instanceof Error&&['JSON_INVALID','JSON_DUPLICATE_KEY','JSON_DEPTH_EXCEEDED'].includes(error.message))throw Error('FINALIZED_OBSERVATION_JSON_INVALID');throw error;}
  if(bytes.length!==binding.bytes||createHash('sha256').update(bytes).digest('hex')!==binding.sha256||auditBytes(binding.path,bytes).length)throw Error('FINALIZED_OBSERVATION_BYTES_INVALID');
  let snapshot:z.infer<typeof OrderSnapshotSchema>;
  try{snapshot=OrderSnapshotSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw Error('FINALIZED_OBSERVATION_JSON_INVALID');}
  const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(snapshot.chainId!=='10143'||!eq(snapshot.arbiter,order.escrow)||!eq(snapshot.orderId,order.orderId)||!eq(snapshot.contextHash,order.contextHash)||snapshot.block.number!==observation.blockNumber||!eq(snapshot.block.hash,observation.blockHash)||snapshot.state!==observation.state)throw Error('FINALIZED_OBSERVATION_CONTEXT_MISMATCH');
  inspectReleaseEvidence(root,binding);
  return binding;
}
