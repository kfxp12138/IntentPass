import test from 'node:test';
import assert from 'node:assert/strict';
import type {PrivyClient} from '@privy-io/node';
import {keccak256,toHex} from 'viem';
import {escrowPolicy} from '../packages/adapters/src/privy-sender.js';
import {receiptPolicy} from '../packages/adapters/src/privy-receipt-signer.js';
import {preparePrivyRoles,inspectPrivyRoles,parsePrivyRoleConfiguration,privyRoleReadPort,PrivyRolePreparationError,
  type PrivyRoleConfiguration,type PrivyRoleReadPort} from '../scripts/privy-role-preparation.js';
import {runPrivyRolePreparation,privyRolePublicConfigurationNames,type PrivyRolePreparationRuntime} from '../scripts/prepare-privy-roles.js';
import type {ReleaseSourceSnapshot} from '../scripts/release-source.js';

// In-memory wallet/policy/source/activated-review doubles only. These tests never
// load dotenv, a real review policy, a compiler, a provider, an auth key, or a wallet.
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const config:PrivyRoleConfiguration={assetMode:'demo-erc20',chainId:'10143',arbiter:a(20),
  executor:{address:a(1),walletId:'local-executor-wallet',policyId:'local-executor-policy',signerId:'local-executor-signer'},
  reviewer:{address:a(2),walletId:'local-reviewer-wallet',policyId:'local-reviewer-policy',signerId:'local-reviewer-signer'},
  model:'jev-0.1.0',questionConfigHash:h(4)};
const source:ReleaseSourceSnapshot={sourceCommit:'a'.repeat(40),bindings:[{path:'scripts/privy-role-preparation.ts',bytes:100,sha256:'1'.repeat(64)}]};
const clone=<T>(value:T)=>structuredClone(value);
const semantics=(rules:{method:string;action:string;conditions:unknown[]}[])=>rules.map(({method,action,conditions})=>({method,action,conditions}));
function fixture(input=config){
  const prepared=preparePrivyRoles(input);
  const wallets=Object.fromEntries((['executor','reviewer'] as const).map(role=>[input[role].walletId,{id:input[role].walletId,address:input[role].address,
    chain_type:'ethereum',owner_id:input[role].signerId as string|null,policy_ids:[input[role].policyId],
    additional_signers:[] as {signer_id:string;override_policy_ids?:string[]}[],archived_at:null as number|null,
    private_provider_metadata:'LOCAL_PROVIDER_BODY_NOT_FOR_PUBLIC_OUTPUT'}]));
  const policies=Object.fromEntries((['executor','reviewer'] as const).map(role=>[input[role].policyId,{id:input[role].policyId,
    ...clone(prepared.roles[role].policyBlueprint),private_provider_metadata:'LOCAL_PROVIDER_BODY_NOT_FOR_PUBLIC_OUTPUT'}]));
  const calls:{kind:'wallet'|'policy';id:string}[]=[];
  let hook:(kind:'wallet'|'policy',id:string,count:number)=>void=()=>{};
  const port:PrivyRoleReadPort={wallet:async id=>{calls.push({kind:'wallet',id});hook('wallet',id,calls.length);return clone(wallets[id]);},
    policy:async id=>{calls.push({kind:'policy',id});hook('policy',id,calls.length);return clone(policies[id]);}};
  return {input,prepared,wallets,policies,calls,port,hook:(value:typeof hook)=>{hook=value;}};
}
function envFor(input=config):NodeJS.ProcessEnv{return {SETTLEMENT_ASSET_MODE:input.assetMode,CHAIN_ID:input.chainId,ARBITER_ADDRESS:input.arbiter,
  PRIVY_EXECUTOR_ADDRESS:input.executor.address,PRIVY_WALLET_ID:input.executor.walletId,PRIVY_POLICY_ID:input.executor.policyId,PRIVY_SIGNER_ID:input.executor.signerId,
  REVIEWER_ADDRESS:input.reviewer.address,PRIVY_REVIEWER_WALLET_ID:input.reviewer.walletId,PRIVY_REVIEWER_POLICY_ID:input.reviewer.policyId,
  PRIVY_REVIEWER_SIGNER_ID:input.reviewer.signerId,REVIEW_POLICY_PATH:'LOCAL_ACTIVATED_POLICY_DOUBLE',JEV_MODEL:input.model};}
