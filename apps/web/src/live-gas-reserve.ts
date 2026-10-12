/** Preliminary reserve for the configured background report workflow. These are
 * the existing transaction gas limits, not estimated gas use or a fee guarantee.
 * Prices may change; the original transaction controllers remain authoritative. */
export function liveGasReserves(gasPrice:bigint,executorLimit='2000000'){
  if(gasPrice<=0n||!/^\d+$/.test(executorLimit)||BigInt(executorLimit)<21000n||BigInt(executorLimit)>5000000n)throw Error('GAS_READINESS_UNAVAILABLE');
  const limits={BUYER:400000n,SELLER:900000n,EXECUTOR:2n*BigInt(executorLimit)};
  // Buyer: approval + vote. Seller: delivery + vote + withdrawal. Executor:
  // funding + settlement. A 20% reserve is displayed as a preliminary budget.
  return Object.fromEntries(Object.entries(limits).map(([role,limit])=>[role,(limit*gasPrice*120n+99n)/100n])) as Record<keyof typeof limits,bigint>;
}
