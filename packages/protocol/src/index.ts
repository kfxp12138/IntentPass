export * from './review-evidence.js';
import { z } from 'zod';
import { hashStruct, hashTypedData, type Address, type Hex } from 'viem';
export * from './typed-data.js';
export * from './escrow.js';
export * from './report.js';
export * from './route.js';
export * from './escrow-read.js';
export * from './escrow-abi.js';
export * from './original-order-read.js';
export * from './evidence-version.js';

export * from './schemas.js';
export {OriginalCandidateSchema,ReceiptRecoveryRequestSchema,ReceiptRecoveryResponseSchema} from './receipt-recovery.js';
import { IntentEnvelopeSchema, digest, type IntentEnvelope } from './schemas.js';
import {OrderSnapshotSchema,type OrderSnapshot} from './escrow-read.js';
import {verifyOriginalOrderReadProof,OriginalOrderReadResponseSchema,checkOriginalOrderReadSnapshot,type OriginalOrderReadDeployment} from './original-order-read.js';

// Every Intent member is static ABI data. The Solidity reference uses the same order.
export const intentFields = [
  ['schemaVersion','uint256'], ['chainId','uint256'], ['arbiter','address'], ['orderId','bytes32'],
  ['taskId','bytes32'], ['attempt','uint256'], ['buyer','address'], ['seller','address'],
  ['payee','address'], ['asset','address'], ['price','uint256'], ['bond','uint256'],
  ['datasetHash','bytes32'], ['serviceTermsHash','bytes32'], ['purchaseEvidenceCommitment','bytes32'],
  ['policyHash','bytes32'], ['reviewer','address'], ['committeeHash','bytes32'], ['threshold','uint256'],
  ['deliverySchemaHash','bytes32'], ['deliveryDeadline','uint256'], ['settlementDeadline','uint256'],
  ['allocationPolicyHash','bytes32'], ['intentReleasePolicyHash','bytes32'], ['pactPaymentPublicKeyHash','bytes32'],
].map(([name,type]) => ({name,type}));
export const intentTypes = { IntentEnvelope: intentFields };
export function intentMessage(input: unknown) {
  const e = IntentEnvelopeSchema.parse(input);
  return Object.fromEntries(intentFields.map(({name,type}) => [name,
    type === 'uint256' ? BigInt(e[name as keyof IntentEnvelope]) : e[name as keyof IntentEnvelope],
  ]));
}
export function contextHash(input: unknown): Hex {
  return hashStruct({ data: intentMessage(input), types: intentTypes, primaryType: 'IntentEnvelope' });
}
export function intentSigningHash(input: unknown): Hex {
  const e = IntentEnvelopeSchema.parse(input);
  return hashTypedData({ domain: { name: 'IntentPass.Intent', version: '1', chainId: BigInt(e.chainId), verifyingContract: e.arbiter as Address },
    types: intentTypes, primaryType: 'IntentEnvelope', message: intentMessage(e) });
}
export const semanticKeys = ['service', 'purpose', 'provenance'] as const;
export const SemanticResultsSchema = z.object({
  service: z.enum(['SUPPORTED','CONTRADICTED','INSUFFICIENT']),
  purpose: z.enum(['SUPPORTED','CONTRADICTED','INSUFFICIENT']),
  provenance: z.enum(['SUPPORTED','CONTRADICTED','INSUFFICIENT']),
}).strict();
export function aggregateReview(input: unknown): 'PASS' | 'ABSTAIN' | 'REJECT' {
  const result = SemanticResultsSchema.safeParse(input);
  if (!result.success) return 'ABSTAIN';
  const values = Object.values(result.data);
  if (values.includes('CONTRADICTED')) return 'REJECT';
  if (values.includes('INSUFFICIENT')) return 'ABSTAIN';
  return 'PASS';
}

export class IntentPassClient {
  constructor(readonly baseUrl: string, readonly token?: string,readonly transport:typeof fetch=fetch) {}
  async originalOrder(input:unknown,deployment:OriginalOrderReadDeployment):Promise<OrderSnapshot> {
    const proof=await verifyOriginalOrderReadProof(input,deployment);
    const response=await this.transport.call(globalThis,new URL(`/api/orders/${proof.intent.orderId}/read-original`,this.baseUrl),{method:'POST',headers:{'Content-Type':'application/json',...(this.token?{Authorization:`Bearer ${this.token}`}:{})},body:JSON.stringify(proof),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`HTTP_${response.status}`);
    const reader=response.body?.getReader();if(!reader)throw new Error('ORDER_READ_RESPONSE_INVALID');const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new Error('ORDER_READ_RESPONSE_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const result=OriginalOrderReadResponseSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if('status'in result)throw new Error(result.code);return checkOriginalOrderReadSnapshot(proof,result);
  }
  async health() {
    const response = await this.transport.call(globalThis,new URL('/health', this.baseUrl));
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  }
  async order(id: string):Promise<OrderSnapshot> {
    digest.parse(id);
    const response = await this.transport.call(globalThis,new URL(`/api/orders/${id}`, this.baseUrl), {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const order=OrderSnapshotSchema.parse(await response.json()) as OrderSnapshot;
    if(order.orderId.toLowerCase()!==id.toLowerCase())throw new Error('ORDER_RESPONSE_MISMATCH');return order;
  }
}
