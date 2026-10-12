import {z} from 'zod';
export const choices=['SUPPORTED','CONTRADICTED','INSUFFICIENT'] as const;
const probabilities=z.object({SUPPORTED:z.number().min(0).max(1),CONTRADICTED:z.number().min(0).max(1),INSUFFICIENT:z.number().min(0).max(1)}).strict();
const answer=z.object({type:z.literal('choice'),choice:z.enum(choices),confidence:z.number().min(0).max(1),probabilities}).strict().refine(a=>Math.abs(Object.values(a.probabilities).reduce((s,p)=>s+p,0)-1)<=0.00001&&a.probabilities[a.choice]>=Math.max(...Object.values(a.probabilities)),'invalid distribution');
export const JevResponseSchema=z.object({model:z.string().min(1).max(128),answers:z.object({service:answer,purpose:answer,provenance:answer}).strict(),usage:z.object({input_tokens:z.number().int().nonnegative(),output_tokens:z.number().int().nonnegative()})});
export type JevResult=z.infer<typeof JevResponseSchema>;
