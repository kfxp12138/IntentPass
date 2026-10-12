import { z } from 'zod';
import { hashStruct, hashTypedData, keccak256, toHex, verifyTypedData, type Address, type Hex } from 'viem';
import { address, positiveUint, TaskPolicySchema, SignedQuoteSchema, DecisionReceiptSchema, CapabilityGrantSchema } from './schemas.js';

const deploymentSchema = z.object({ chainId: positiveUint, arbiter: address }).strict();
export type DeploymentDomain = z.infer<typeof deploymentSchema>;
export const UnsignedQuoteSchema = SignedQuoteSchema.omit({ signature: true });
export const UnsignedReceiptSchema = DecisionReceiptSchema.omit({ signature: true });
const fields = (pairs: [string, string][]) => pairs.map(([name, type]) => ({ name, type }));
export const policyTypes = { TaskPolicy: fields([
  ['schemaVersion','uint256'], ['taskId','bytes32'], ['datasetHash','bytes32'],
  ['action','string'], ['metrics','string[4]'], ['purpose','string'], ['budget','uint256'],
  ['allowedAsset','address'], ['requiredFacts','string[3]'], ['version','uint256'],
]) };
export const quoteTypes = { SignedQuote: fields([
  ['schemaVersion','uint256'], ['quoteId','bytes32'], ['service','string'],
  ['seller','address'], ['payee','address'], ['asset','address'], ['amount','uint256'],
  ['serviceTermsHash','bytes32'], ['expiresAt','uint256'],
]) };
export const receiptTypes = { DecisionReceipt: fields([
  ['schemaVersion','uint256'], ['contextHash','bytes32'], ['purchaseEvidenceCommitment','bytes32'],
  ['policyHash','bytes32'], ['reviewer','address'], ['modelId','string'],
  ['questionConfigHash','bytes32'], ['decision','string'], ['expiresAt','uint256'],
]) };
export const grantTypes = { CapabilityGrant: fields([
  ['schemaVersion','uint256'], ['owner','address'], ['executor','address'], ['chainId','uint256'],
  ['arbiter','address'], ['orderId','bytes32'], ['asset','address'], ['amount','uint256'],
  ['contextHash','bytes32'], ['preparationHash','bytes32'], ['receiptHash','bytes32'],
  ['nonce','uint256'], ['deadline','uint256'], ['maxUses','uint256'],
]) };
function domain(name: 'Quote' | 'Receipt' | 'Grant', input: DeploymentDomain) {
  const d = deploymentSchema.parse(input);
  return { name: `IntentPass.${name}`, version: '1', chainId: BigInt(d.chainId), verifyingContract: d.arbiter as Address };
}
function message(input: Record<string, unknown>, members: {name:string;type:string}[]) {
  return Object.fromEntries(members.map(({name,type}) => [name, type === 'uint256' ? BigInt(String(input[name])) : input[name]]));
}

/** Policy commitment uses EIP-712 array/string encoding, not JSON serialization order. */
export function policyHash(input: unknown): Hex {
  const p = TaskPolicySchema.parse(input);
  return hashStruct({data:message(p,policyTypes.TaskPolicy),types:policyTypes,primaryType:'TaskPolicy'});
}
/** Exact UTF-8 text; whitespace or Unicode changes require a new quote. */
export function termsHash(text: string): Hex {
  return keccak256(toHex(z.string().min(1).max(16000).parse(text)));
}
export function quoteTypedData(input: unknown, deployment: DeploymentDomain) {
  const q = UnsignedQuoteSchema.parse(input);
  if (termsHash(q.serviceTerms).toLowerCase() !== q.serviceTermsHash.toLowerCase()) throw new Error('QUOTE_TERMS_MISMATCH');
  return {domain:domain('Quote',deployment),types:quoteTypes,primaryType:'SignedQuote' as const,message:message(q,quoteTypes.SignedQuote)};
}
export function quoteSigningHash(input: unknown, deployment: DeploymentDomain): Hex {
  return hashTypedData(quoteTypedData(input,deployment));
}
export async function verifyQuoteSignature(input: unknown, deployment: DeploymentDomain): Promise<boolean> {
  try {
    const q=SignedQuoteSchema.parse(input);
    const {signature,...unsigned}=q;
    return await verifyTypedData({...quoteTypedData(unsigned,deployment),address:q.seller as Address,signature:signature as Hex});
  } catch { return false; }
}
export function receiptTypedData(input: unknown, deployment: DeploymentDomain) {
  const r=UnsignedReceiptSchema.parse(input);
  return {domain:domain('Receipt',deployment),types:receiptTypes,primaryType:'DecisionReceipt' as const,message:message(r,receiptTypes.DecisionReceipt)};
}
/** Commitment referenced by Grant; includes chain and arbiter through the signing domain. */
export function receiptHash(input: unknown, deployment: DeploymentDomain): Hex {
  return hashTypedData(receiptTypedData(input,deployment));
}
export async function verifyReceiptSignature(input: unknown, deployment: DeploymentDomain): Promise<boolean> {
  try {
    const r=DecisionReceiptSchema.parse(input);
    const {signature,...unsigned}=r;
    return await verifyTypedData({...receiptTypedData(unsigned,deployment),address:r.reviewer as Address,signature:signature as Hex});
  } catch { return false; }
}
export function grantTypedData(input: unknown) {
  const g=CapabilityGrantSchema.parse(input);
  return {domain:domain('Grant',{chainId:g.chainId,arbiter:g.arbiter}),types:grantTypes,primaryType:'CapabilityGrant' as const,message:message(g,grantTypes.CapabilityGrant)};
}
export function grantSigningHash(input: unknown): Hex {
  return hashTypedData(grantTypedData(input));
}
export async function verifyGrantSignature(input: unknown, signature: Hex): Promise<boolean> {
  try {
    const g=CapabilityGrantSchema.parse(input);
    return await verifyTypedData({...grantTypedData(g),address:g.owner as Address,signature});
  } catch { return false; }
}
// These helpers verify EOA signature provenance only. Expiry, policy binding, on-chain
// nonce consumption/revocation, CVI and PACT preparation must still be enforced.
