import {z} from 'zod';
import {ChatPlanner,PlannerSelectionSchema} from '../packages/adapters/src/planner.js';
import {sameReleaseSource} from './release-source.js';
import {auditBytes} from './public-audit.js';

export const plannerSmokeQuoteId=`0x${'1'.repeat(64)}`;
export const plannerSmokeEvidenceId='smoke_terms';
export const plannerSmokeConfigurationNames=['PLANNER_API_URL','PLANNER_API_KEY','PLANNER_MODEL'] as const;
const codes=z.enum(['PLANNER_FINITE_SELECTION_VALIDATED','PLANNER_CONFIGURATION_MISSING','PLANNER_CONFIGURATION_INVALID',
  'PLANNER_HTTP_REJECTED','PLANNER_UNAVAILABLE','PLANNER_INPUT_TOO_LARGE','PLANNER_RESPONSE_INVALID','PLANNER_RESPONSE_TOO_LARGE',
  'PLANNER_SELECTION_OUT_OF_CATALOG','PLANNER_SMOKE_REPEAT_BLOCKED','PLANNER_SOURCE_UNAVAILABLE','PLANNER_SOURCE_CHANGED',
  'PLANNER_PRIVATE_ENV_INVALID','PLANNER_ARGUMENT_INVALID']);
export type PlannerSmokeCode=z.infer<typeof codes>;
const resultShape={status:z.enum(['PASS','BLOCKED','FAIL']),code:codes,httpStatus:z.number().int().min(100).max(599).nullable(),requestAttempts:z.union([z.literal(0),z.literal(1)]),
  missing:z.array(z.enum(plannerSmokeConfigurationNames)),selection:z.object({quoteId:z.literal(plannerSmokeQuoteId),evidenceIds:z.tuple([z.literal(plannerSmokeEvidenceId)])}).strict().nullable()};
export const PlannerSmokeResultSchema=z.object(resultShape).strict().superRefine((v,c)=>{
  const bad=()=>c.addIssue({code:'custom',message:'PLANNER_SMOKE_RESULT_INVALID'});
  if(v.status==='PASS'&&(v.code!=='PLANNER_FINITE_SELECTION_VALIDATED'||v.requestAttempts!==1||v.httpStatus===null||v.httpStatus<200||v.httpStatus>=300||v.selection===null||v.missing.length))bad();
  if(v.status!=='PASS'&&(v.code==='PLANNER_FINITE_SELECTION_VALIDATED'||v.selection!==null))bad();
  if(v.httpStatus!==null&&v.requestAttempts!==1)bad();
  if(v.code==='PLANNER_CONFIGURATION_MISSING'&&(!v.missing.length||v.requestAttempts!==0||v.httpStatus!==null||v.status!=='BLOCKED'))bad();
  if(v.code!=='PLANNER_CONFIGURATION_MISSING'&&v.missing.length)bad();
});
export type PlannerSmokeResult=z.infer<typeof PlannerSmokeResultSchema>;
const limits=[
  'One synthetic unsigned finite catalog selection only; no user task, authorization or signature is sent.',
  'No purchase, evidence-review, provider execution, chain effect or financial acceptance is proved.',
  'Configured model and endpoint are used unchanged; their values and provider bodies are not recorded.',
] as const;
export const PlannerSmokeReportSchema=z.object({schemaVersion:z.literal(1),invocationId:z.string().uuid(),scope:z.literal('REAL_PLANNER_SYNTHETIC_FINITE_SELECTION_ONLY'),
  startedAt:z.iso.datetime(),endedAt:z.iso.datetime(),source:z.unknown(),sourceStable:z.boolean(),worktreeDirty:z.boolean(),...resultShape,
  retries:z.literal(0),credentialsRecorded:z.literal(false),authorizationHeadersRecorded:z.literal(false),providerBodyRecorded:z.literal(false),
  providerReasoningRecorded:z.literal(false),privateTaskPayloadRecorded:z.literal(false),canExecute:z.literal(false),financialAcceptanceStatus:z.literal('BLOCKED'),
  signaturesRequested:z.literal(0),transactionsSent:z.literal(0),exitCode:z.union([z.literal(0),z.literal(1)]),
  limits:z.tuple([z.literal(limits[0]),z.literal(limits[1]),z.literal(limits[2])])}).strict().superRefine((v,c)=>{
  const bad=()=>c.addIssue({code:'custom',message:'PLANNER_SMOKE_REPORT_INVALID'});
  if(!PlannerSmokeResultSchema.safeParse(Object.fromEntries(Object.keys(resultShape).map(key=>[key,v[key as keyof typeof v]]))).success
    ||Date.parse(v.endedAt)<Date.parse(v.startedAt)||v.exitCode!==(v.status==='PASS'?0:1))bad();
  if(v.source!==null&&!sameReleaseSource(v.source,v.source)||v.source===null&&v.sourceStable||v.status==='PASS'&&!v.sourceStable)bad();
});
export const plannerSmokeLimits=limits;

