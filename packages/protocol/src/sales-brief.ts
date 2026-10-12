import {z} from 'zod';
import {keccak256,toHex} from 'viem';
import {createReport,verifyReport} from './report.js';

export const salesBriefFormat='IntentPass.SalesBrief.v1';
export const sampleSalesCsv=`date,revenue_usd
2026-09-01,842.50
2026-09-02,915.00
2026-09-03,788.25
2026-09-04,1024.75
2026-09-05,1450.00
2026-09-06,1680.50
2026-09-07,932.25
2026-09-08,875.00
2026-09-09,960.50
2026-09-10,1102.25
2026-09-11,1248.00
2026-09-12,1820.75
2026-09-13,1945.50
2026-09-14,1088.00`;

export interface SalesData {csv:string;source:'sample'|'uploaded';rows:{date:string;cents:number}[];dataset:number[];sourceHash:string;}
const fail=(message:string):never=>{throw Error(message);};
/** Fixed two-column format: no locale inference, rounding, silent row skipping or date repair. */
export function parseSalesCsv(csv:string,source:SalesData['source']='uploaded'):SalesData {
  if(csv.length>12000)fail('Use a CSV under 12 KB, with at most 90 daily rows.');
  const lines=csv.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  const cells=(line:string)=>line.split(',').map(c=>{const v=c.trim();return /^"[^"\r\n]*"$/.test(v)?v.slice(1,-1):v;});
  if(JSON.stringify(cells(lines[0]))!==JSON.stringify(['date','revenue_usd']))fail('The CSV header must be date,revenue_usd. Amounts are in US dollars.');
  if(lines.length<2||lines.length>91)fail('Include 1 to 90 daily rows.');
  let previous:number|undefined;
  const rows=lines.slice(1).map((line,i)=>{
    const row=cells(line);if(row.length!==2)fail(`Row ${i+2}: provide exactly one date and one revenue amount.`);
    const [date,amount]=row;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'2000-01-01'||date>'2099-12-31')fail(`Row ${i+2}: use a date from 2000 to 2099 in YYYY-MM-DD format.`);
    const time=Date.parse(date+'T00:00:00Z');
    if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date)fail(`Row ${i+2}: this date does not exist.`);
    if(previous!==undefined&&time-previous!==86400000)fail(`Row ${i+2}: dates must be consecutive and ascending, without duplicates. Include zero-revenue days.`);
    previous=time;
    if(!/^-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(amount))fail(`Row ${i+2}: use a decimal amount with up to two places, without currency symbols or separators.`);
    const [whole,fraction='']=amount.replace(/^-/,'').split('.');
    const cents=(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')))*(amount.startsWith('-')?-1n:1n);
    if(cents>BigInt(Number.MAX_SAFE_INTEGER)||cents<BigInt(Number.MIN_SAFE_INTEGER))fail(`Row ${i+2}: this amount exceeds the supported range.`);
    return {date,cents:Number(cents)};
  });
  return {csv,source,rows,dataset:rows.map(r=>r.cents),sourceHash:keccak256(toHex(csv))};
}

export function usd(cents:string|number|bigint){
  const n=BigInt(cents),absolute=n<0n?-n:n;
  return `${n<0n?'-':''}$${(absolute/100n).toLocaleString('en-US')}.${String(absolute%100n).padStart(2,'0')}`;
}
export const salesObjective='Purchase a commercial-use daily sales summary: reported day count, total revenue, lowest daily revenue and highest daily revenue. Recompute these four metrics from the supplied USD-cent dataset. Dates and currency describe the buyer-supplied source; source authenticity is not certified. No forecast or business recommendation is requested.';
const briefSchema=z.object({format:z.literal(salesBriefFormat),objective:z.literal(salesObjective),currency:z.literal('USD'),unit:z.literal('cents'),source:z.enum(['sample','uploaded']),sourceHash:z.string().regex(/^0x[0-9a-f]{64}$/),datasetHash:z.string().regex(/^0x[0-9a-f]{64}$/),csv:z.string().max(12000)}).strict();
const intentBriefSchema=briefSchema.extend({format:z.literal('IntentPass.SalesIntent.v1'),objective:z.string().min(10).max(2000),dataset:z.array(z.number().int().refine(Number.isSafeInteger)).min(1).max(90),sourceMapping:z.literal('Each consecutive daily revenue_usd value is converted exactly to integer USD cents, in CSV row order. The report metrics describe these daily amounts.')}).strict();
/** The user's words are retained exactly in the evidence commitment. */
export function salesIntentText(intent:string,data:SalesData){
  const verified=parseSalesCsv(data.csv,data.source),datasetHash=createReport(verified.dataset).datasetHash;
  const text=JSON.stringify(intentBriefSchema.parse({format:'IntentPass.SalesIntent.v1',objective:intent,currency:'USD',unit:'cents',source:verified.source,sourceHash:verified.sourceHash,datasetHash,csv:verified.csv,dataset:verified.dataset,sourceMapping:'Each consecutive daily revenue_usd value is converted exactly to integer USD cents, in CSV row order. The report metrics describe these daily amounts.'}));
  if(text.length>16000)fail('This intent and sales source are too large.');return text;
}
export function readSalesIntent(taskText:string){try{return intentBriefSchema.parse(JSON.parse(taskText)).objective;}catch{return undefined;}}
/** Business context remains in the existing evidence commitment; signed schemas are unchanged. */
export function salesTaskText(data:SalesData,datasetHash:string){
  const verified=parseSalesCsv(data.csv,data.source);
  if(createReport(verified.dataset).datasetHash!==datasetHash)fail('Sales source and task dataset do not match.');
  const text=JSON.stringify(briefSchema.parse({format:salesBriefFormat,objective:salesObjective,currency:'USD',unit:'cents',source:verified.source,sourceHash:verified.sourceHash,datasetHash,csv:verified.csv}));
  if(text.length>16000)fail('This sales brief is too large.');
  return text;
}
export function readSalesBrief(taskText:string,dataset:unknown):SalesData|undefined {
  try{const brief=z.union([briefSchema,intentBriefSchema]).parse(JSON.parse(taskText)),data=parseSalesCsv(brief.csv,brief.source);
    if('dataset'in brief&&JSON.stringify(brief.dataset)!==JSON.stringify(data.dataset))return undefined;
    if(data.sourceHash!==brief.sourceHash||createReport(dataset).datasetHash!==brief.datasetHash||createReport(data.dataset).datasetHash!==brief.datasetHash)return undefined;
    return data;
  }catch{return undefined;}
}
export function verifySalesDelivery(data:SalesData,report:unknown){return verifyReport(parseSalesCsv(data.csv,data.source).dataset,report);}