function runtime(f=fixture(),argv:readonly string[]=[]){
  const env=envFor(f.input),counts={source:0,review:0,port:0};
  const value:PrivyRolePreparationRuntime={env,argv,root:'/private/tmp/local-role-double',clock:()=>1_700_000_000_000,
    captureSource:()=>{counts.source++;return clone(source);},loadActiveRule:(path,model)=>{
      counts.review++;assert.equal(path,'LOCAL_ACTIVATED_POLICY_DOUBLE');assert.equal(model,f.input.model);
      return {model:f.input.model,minConfidence:.9,questionConfigHash:f.input.questionConfigHash};},
    readPort:(chosen,credentials)=>{counts.port++;assert.deepEqual(chosen,parsePrivyRoleConfiguration(f.input));
      assert.deepEqual(credentials,{appId:'local-app',appSecret:'fake-secret'});return f.port;}};
  return {f,value,env,counts};
}

test('offline roles prepare exactly existing executor and reviewer blueprints without recording provider IDs',()=>{
  const prepared=preparePrivyRoles(config);
  assert.deepEqual(prepared.roles.executor.policyBlueprint,escrowPolicy('10143',config.arbiter as `0x${string}`));
  assert.deepEqual(prepared.roles.reviewer.policyBlueprint,receiptPolicy({chainId:'10143',arbiter:config.arbiter,address:config.reviewer.address,model:config.model,questionConfigHash:config.questionConfigHash}));
  for(const role of ['executor','reviewer'] as const){
    assert.equal(prepared.roles[role].rulesHash,keccak256(toHex(JSON.stringify(semantics(prepared.roles[role].policyBlueprint.rules)))));
    assert.equal(JSON.stringify(prepared).includes(config[role].walletId),false);assert.equal(JSON.stringify(prepared).includes(config[role].policyId),false);
    assert.equal(JSON.stringify(prepared).includes(config[role].signerId),false);
  }
  assert.equal(prepared.scope,'OFFLINE_PRIVY_TWO_ROLE_BLUEPRINTS_NOT_INSTALLED_OR_EXECUTION_PROOF');assert.equal(prepared.policyInstallationVerified,false);
  assert.equal(prepared.financialAcceptanceStatus,'BLOCKED');assert.equal(prepared.canExecute,false);assert.equal(prepared.walletsCreated,0);
  assert.equal(prepared.policiesChanged,0);assert.equal(prepared.signaturesRequested,0);assert.equal(prepared.transactionsSent,0);
  assert.notEqual(preparePrivyRoles({...config,executor:{...config.executor,walletId:'different-local-wallet'}}).configurationHash,prepared.configurationHash);
});

test('role configuration rejects historical mode mainnet extra capabilities arbitrary policy input and shared roles',()=>{
  for(const patch of [{assetMode:'cleanverse'},{chainId:'143'},{arbiter:a(0)},{rpcUrl:'https://local.invalid'},
    {rules:[]},{abi:[]},{authorizationPrivateKey:'local-key'},{appSecret:'local-secret'},{questionConfigHash:'bad'},
    {model:'unfrozen-model'},{executor:{...config.executor,address:a(0)}},{executor:{...config.executor,walletId:'../wallet'}},
    {executor:{...config.executor,signerId:'sk-local'}},{reviewer:{...config.reviewer,address:config.executor.address}},
    {reviewer:{...config.reviewer,walletId:config.executor.walletId}},{reviewer:{...config.reviewer,policyId:config.executor.policyId}}])
    assert.throws(()=>preparePrivyRoles({...config,...patch}),{message:'PRIVY_ROLES_CONFIGURATION_INVALID'});
  const mixed={...config,executor:{...config.executor,address:a(0xab)},reviewer:{...config.reviewer,address:`0x${a(0xab).slice(2).toUpperCase()}`}};
  assert.throws(()=>preparePrivyRoles(mixed),/CONFIGURATION_INVALID/);
});

