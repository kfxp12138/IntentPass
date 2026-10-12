export function icon(name:string){
  const paths:Record<string,string>={
    overview:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    task:'<path d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="5"/>',
    automation:'<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
    review:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    orders:'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    proof:'<path d="M14 3h7v7M21 3l-9 9"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    setup:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 13h5M7 5V3h10"/>',
    recovery:'<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6"/><path d="M12 7v5l3 2"/>',
    arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',
    spark:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    code:'<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>',
    data:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',
    shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??paths.orders}</svg>`;
}
export const brandMark='<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M7 4h13l5 5v19H7V4Z" fill="currentColor"/><path d="M12 15h8m-8 5 3 3 6-7" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 4v6h5" stroke="white" stroke-opacity=".6" stroke-width="1.5"/></svg>';
export function escapeHtml(value:unknown){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export const monadExplorer='https://testnet.monadexplorer.com';
export function transactionLink(hash:unknown,label:string){
  return typeof hash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(hash)?`<a class="proof-link" href="${monadExplorer}/tx/${hash}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ${icon('proof')}</a>`:'';
}
