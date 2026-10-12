/** Validate the optional loopback operator port before any build or RPC work. */
export function configuredMetaMaskOperatorPort(raw:unknown):number {
  if(raw===undefined||raw==='')return 0;
  if(typeof raw!=='string'||!/^[1-9][0-9]{3,4}$/.test(raw)||Number(raw)<1024||Number(raw)>65535)
    throw new Error('METAMASK_OPERATOR_PORT_INVALID');
  return Number(raw);
}
