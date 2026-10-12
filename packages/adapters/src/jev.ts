import { z } from 'zod';
import { semanticKeys } from '../../protocol/src/index.js';
const choice=z.object({type:z.literal('choice'),choice:z.enum(['SUPPORTED','CONTRADICTED','INSUFFICIENT']),confidence:z.number().min(0).max(1)});
const responseSchema=z.object({model:z.string().min(1),answers:z.object({service:choice,purpose:choice,provenance:choice})});
const criteria={SUPPORTED:'The supplied evidence explicitly supports this requirement for the current report.',CONTRADICTED:'The supplied evidence explicitly contradicts this requirement.',INSUFFICIENT:'Evidence is missing, unrelated, ambiguous, or does not establish the requirement.'};
export async function jevSmoke(key: string, model: string) {
  const started=performance.now();
  // Public synthetic text solely for connectivity. Never an executable review receipt.
  const response=await fetch('https://api.typesafe.ai/v1/systemone',{
    method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20_000),
    body:JSON.stringify({model,state:'TEST ONLY: Report R1 computes count, sum, min, max of dataset D1. The seller explicitly grants commercial use of report R1. This signed statement concerns report R1 only.',questions:Object.fromEntries(semanticKeys.map(name=>[name,{type:'choice',instructions:{service:'Does the current report provide count, sum, min and max for dataset D1?',purpose:'Does the statement explicitly permit commercial use of the current report?',provenance:'Does this evidence concern the current report R1 rather than another product?'}[name],criteria}]))}),
  });
  if(!response.ok) throw new Error(`JEV_HTTP_${response.status}`);
  const parsed=responseSchema.safeParse(await response.json());
  if(!parsed.success) throw new Error('JEV_RESPONSE_INVALID');
  return {kind:'REAL_CONNECTIVITY_SMOKE_NOT_EXECUTABLE_RECEIPT',model:parsed.data.model,answers:parsed.data.answers,durationMs:Math.round(performance.now()-started)};
}
