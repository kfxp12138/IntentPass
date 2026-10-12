import {z} from 'zod';
import {address,positiveUint} from '../../protocol/src/schemas.js';
import {RecoveryDeploymentSchema} from '../../capsule/src/recovery.js';
import {workflowDigest} from './workflow.js';
export const GeneralAutomationProfileSchema=z.object({version:z.literal(1),mode:z.literal('general'),enabled:z.boolean().default(false),name:z.string().min(1).max(128),
  deployment:RecoveryDeploymentSchema,buyer:address,seller:address,
  maxUnitsPerOrder:positiveUint.nullable().default(null),expiresAt:positiveUint.nullable().default(null),
  deliverySeconds:positiveUint.default('1800'),settlementSeconds:positiveUint.default('3600'),grantSeconds:z.number().int().min(1).max(300).default(300),
}).strict().superRefine((p,c)=>{if(BigInt(p.settlementSeconds)<=BigInt(p.deliverySeconds)||p.buyer.toLowerCase()===p.seller.toLowerCase()||![p.buyer,p.seller].every(a=>p.deployment.committee.some(w=>w.toLowerCase()===a.toLowerCase())))c.addIssue({code:'custom',message:'GENERAL_PROFILE_INVALID'});});
export type GeneralAutomationProfile=z.infer<typeof GeneralAutomationProfileSchema>;
export function generalProfileHash(input:unknown){return workflowDigest(GeneralAutomationProfileSchema.parse(input));}
