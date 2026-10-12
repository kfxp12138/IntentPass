export type AssetMode='demo-erc20'|'cleanverse';
/** An unset mode preserves old release reproduction. New environments explicitly
 * select demo-erc20; there is no fallback from a demo asset to historical CVA. */
export function configuredAssetMode(env:NodeJS.ProcessEnv):AssetMode{
  const mode=env.SETTLEMENT_ASSET_MODE;
  if(mode===undefined||mode==='cleanverse')return 'cleanverse';
  if(mode==='demo-erc20')return mode;
  throw Error('ASSET_MODE_CONFIGURATION_INVALID');
}
export function assetConfigurationKey(env:NodeJS.ProcessEnv){return configuredAssetMode(env)==='demo-erc20'?'ASSET_ADDRESS':'CVA_ADDRESS';}
export function configuredAssetAddress(env:NodeJS.ProcessEnv){return env[assetConfigurationKey(env)];}