/** No real task, quote signature, owner, authorization, salt or wallet fields. */
function syntheticState(){return Object.freeze({taskText:'Select the only unsigned synthetic smoke quote and cite its one supplied document. This is a connectivity check only.',
  policy:Object.freeze({purpose:'synthetic-connectivity-only',executionAllowed:false}),
  catalog:Object.freeze([Object.freeze({quote:Object.freeze({quoteId:plannerSmokeQuoteId,service:'synthetic-finite-selection-smoke',amount:'0',
    serviceTerms:'Unsigned synthetic test entry. No purchase or authorization is requested.'}),documents:Object.freeze([Object.freeze({id:plannerSmokeEvidenceId,
      subjectQuoteId:plannerSmokeQuoteId,text:'The only synthetic catalog entry is available solely for this finite selection connectivity check.'})])})])});}

export function plannerSmokeFailure(code:Exclude<PlannerSmokeCode,'PLANNER_FINITE_SELECTION_VALIDATED'>,requestAttempts:0|1=0,httpStatus:number|null=null):PlannerSmokeResult{
  const status=code==='PLANNER_UNAVAILABLE'||code==='PLANNER_HTTP_REJECTED'&&httpStatus!==null&&httpStatus>=500?'BLOCKED':'FAIL';
  return PlannerSmokeResultSchema.parse({status,code,httpStatus,requestAttempts,missing:[],selection:null});
}
/** Exactly one real transport attempt at most. Errors never expose their text. */
export async function runPlannerSmokeOnce(config:{endpoint?:string;key?:string;model?:string},transport:typeof fetch=fetch):Promise<PlannerSmokeResult>{
  const values=[config.endpoint,config.key,config.model],missing=plannerSmokeConfigurationNames.filter((_,i)=>!values[i]?.trim());
  if(missing.length)return PlannerSmokeResultSchema.parse({status:'BLOCKED',code:'PLANNER_CONFIGURATION_MISSING',httpStatus:null,requestAttempts:0,missing,selection:null});
  let requestAttempts:0|1=0,httpStatus:number|null=null,repeatBlocked=false,planner:ChatPlanner;
  const once:typeof fetch=async(input,init)=>{
    if(requestAttempts===1){repeatBlocked=true;throw Error('PLANNER_SMOKE_REPEAT_BLOCKED');}
    requestAttempts=1;const response=await transport(input,init);
    if(Number.isInteger(response.status)&&response.status>=100&&response.status<=599)httpStatus=response.status;
    return response;
  };
  try{planner=new ChatPlanner(config.endpoint!,config.key!,config.model!,once);}catch{return plannerSmokeFailure('PLANNER_CONFIGURATION_INVALID');}
  try{
    const selected=PlannerSelectionSchema.parse(await planner.select(syntheticState()));
    if(repeatBlocked)return plannerSmokeFailure('PLANNER_SMOKE_REPEAT_BLOCKED',requestAttempts,httpStatus);
    if(selected.quoteId.toLowerCase()!==plannerSmokeQuoteId||selected.evidenceIds.length!==1||selected.evidenceIds[0]!==plannerSmokeEvidenceId)
      return plannerSmokeFailure('PLANNER_SELECTION_OUT_OF_CATALOG',requestAttempts,httpStatus);
    return PlannerSmokeResultSchema.parse({status:'PASS',code:'PLANNER_FINITE_SELECTION_VALIDATED',httpStatus,requestAttempts,missing:[],
      selection:{quoteId:plannerSmokeQuoteId,evidenceIds:[plannerSmokeEvidenceId]}});
  }catch(error){
    let code:Exclude<PlannerSmokeCode,'PLANNER_FINITE_SELECTION_VALIDATED'>='PLANNER_RESPONSE_INVALID';
    if(repeatBlocked)code='PLANNER_SMOKE_REPEAT_BLOCKED';
    else if(httpStatus!==null&&(httpStatus<200||httpStatus>=300))code='PLANNER_HTTP_REJECTED';
    else if(error instanceof Error&&['PLANNER_INPUT_TOO_LARGE','PLANNER_RESPONSE_INVALID','PLANNER_RESPONSE_TOO_LARGE'].includes(error.message))code=error.message as typeof code;
    else if(httpStatus===null)code='PLANNER_UNAVAILABLE';
    return plannerSmokeFailure(code,requestAttempts,httpStatus);
  }
}

/** Check exact secrets and JSON escaped representations without publishing any
 * value, digest or fingerprint. No provider-controlled string is retained. */
export function assertPlannerSmokePublicBytes(bytes:Buffer,secrets:readonly string[]){
  const text=bytes.toString('utf8');
  if(auditBytes('planner-smoke.json',bytes).length||secrets.some(secret=>secret.length>0&&(bytes.includes(Buffer.from(secret))||text.includes(JSON.stringify(secret).slice(1,-1)))))
    throw Error('PLANNER_SMOKE_PUBLIC_OUTPUT_UNSAFE');
}
export function plannerSmokeReportBytes(input:unknown,secrets:readonly string[]){
  const bytes=Buffer.from(JSON.stringify(PlannerSmokeReportSchema.parse(input),null,2)+'\n');assertPlannerSmokePublicBytes(bytes,secrets);return bytes;
}
