import {z} from 'zod';
import {address,digest} from '../../protocol/src/schemas.js';
import {RecoveryDeploymentSchema} from './recovery.js';
export const BrowserConfigurationSchema=z.object({
  privyAppId:z.string().max(128).regex(/^[A-Za-z0-9_-]+$/),
  privyClientId:z.string().max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  meraRpId:z.string().max(253).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).nullable(),
  recoveryDeployment:RecoveryDeploymentSchema.nullable(),
  purchaseRule:z.object({model:z.string().regex(/^jev-\d+\.\d+\.\d+$/),minConfidence:z.number().min(0).max(1),questionConfigHash:digest,questionVersion:z.union([z.literal(1),z.literal(2)]).optional()}).strict().nullable().optional(),
}).strict();
export const VerifiedSessionSchema=z.object({subject:z.string().min(1).max(512),wallets:z.array(address).max(128)}).strict();
export type BrowserConfiguration=z.infer<typeof BrowserConfigurationSchema>;
export type VerifiedSession=z.infer<typeof VerifiedSessionSchema>;
