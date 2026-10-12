import {MemoryPayloadSchema} from '../../../packages/capsule/src/format.js';
import {createReport} from '../../../packages/protocol/src/report.js';
import {parseSalesCsv,readSalesBrief,salesTaskText,sampleSalesCsv,usd,verifySalesDelivery,type SalesData} from '../../../packages/protocol/src/sales-brief.js';
import type {TaskSourceAdapter} from './task-ui.js';

export const salesSourceControls=`<div id="sales-source"><label>What are you buying?<select id="task-source-mode"><option value="sales">Commercial-use sales report</option><option value="numeric">Raw numeric report (advanced)</option></select></label><div id="sales-input"><p class="hint">For a store owner preparing a business update. Supply daily revenue, then procure a report you can reuse commercially.</p><div class="sales-source-actions"><div><button type="button" id="sales-import" class="button-secondary">Choose sales CSV</button><input id="sales-file" type="file" accept=".csv,text/csv" aria-label="Sales CSV file" hidden></div><button type="button" id="sales-sample" class="button-secondary">Use sample store</button></div><label>Daily revenue CSV<textarea id="sales-csv" rows="6" spellcheck="false" aria-describedby="sales-source-note">${sampleSalesCsv}</textarea><small>Columns: date,revenue_usd · 1–90 consecutive daily rows · USD with up to two decimal places · 12 KB maximum.</small></label><p id="sales-source-note" class="hint">Sample store · synthetic data. Edit or import your own CSV. Use date,revenue_usd, consecutive dates and amounts with up to two decimal places. Negative net revenue and zero-sales days are supported.</p><p id="sales-error" role="status" aria-live="polite"></p><div id="sales-preview"></div></div></div>`;

export function salesSummary(data:SalesData){
  const report=createReport(data.dataset);
  return `<div class="sales-summary"><div class="section-head"><div><span class="eyebrow">${data.source==='sample'?'SAMPLE STORE · SYNTHETIC DATA':'YOUR SALES DATA'}</span><h3>Sales report preview</h3><p>${data.rows[0].date} — ${data.rows.at(-1)!.date} · USD</p></div><span class="pill outline">Computed locally</span></div><div class="sales-metrics">${[['Total revenue',usd(report.sum)],['Days reported',report.count],['Lowest day',usd(report.min)],['Highest day',usd(report.max)]].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div></div>`;
}

function reportPreview(data:SalesData){
  const peak=Math.max(1,...data.dataset.map(Math.abs));
  return `${salesSummary(data)}<div class="sales-chart" role="img" aria-label="Daily revenue bars. Exact values are available in the data table below.">${data.rows.map(r=>`<div title="${r.date}: ${usd(r.cents)}"><i class="${r.cents<0?'negative':''}" style="height:${Math.max(2,Math.abs(r.cents)/peak*100)}%"></i></div>`).join('')}</div><p class="hint">Daily revenue magnitude · negative values shown in amber. This preview checks arithmetic, not the authenticity of the sales source.</p><details class="disclosure"><summary>Daily figures and report download</summary><div class="sales-table-wrap"><table><thead><tr><th>Date</th><th>Net revenue (USD)</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td>${r.date}</td><td>${usd(r.cents)}</td></tr>`).join('')}</tbody></table></div><button type="button" id="sales-download" class="button-secondary">Download preview report</button></details><div class="sales-check"><strong>What if the seller returns the wrong total?</strong><p>Try the local acceptance check. These examples do not call JEV, sign an order or send funds.</p><button type="button" id="sales-check-correct" class="button-secondary">Check matching report</button><button type="button" id="sales-check-wrong" class="button-secondary">Try a wrong total</button><p id="sales-check-result" role="status" aria-live="polite"></p></div>`;
}

export function salesReportHtml(data:SalesData){
  const report=createReport(data.dataset);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sales report preview — IntentPass</title><style>body{max-width:850px;margin:60px auto;padding:24px;font:16px/1.6 system-ui;color:#16233a}h1{font-size:40px}.sales-metrics{display:grid;grid-template-columns:1fr 1fr;gap:24px}.sales-metrics span,.sales-metrics strong{display:block}strong{font-size:24px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #ddd;padding:9px}code{overflow-wrap:anywhere}small{color:#53647c}</style><h1>Sales report preview</h1><p>Prepared locally in IntentPass. This file is an unsigned preview, not a seller delivery, license grant or payment receipt.</p>${salesSummary(data)}<h2>Daily revenue</h2><table><tr><th>Date</th><th>USD</th></tr>${data.rows.map(r=>`<tr><td>${r.date}</td><td>${usd(r.cents)}</td></tr>`).join('')}</table><h2>Verification scope</h2><p>Day count, total, minimum and maximum are recomputed from the supplied revenue values. Revenue is encoded as integer USD cents. Source authenticity, profit and forecasts are outside this report.</p><p>Source: ${data.source==='sample'?'Synthetic example':'User-supplied CSV'}<br>Source digest: <code>${data.sourceHash}</code><br>Dataset digest: <code>${report.datasetHash}</code></p><small>Report purchase fees are paid separately in IPTEST on Monad Testnet. Revenue amounts here are USD, not token balances.</small></html>`;
}

