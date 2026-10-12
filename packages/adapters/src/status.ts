import {configuredAssetMode} from '../../protocol/src/asset-mode.js';
export const requirements = {
  jev: ['TYPESAFE_API_KEY', 'JEV_MODEL'],
  planner: ['PLANNER_API_URL', 'PLANNER_API_KEY', 'PLANNER_MODEL'],
  privy: ['PRIVY_APP_ID','PRIVY_APP_SECRET','PRIVY_WALLET_ID','PRIVY_POLICY_ID'],
  cleanverse: ['MONAD_RPC_URL','CHAIN_ID','CVA_ADDRESS','CVI_ADDRESS','CLEANVERSE_ABI_PATH'],
} as const;
export function integrationStatus(env: NodeJS.ProcessEnv = process.env) {
  const selected:Record<string,readonly string[]>={...requirements};
  if(configuredAssetMode(env)==='demo-erc20'){delete selected.cleanverse;selected['monad-erc20']=['MONAD_RPC_URL','CHAIN_ID','ASSET_ADDRESS','ELIGIBILITY_GATE_ADDRESS','ARBITER_ADDRESS'];}
  return Object.entries(selected).map(([name,keys]) => ({
    name, status: 'BLOCKED' as const,
    missing: keys.filter(key => !env[key]?.trim()),
    reason: keys.some(key => !env[key]?.trim()) ? 'CONFIG_REQUIRED' : 'REAL_SMOKE_EVIDENCE_REQUIRED',
  }));
}
