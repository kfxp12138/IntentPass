import {z} from 'zod';
import {address,SignedQuoteSchema} from './schemas.js';
import {termsHash} from './typed-data.js';
export const UnsignedDemoQuoteSchema=SignedQuoteSchema.omit({signature:true});
export type UnsignedDemoQuote=z.infer<typeof UnsignedDemoQuoteSchema>;
export const DemoQuotePlanSchema=z.object({schemaVersion:z.literal(1),planId:z.uuid(),chainId:z.literal('10143'),arbiter:address,asset:address,seller:address,assetSymbol:z.literal('IPTEST'),assetDecimals:z.literal(6),quotes:z.tuple([
  z.object({label:z.enum(['完整报告许可','Commercial-use sales report']),quote:UnsignedDemoQuoteSchema}).strict(),
  z.object({label:z.enum(['仅代码许可','Personal-use sales report']),quote:UnsignedDemoQuoteSchema}).strict(),
])}).strict().superRefine((p,c)=>{
  if(p.quotes[0].quote.quoteId.toLowerCase()===p.quotes[1].quote.quoteId.toLowerCase())c.addIssue({code:'custom',message:'DUPLICATE_QUOTE'});
  for(const {quote:q} of p.quotes)if(q.seller.toLowerCase()!==p.seller.toLowerCase()||q.payee.toLowerCase()!==p.seller.toLowerCase()||q.asset.toLowerCase()!==p.asset.toLowerCase()||q.amount!=='10'||q.serviceTermsHash.toLowerCase()!==termsHash(q.serviceTerms).toLowerCase())c.addIssue({code:'custom',message:'QUOTE_SCOPE_MISMATCH'});
});
export type DemoQuotePlan=z.infer<typeof DemoQuotePlanSchema>;
export const DemoQuoteStatusSchema=z.object({plan:DemoQuotePlanSchema,canSign:z.boolean(),quotes:z.array(z.object({quoteId:UnsignedDemoQuoteSchema.shape.quoteId,status:z.enum(['UNSIGNED','RESERVED','SIGNED']),expired:z.boolean()}).strict()).length(2),catalogReady:z.boolean()}).strict();
