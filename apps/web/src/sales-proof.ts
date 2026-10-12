import {icon,transactionLink} from './presentation.js';
import {usd} from '../../../packages/protocol/src/sales-brief.js';
// Public historical fields independently verified in sales-report-purchase/verified-purchase.json.
export const verifiedSales={
  "verifiedAt": "2026-10-09T06:37:23.174Z",
  "taskId": "0x575b3a7c33d74913290c233808646af25032b2fd023f34f09c518f4013f4911e",
  "orderId": "0xc41f5cd3145202a9bdc9535ba02270642ca8450da3fca7614774f44fa87cd175",
  "dataset": [
    84250,
    91500,
    78825,
    102475,
    145000,
    168050,
    93225,
    87500,
    96050,
    110225,
    124800,
    182075,
    194550,
    108800
  ],
  "report": {
    "schemaVersion": 1,
    "datasetHash": "0xf8bd28cdd94d312084c32fc162b8f9cfa452629caac65ae16c373cdec2ac387f",
    "count": "14",
    "sum": "1667325",
    "min": "78825",
    "max": "194550"
  },
  "amount": "0.000010",
  "asset": "IPTEST",
  "period": [
    "2026-09-01",
    "2026-09-14"
  ],
  "block": "69470454",
  "payee": "0x277a497AdaD45aad29A35704EBAB207594C6979d",
  "funding": "0xfb5a0b932da20e74062c7dafe3cf47ec7045275b1588f00b6de66d9dd46b65eb",
  "delivery": "0x379617da9c562f57caff3a51af9ed7c984913420946fe340fe6ee54558a7d505",
  "votes": [
    "0x3e6c6c39a4447e4bbea329db50bb5fee5fb565d5de3b3cbd702c0a9587c54fc6",
    "0x3d06910c7abd9d47c016ada9707ed60777282efd22ef1b0be0b1e2caf0d6c4f8"
  ],
  "allocation": "0x5ce8fdd5a7389534dc54a2a980459acea08d7b23afacb742b777866a6bb9dd49",
  "payout": "0xe24abcca24dc5e2108d5f8c032feddbcda8ed70dc59784946ba28b22dd9ddc88"
} as const;

export const salesProofSection=`<section class="proof-summary"><div class="section-head"><div><span class="eyebrow">SALES REPORT / VERIFIED OCT 9, 2026</span><h2>A business brief. A settled purchase.</h2></div><span class="pill success">${icon('check')} Received by seller</span></div><p class="intro">Sample store · September 1–14, 2026 · synthetic USD revenue data.<br>Actual service purchase and settlement on Monad Testnet.</p><div class="sales-metrics">${[['Total revenue',usd(verifiedSales.report.sum)],['Days reported',verifiedSales.report.count],['Lowest daily revenue',usd(verifiedSales.report.min)],['Highest daily revenue',usd(verifiedSales.report.max)]].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><div class="proof-facts"><div><span>Seller received</span><strong>${verifiedSales.amount} IPTEST</strong><small>10 smallest units · 6 decimals</small></div><div><span>Acceptance</span><strong>2 of 3</strong><small>Both original votes verified</small></div><div><span>Order state</span><strong>ALLOCATED_PAID</strong><small>Remaining seller credit: 0</small></div><div><span>Verified block</span><strong>${verifiedSales.block}</strong><small>Historical finalized observation</small></div></div><div class="proof-timeline">${[
['Funded','Exactly 10 smallest IPTEST units entered this order.',verifiedSales.funding],
['Delivered','Four sales figures committed and recomputed from the original data.',verifiedSales.delivery],
['First acceptance','Original committee member 0 approved this delivery.',verifiedSales.votes[0]],
['Second acceptance','Original committee member 1 approved the same delivery.',verifiedSales.votes[1]],
['Settled','The payment was allocated to the original seller.',verifiedSales.allocation],
['Received','The seller withdrew the full 10 smallest IPTEST units.',verifiedSales.payout],
].map(([label,text,hash])=>`<div class="proof-step"><span class="proof-step-number">${icon('check')}</span><div><h3>${label}</h3><p>${text}</p><code>${hash}</code></div>${transactionLink(hash,'View transaction')}</div>`).join('')}</div><details class="disclosure"><summary>Review history and verification scope</summary><div class="disclosure-body"><p>The first review abstained. A new evidence version added the recomputed CSV-to-cents mapping and passed the unchanged review rule. The original budget, recipient and deadlines were preserved. An unconfirmed settlement response was reconciled against its original transaction before withdrawal; settlement was not resent.</p><p>This is one verified testnet purchase using synthetic store data. It does not certify source authenticity, uninterrupted unattended execution, production security or every integration.</p><dl class="address-list"><dt>Order</dt><dd>${verifiedSales.orderId}</dd><dt>Payee</dt><dd>${verifiedSales.payee}</dd></dl></div></details></section>`;