test('normalized immutable preparation ignores later caller mutation and allows explicitly shared signer IDs',()=>{
  const caller=clone(config),prepared=preparePrivyRoles(caller),original=JSON.stringify(prepared);caller.executor.address=a(9);caller.model='jev-9.9.9';
  assert.equal(JSON.stringify(prepared),original);assert.throws(()=>{prepared.roles.executor.policyBlueprint.rules.pop();},TypeError);
  assert.throws(()=>{prepared.roles.reviewer.policyBlueprint.rules[0].conditions.pop();},TypeError);
  assert.doesNotThrow(()=>preparePrivyRoles({...config,reviewer:{...config.reviewer,signerId:config.executor.signerId}}));
});

test('live current matching requires exactly eight GET calls and cannot claim key possession funding or execution',async()=>{
  const f=fixture(),proof=await inspectPrivyRoles(config,f.port);
  assert.equal(proof.status,'CURRENT_ROLES_VERIFIED');assert.equal(proof.readCallsAttempted,8);assert.equal(f.calls.length,8);
  assert.deepEqual(f.calls.slice(0,4),[{kind:'wallet',id:config.executor.walletId},{kind:'policy',id:config.executor.policyId},
    {kind:'wallet',id:config.reviewer.walletId},{kind:'policy',id:config.reviewer.policyId}]);assert.deepEqual(f.calls.slice(4),f.calls.slice(0,4));
  assert.equal(proof.roles.executor.signerRole,'OWNER');assert.equal(proof.roles.reviewer.signerRole,'OWNER');
  assert.equal(proof.currentWalletPolicyVerified,true);assert.equal(proof.authorizationKeyPossessionVerified,false);
  assert.equal(proof.historicalPolicyAtSendVerified,false);assert.equal(proof.providerTransactionsVerified,false);assert.equal(proof.deploymentVerified,false);
  assert.equal(proof.financialAcceptanceStatus,'BLOCKED');assert.equal(proof.canExecute,false);assert.equal(proof.signaturesRequested,0);assert.equal(proof.transactionsSent,0);
  assert.equal(JSON.stringify(proof).includes('LOCAL_PROVIDER_BODY_NOT_FOR_PUBLIC_OUTPUT'),false);
  for(const role of ['executor','reviewer'] as const)for(const id of [config[role].walletId,config[role].policyId,config[role].signerId])assert.equal(JSON.stringify(proof).includes(id),false);
});

test('delegated roles require the unique chosen signer exact override policy instead of unrelated owner policies',async()=>{
  const f=fixture();for(const role of ['executor','reviewer'] as const){const wallet=f.wallets[config[role].walletId];
    wallet.owner_id='local-other-owner';wallet.policy_ids=['local-owner-wide-policy'];wallet.additional_signers=[{signer_id:config[role].signerId,override_policy_ids:[config[role].policyId]}];}
  const proof=await inspectPrivyRoles(config,f.port);assert.equal(proof.roles.executor.signerRole,'DELEGATED');assert.equal(proof.roles.reviewer.signerRole,'DELEGATED');
  for(const role of ['executor','reviewer'] as const)for(const signers of [[],[{signer_id:config[role].signerId}],
    [{signer_id:config[role].signerId,override_policy_ids:[]}],[{signer_id:config[role].signerId,override_policy_ids:[config[role].policyId,'extra-local-policy']}],
    [{signer_id:config[role].signerId,override_policy_ids:[config[role].policyId]},{signer_id:config[role].signerId,override_policy_ids:[config[role].policyId]}]]){
    const bad=fixture();bad.wallets[config[role].walletId].owner_id=null;bad.wallets[config[role].walletId].additional_signers=signers;
    await assert.rejects(inspectPrivyRoles(config,bad.port),/SIGNER_POLICY_MISMATCH/);assert.equal(bad.calls.length,4);
  }
});

