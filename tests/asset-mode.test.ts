import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuredAssetMode,configuredAssetAddress,assetConfigurationKey} from '../packages/protocol/src/asset-mode.js';
import {integrationStatus} from '../packages/adapters/src/status.js';
import {configuredBrowserApi} from '../apps/web/src/browser-api.js';
const a=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
test('explicit demo mode never falls back to legacy official assets or identity configuration',()=>{
  const env={SETTLEMENT_ASSET_MODE:'demo-erc20',CVA_ADDRESS:a(1),CVI_VALIDATOR_ADDRESS:a(2),CVA_POLICY_ADDRESS:a(3)};
  assert.equal(configuredAssetMode(env),'demo-erc20');assert.equal(assetConfigurationKey(env),'ASSET_ADDRESS');assert.equal(configuredAssetAddress(env),undefined);
  assert.equal(configuredAssetAddress({...env,ASSET_ADDRESS:a(4)}),a(4));
  const checks=integrationStatus(env);assert.equal(checks.some(check=>check.name==='cleanverse'),false);assert.equal(checks.some(check=>check.name==='mera'),false);assert.ok(checks.find(check=>check.name==='monad-erc20')!.missing.includes('ASSET_ADDRESS'));
});
test('historical profile remains explicit and malformed mode is rejected',()=>{
  assert.equal(configuredAssetAddress({SETTLEMENT_ASSET_MODE:'cleanverse',CVA_ADDRESS:a(1),ASSET_ADDRESS:a(2)}),a(1));
  assert.throws(()=>configuredAssetMode({SETTLEMENT_ASSET_MODE:'unknown'}),{message:'ASSET_MODE_CONFIGURATION_INVALID'});
});
test('demo public configuration uses only the new asset and never exposes server application secrets',()=>{
  const env={SETTLEMENT_ASSET_MODE:'demo-erc20',PRIVY_APP_ID:'fixture-app',PRIVY_APP_SECRET:'fixture-private',MONAD_RPC_URL:'https://example.invalid',CHAIN_ID:'10143',ARBITER_ADDRESS:a(1),ASSET_ADDRESS:a(2),CVA_ADDRESS:a(90),ELIGIBILITY_GATE_ADDRESS:a(3),REVIEWER_ADDRESS:a(4),COMMITTEE_ADDRESSES:[a(5),a(6),a(7)].join(','),PRIVY_EXECUTOR_ADDRESS:a(8)};
  const api=configuredBrowserApi(env)!;assert.equal(api.configuration.recoveryDeployment?.asset,a(2));assert.ok(!JSON.stringify(api.configuration).includes(env.PRIVY_APP_SECRET));
  assert.equal(configuredBrowserApi({...env,ASSET_ADDRESS:''})!.configuration.recoveryDeployment,null);
});