export function attachSalesSource(current:unknown,locked:()=>boolean):TaskSourceAdapter {
  const root=document.querySelector<HTMLElement>('#sales-source')!,mode=document.querySelector<HTMLSelectElement>('#task-source-mode')!,csv=document.querySelector<HTMLTextAreaElement>('#sales-csv')!,file=document.querySelector<HTMLInputElement>('#sales-file')!,preview=document.querySelector<HTMLElement>('#sales-preview')!,error=document.querySelector<HTMLElement>('#sales-error')!,note=document.querySelector<HTMLElement>('#sales-source-note')!,numeric=document.querySelector<HTMLElement>('#numeric-input')!;
  const memory=MemoryPayloadSchema.safeParse({schemaVersion:1,kind:'memory',...(current&&typeof current==='object'?current:{})});
  const restored=memory.success&&memory.data.taskInput?readSalesBrief(memory.data.evidence.taskText,memory.data.taskInput.dataset):undefined;
  let source:SalesData['source']=restored?.source??'sample',revision=0,fileProblem='',reading=false;
  if(restored)csv.value=restored.csv;else if(memory.success)mode.value='numeric';
  const read=()=>{if(reading||fileProblem)throw Error(fileProblem||'Wait for the selected CSV to finish loading.');return parseSalesCsv(csv.value,source);};
  const paint=()=>{
    document.querySelector<HTMLElement>('#sales-input')!.hidden=mode.value!=='sales';numeric.hidden=mode.value==='sales';preview.replaceChildren();error.textContent='';
    if(mode.value!=='sales')return;
    note.textContent=source==='sample'?'Sample store · synthetic data. This is a preview, not a completed purchase.':'User-supplied CSV · processed locally until you request evidence review or submit procurement.';
    try{const data=read();preview.innerHTML=reportPreview(data);
      const check=(wrong:boolean)=>{const report=createReport(data.dataset),candidate=wrong?{...report,sum:String(BigInt(report.sum)+10000n)}:report;
        const matches=verifySalesDelivery(data,candidate),result=document.querySelector<HTMLElement>('#sales-check-result')!;
        result.textContent=matches?'Metrics match the supplied data. A real order still requires signed delivery, committee acceptance and settlement.':`Mismatch: the supplied report claims ${usd(candidate.sum)}; the data totals ${usd(report.sum)}. This report fails the local acceptance check.`;
        result.className=matches?'sales-result-match':'sales-result-mismatch';};
      document.querySelector('#sales-check-correct')!.addEventListener('click',()=>check(false));document.querySelector('#sales-check-wrong')!.addEventListener('click',()=>check(true));
      document.querySelector('#sales-download')!.addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([salesReportHtml(data)],{type:'text/html;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='intentpass-sales-report-preview.html';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
    }catch(e){error.textContent=e instanceof Error?e.message:'Check the CSV format.';}
  };
  document.querySelector('#sales-import')!.addEventListener('click',()=>{if(!locked())file.click();});
  mode.addEventListener('change',()=>{revision++;reading=false;paint();});csv.addEventListener('input',()=>{revision++;reading=false;fileProblem='';source='uploaded';paint();});
  document.querySelector('#sales-sample')!.addEventListener('click',()=>{if(locked())return;revision++;reading=false;fileProblem='';source='sample';csv.value=sampleSalesCsv;paint();});
  file.addEventListener('change',()=>{if(locked())return;const selected=file.files?.[0];if(!selected)return;const version=++revision;
    if(selected.size>12000){reading=false;fileProblem='Use a CSV under 12 KB. Choose another file, edit the CSV or restore the sample.';paint();file.value='';return;}
    reading=true;fileProblem='';paint();
    void selected.text().then(text=>{if(!root.isConnected||locked()||version!==revision)return;parseSalesCsv(text);reading=false;source='uploaded';csv.value=text;paint();}).catch(e=>{if(root.isConnected&&!locked()&&version===revision){reading=false;fileProblem=(e instanceof Error?e.message:'The file could not be read.')+' Choose another file, edit the CSV or restore the sample.';paint();}});});
  paint();
  return {read:()=>{if(mode.value!=='sales')return undefined;const data=read();return {dataset:data.dataset,describe:hash=>salesTaskText(data,hash)};},lock:value=>{for(const element of Array.from(root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input,textarea,select,button')))element.disabled=value;}};
}