test('wallet identity chain archive and exact owner policy mismatches fail without a second snapshot',async()=>{
  for(const role of ['executor','reviewer'] as const)for(const patch of [{id:'different-local-wallet'},{address:a(9)},{chain_type:'solana'},
    {archived_at:0},{archived_at:1700000000000},{policy_ids:[]},{policy_ids:[config[role].policyId,'extra-local-policy']}]){
    const f=fixture();Object.assign(f.wallets[config[role].walletId],patch);
    await assert.rejects(inspectPrivyRoles(config,f.port),/CURRENT_CONFIGURATION|SIGNER_POLICY_MISMATCH/);assert.equal(f.calls.length,4);
  }
});

test('provider policies must match every fixed semantic rule and deny extra methods conditions or changed ABI',async()=>{
  for(const role of ['executor','reviewer'] as const)for(const mismatch of ['id','version','chain','extra-rule','condition','abi'] as const){
    const f=fixture(),policy=f.policies[config[role].policyId];
    if(mismatch==='id')policy.id='different-local-policy';else if(mismatch==='version')Reflect.set(policy,'version','2.0');
    else if(mismatch==='chain')Reflect.set(policy,'chain_type','solana');else if(mismatch==='extra-rule')(policy.rules as unknown[]).push(clone(policy.rules[0]));
    else if(mismatch==='condition')Reflect.set(policy.rules[0].conditions[0],'value','wrong-local-domain');
    else Reflect.set(policy.rules[0].conditions.at(-1)!,'abi',[]);
    await assert.rejects(inspectPrivyRoles(config,f.port),/CURRENT_CONFIGURATION|POLICY_SCOPE_MISMATCH/);assert.equal(f.calls.length,4);
  }
});

test('GET failure and malformed bodies produce fixed safe errors with actual attempted-call counts',async()=>{
  const privateBody='LOCAL_PRIVATE_ERROR_BODY';const f=fixture();f.port.wallet=async()=>{throw new Error(privateBody);};
  await assert.rejects(inspectPrivyRoles(config,f.port),error=>{
    assert.ok(error instanceof PrivyRolePreparationError);assert.equal(error.message,'PRIVY_ROLES_READ_UNAVAILABLE');assert.equal(error.readCallsAttempted,4);
    assert.equal(JSON.stringify(error).includes(privateBody),false);return true;
  });
  const bad=fixture();bad.port.policy=async()=>({invalid:'LOCAL_PRIVATE_ERROR_BODY'});
  await assert.rejects(inspectPrivyRoles(config,bad.port),error=>{assert.ok(error instanceof PrivyRolePreparationError);assert.equal(error.message,'PRIVY_ROLES_CURRENT_CONFIGURATION_INVALID');assert.equal(error.readCallsAttempted,4);return true;});
});

test('first and second snapshots reject ownership delegation or policy drift even when addresses stay fixed',async()=>{
  const f=fixture();f.hook((_kind,_id,count)=>{if(count===5){const wallet=f.wallets[config.executor.walletId];wallet.owner_id='local-other-owner';
    wallet.additional_signers=[{signer_id:config.executor.signerId,override_policy_ids:[config.executor.policyId]}];}});
  await assert.rejects(inspectPrivyRoles(config,f.port),error=>{assert.ok(error instanceof PrivyRolePreparationError);assert.equal(error.message,'PRIVY_ROLES_CURRENT_CONFIGURATION_CHANGED');assert.equal(error.readCallsAttempted,8);return true;});
  const bad=fixture();bad.hook((_kind,_id,count)=>{if(count===5)Reflect.set(bad.policies[config.reviewer.policyId].rules[0].conditions[0],'value','different-chain');});
  await assert.rejects(inspectPrivyRoles(config,bad.port),/POLICY_SCOPE_MISMATCH/);assert.equal(bad.calls.length,8);
});

