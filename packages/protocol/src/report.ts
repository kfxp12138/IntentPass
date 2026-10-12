import { z } from 'zod';
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
export const datasetSchema=z.array(z.number().refine(Number.isSafeInteger,'Safe integer required')).min(1).max(10000);
export const reportSchema=z.object({schemaVersion:z.literal(1),datasetHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  count:z.string().regex(/^[1-9][0-9]*$/),sum:z.string().regex(/^(0|-?[1-9][0-9]*)$/),min:z.string().regex(/^(0|-?[1-9][0-9]*)$/),max:z.string().regex(/^(0|-?[1-9][0-9]*)$/)}).strict();
export function createReport(input:unknown) {
  const dataset=datasetSchema.parse(input),values=dataset.map(BigInt);
  return reportSchema.parse({schemaVersion:1,datasetHash:keccak256(toHex(JSON.stringify(dataset))),count:String(values.length),
    sum:values.reduce((a,b)=>a+b,0n).toString(),min:values.reduce((a,b)=>a<b?a:b).toString(),max:values.reduce((a,b)=>a>b?a:b).toString()});
}
export function reportHash(input:unknown):Hex {
  const r=reportSchema.parse(input);
  const n=(value:string)=>{const v=BigInt(value);if(v<-(2n**255n)||v>=2n**255n)throw new Error('REPORT_OVERFLOW');return v;};
  return keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'int256'},{type:'int256'},{type:'int256'}],
    [keccak256(toHex('DatasetReportV1(bytes32 datasetHash,uint256 count,int256 sum,int256 min,int256 max)')),r.datasetHash as Hex,BigInt(r.count),n(r.sum),n(r.min),n(r.max)]));
}
export function verifyReport(dataset:unknown,report:unknown):boolean {
  try{return reportHash(createReport(dataset))===reportHash(report);}catch{return false;}
}
