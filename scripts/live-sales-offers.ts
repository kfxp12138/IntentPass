import {randomBytes,randomUUID} from 'node:crypto';
import {DemoQuotePlanSchema} from '../packages/protocol/src/demo-quotes.js';
import {parseSalesCsv} from '../packages/protocol/src/sales-brief.js';
import {createReport} from '../packages/protocol/src/report.js';
import {termsHash} from '../packages/protocol/src/typed-data.js';
/** Unsigned supplier plan. Only the existing provider's verified wallet can
 * publish it through DemoQuoteBook. No signature, permission or purchase here. */
export function liveSalesOfferPlan(input:{csv:string;buyer:string;seller:string;asset:string;arbiter:string;now:bigint}){
  const sales=parseSalesCsv(input.csv),report=createReport(sales.dataset),expiresAt=String(input.now+86400n);
  const quote=(commercial:boolean)=>{const quoteId='0x'+randomBytes(32).toString('hex');
    const serviceTerms=`Sales report under quote ${quoteId}, sold and delivered by ${input.seller} to buyer ${input.buyer}. This offer applies to a new order for the exact dataset ${report.datasetHash}, computed as keccak256 of the canonical JSON array of integer USD cents ${JSON.stringify(sales.dataset)}. It covers ${sales.rows.length} daily sales records from ${sales.rows[0].date} to ${sales.rows.at(-1)!.date}. Each revenue_usd CSV value is converted exactly to cents in row order. The delivered report computes count, sum, min and max for this exact dataset: reported days, total revenue, lowest daily revenue and highest daily revenue. This offer may be used for a new task referencing this dataset; it does not refer to any previous order. Source authenticity is not certified. No forecast or business recommendation is included. ${commercial?'The license for this exact generated report explicitly permits commercial use and commercial redistribution, including business updates.':'This exact generated report is licensed for personal, non-commercial use only. Commercial use, business updates and commercial redistribution are prohibited.'}`;
    return {schemaVersion:1 as const,quoteId,service:'dataset-report' as const,seller:input.seller,payee:input.seller,asset:input.asset,amount:'10',serviceTerms,serviceTermsHash:termsHash(serviceTerms),expiresAt};};
  return DemoQuotePlanSchema.parse({schemaVersion:1,planId:randomUUID(),chainId:'10143',arbiter:input.arbiter,asset:input.asset,seller:input.seller,assetSymbol:'IPTEST',assetDecimals:6,quotes:[{label:'Commercial-use sales report',quote:quote(true)},{label:'Personal-use sales report',quote:quote(false)}]});
}