test('read port captures prototype GET methods and exposes no transactions signing or mutation capabilities',async()=>{
  const f=fixture();class Resource {
    constructor(readonly kind:'wallet'|'policy'){}
    get(id:string){assert.ok(this instanceof Resource);return f.port[this.kind](id);}
  }
  const wallets=new Resource('wallet'),policies=new Resource('policy');let forbidden=0;
  const reject=()=>{forbidden++;throw Error('Forbidden local capability');};
  const client={wallets:()=>wallets,policies:()=>policies,transactions:reject,keyQuorums:reject} as unknown as PrivyClient;
  const port=privyRoleReadPort(client);wallets.get=reject;policies.get=reject;
  assert.deepEqual(Object.keys(port).sort(),['policy','wallet']);assert.equal((await inspectPrivyRoles(config,port)).readCallsAttempted,8);assert.equal(forbidden,0);
  for(const id of ['../private','https://local.invalid','sk-local','apikey_local',''])await assert.rejects(port.wallet(id),/PROVIDER_IDENTIFIER_INVALID/);
  assert.equal(f.calls.length,8);
});

test('inspection captures caller configuration and bound port methods before any asynchronous reads',async()=>{
  const f=fixture(),input=clone(config),originalWallet=f.port.wallet;
  f.port.wallet=async id=>{input.executor.walletId='changed-local-wallet';f.port.wallet=async()=>{throw Error('Late replacement');};return originalWallet(id);};
  assert.equal((await inspectPrivyRoles(input,f.port)).status,'CURRENT_ROLES_VERIFIED');assert.equal(f.calls.length,8);
  await assert.rejects(inspectPrivyRoles({...config,rules:[]},f.port),/CONFIGURATION_INVALID/);
});

test('CLI preparation is offline and never reads app credentials or either authorization private key',async()=>{
  const r=runtime(),original=r.env;
  r.value.env=new Proxy(original,{get(target,key){if(typeof key==='string'&&(key.startsWith('PRIVY_APP_')||key.includes('AUTHORIZATION_PRIVATE_KEY')))throw Error('Forbidden credential read');return Reflect.get(target,key);}});
  const result=await runPrivyRolePreparation(r.value);assert.equal(result.exitCode,0);assert.equal(result.report.status,'PREPARED');
  assert.equal(r.counts.port,0);assert.equal(r.f.calls.length,0);assert.equal(r.counts.review,2);assert.equal(r.counts.source,2);
  assert.equal(result.report.reviewPolicyIntegrityChecked,true);assert.equal(result.report.reviewPolicyProvenanceAttested,false);
  assert.equal(result.report.authorizationPrivateKeysRead,false);assert.equal(result.report.readCallsAttempted,0);assert.equal(result.report.financialAcceptanceStatus,'BLOCKED');
});

test('CLI missing real public role fields reports names only BLOCKED and never substitutes demo addresses',async()=>{
  const r=runtime();r.value.env={};const result=await runPrivyRolePreparation(r.value);
  assert.equal(result.exitCode,1);assert.equal(result.report.status,'BLOCKED');assert.equal(result.report.reason,'PRIVY_ROLES_CONFIGURATION_MISSING');
  assert.deepEqual(result.report.missing,[...privyRolePublicConfigurationNames]);assert.equal(result.report.preparation,null);assert.equal(result.report.inspection,null);
  assert.equal(r.counts.review,0);assert.equal(r.counts.port,0);assert.equal(result.report.readCallsAttempted,0);
});

test('CLI requires actual activated review validation and never enables a failed v2 candidate',async()=>{
  for(const failure of ['REVIEW_POLICY_INVALID','REVIEW_POLICY_ACTIVATION_REQUIRED']){
    const r=runtime();r.value.loadActiveRule=()=>{throw Error(failure);};const result=await runPrivyRolePreparation(r.value);
    assert.equal(result.exitCode,1);assert.equal(result.report.status,failure.endsWith('ACTIVATION_REQUIRED')?'BLOCKED':'FAIL');
    assert.equal(result.report.reason,failure);assert.equal(result.report.preparation,null);assert.equal(r.counts.port,0);
  }
});

test('CLI refuses extra flags historical profiles and mainnet before creating a provider read port',async()=>{
  for(const args of [['--execute'],['--inspect','--url','https://local.invalid'],['--inspect','--inspect']]){
    const r=runtime(undefined,args),result=await runPrivyRolePreparation(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_ROLES_ARGUMENT_INVALID');assert.equal(r.counts.port,0);
  }
  for(const patch of [{SETTLEMENT_ASSET_MODE:'cleanverse'},{CHAIN_ID:'143'}]){
    const r=runtime();Object.assign(r.env,patch);const result=await runPrivyRolePreparation(r.value);
    assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_ROLES_CONFIGURATION_INVALID');assert.equal(r.counts.port,0);
  }
});

test('CLI inspect requires app credentials but no auth key and publishes only current-role associations',async()=>{
  const missing=runtime(undefined,['--inspect']),blocked=await runPrivyRolePreparation(missing.value);
  assert.equal(blocked.exitCode,1);assert.equal(blocked.report.status,'BLOCKED');assert.deepEqual(blocked.report.missing,['PRIVY_APP_ID','PRIVY_APP_SECRET']);assert.equal(missing.counts.port,0);
  const r=runtime(undefined,['--inspect']);Object.assign(r.env,{PRIVY_APP_ID:'local-app',PRIVY_APP_SECRET:'fake-secret'});
  r.value.env=new Proxy(r.env,{get(target,key){if(typeof key==='string'&&key.includes('AUTHORIZATION_PRIVATE_KEY'))throw Error('Forbidden auth key read');return Reflect.get(target,key);}});
  const result=await runPrivyRolePreparation(r.value);assert.equal(result.exitCode,0);assert.equal(result.report.status,'CURRENT_ROLES_VERIFIED');
  assert.equal(result.report.readCallsAttempted,8);assert.equal(result.report.inspection!.currentWalletPolicyVerified,true);
  assert.equal(result.report.inspection!.authorizationKeyPossessionVerified,false);assert.equal(result.report.financialAcceptanceStatus,'BLOCKED');
  assert.equal(JSON.stringify(result).includes('fake-secret'),false);assert.equal(JSON.stringify(result).includes('LOCAL_PROVIDER_BODY_NOT_FOR_PUBLIC_OUTPUT'),false);
});

test('CLI blocks known app secret identifiers before GET and never publishes the identifier or provider body',async()=>{
  const r=runtime(undefined,['--inspect']),secret='LocalSecretOnlyForRoleTests';Object.assign(r.env,{PRIVY_APP_ID:'local-app',PRIVY_APP_SECRET:secret,PRIVY_WALLET_ID:secret});
  const result=await runPrivyRolePreparation(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_ROLES_PROVIDER_IDENTIFIER_INVALID');
  assert.equal(result.report.readCallsAttempted,0);assert.equal(r.counts.port,0);assert.equal(JSON.stringify(result).includes(secret),false);
  const bad=runtime(undefined,['--inspect']);Object.assign(bad.env,{PRIVY_APP_ID:'local-app',PRIVY_APP_SECRET:'fake-secret'});
  bad.f.port.wallet=async()=>{throw Error('LOCAL_PRIVATE_ERROR_BODY');};const failure=await runPrivyRolePreparation(bad.value);
  assert.equal(failure.exitCode,1);assert.equal(failure.report.status,'BLOCKED');assert.equal(failure.report.reason,'PRIVY_ROLES_READ_UNAVAILABLE');
  assert.equal(failure.report.readCallsAttempted,4);assert.equal(JSON.stringify(failure).includes('LOCAL_PRIVATE_ERROR_BODY'),false);
});

test('CLI source or activated-review drift invalidates the result while preserving actual read attempts',async()=>{
  for(const drift of ['source','review'] as const){
    const r=runtime(undefined,['--inspect']);Object.assign(r.env,{PRIVY_APP_ID:'local-app',PRIVY_APP_SECRET:'fake-secret'});
    if(drift==='source'){let reads=0;r.value.captureSource=()=>{const snapshot=clone(source);if(++reads===2)snapshot.bindings[0].sha256='2'.repeat(64);return snapshot;};}
    else {let reads=0;r.value.loadActiveRule=()=>({model:config.model,minConfidence:.9,questionConfigHash:++reads===2?h(9):config.questionConfigHash});}
    const result=await runPrivyRolePreparation(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.status,'FAIL');
    assert.equal(result.report.reason,drift==='source'?'PRIVY_ROLES_SOURCE_CHANGED':'PRIVY_ROLES_ACTIVE_REVIEW_POLICY_CHANGED');
    assert.equal(result.report.readCallsAttempted,8);assert.equal(result.report.inspection,null);assert.equal(result.report.preparation,null);
    assert.equal(result.report.financialAcceptanceStatus,'BLOCKED');
  }
});

test('CLI captures public environment values and strips an unsafe source record before returning it',async()=>{
  const r=runtime(),load=r.value.loadActiveRule!;r.value.loadActiveRule=(path,model,root)=>{r.env.PRIVY_EXECUTOR_ADDRESS=a(9);return load(path,model,root);};
  assert.equal((await runPrivyRolePreparation(r.value)).report.preparation!.roles.executor.address,config.executor.address);
  const unsafe=runtime(),unsafeMarker='sk-'+'localfakeprivateidentifier'+'1234567890';
  unsafe.value.captureSource=()=>({...source,bindings:[{...source.bindings[0],path:`scripts/${unsafeMarker}.ts`}]});
  const failure=await runPrivyRolePreparation(unsafe.value);assert.equal(failure.exitCode,1);assert.equal(failure.report.reason,'PRIVY_ROLES_PUBLIC_OUTPUT_UNSAFE');
  assert.equal(failure.report.sourceCommit,null);assert.deepEqual(failure.report.sourceBindings,[]);assert.equal(failure.report.preparation,null);
  assert.equal(JSON.stringify(failure).includes(unsafeMarker),false);
});

test('CLI unexpected error text cannot become a public reason even when it resembles a project code',async()=>{
  const r=runtime(),privateMessage='PRIVY_ROLES_LOCAL_PRIVATE_PROVIDER_BODY';r.value.loadActiveRule=()=>{throw Error(privateMessage);};
  const result=await runPrivyRolePreparation(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_ROLES_PREPARATION_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes(privateMessage),false);assert.equal(r.counts.port,0);
});

test('CLI invalid dates and reversed time fail with safe fixed reasons and no provider calls',async()=>{
  for(const time of [0,-1,Number.NaN,Number.MAX_SAFE_INTEGER]){
    const r=runtime();r.value.clock=()=>time;const result=await runPrivyRolePreparation(r.value);
    assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_ROLES_CLOCK_INVALID');assert.equal(r.counts.port,0);
  }
  const r=runtime();let reads=0;r.value.clock=()=>++reads===1?1_700_000_000_000:1_699_999_999_999;
  const result=await runPrivyRolePreparation(r.value);assert.equal(result.exitCode,1);assert.equal(result.report.reason,'PRIVY_ROLES_CLOCK_INVALID');
});
