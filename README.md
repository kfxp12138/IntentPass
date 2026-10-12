# IntentPass

<img src="assets/brand/intentpass-logo.svg" alt="IntentPass" width="88" />

**Agents purchase. JEV checks the intent.**

IntentPass lets an AI agent buy a service from a natural-language request, with evidence review before spending and verified delivery before settlement on Monad.

[Live application](https://intentpass.lol/#demo) · [Public purchase proof](https://intentpass.lol/#proof)

## What it does

A store owner asks: “Buy a sales summary for my commercial business update. Report the number of days, total revenue, lowest daily revenue and highest daily revenue.”

Two offers can promise the same calculations while granting different usage rights. The planner selects a signed offer. JEV then evaluates three conditions against the user's original request and the offer's evidence:

1. The service matches the intent.
2. The intended commercial use is permitted.
3. The evidence belongs to the selected service.

Contradictory evidence produces **REJECT**; insufficient support produces **ABSTAIN**. Both stop the purchase before its authorization and payment. **PASS** lets the workflow continue through its wallet, budget, deadline and chain checks.

```text
User intent + data + fee cap
            |
     Signed offer selection
            |
       JEV evidence review ---- REJECT / ABSTAIN -> stop
            |
           PASS
            |
   One-use order authorization
            |
     Monad escrow funding
            |
  Delivery + exact recomputation
            |
      2-of-3 acceptance
            |
  Settlement + verified withdrawal
```

The current service computes four exact sales statistics. It does not generate forecasts, certify the authenticity of imported sales data, or support arbitrary services without an appropriate delivery verifier.

## Try the application

Open [Live purchase](https://intentpass.lol/#demo). Use the sample sales data or upload a CSV with the header `date,revenue_usd`, then enter your intent and maximum purchase fee.

For configured accounts, **Find signed offers** checks the available offers, wallet configuration and finalized balances. **Start this purchase** submits one task. The page shows the actual review response, execution events, report and withdrawal evidence. **Download receipt & report** becomes available after verified completion.

Fresh execution requires an authenticated buyer, existing delegated wallet permissions, funded testnet accounts and valid provider offers. A new email login does not inherit the project's configured purchase authority or saved jobs. Missing configuration is reported as a blocker.

No login is needed to inspect the historical example in [Proof explorer](https://intentpass.lol/#proof). It includes links to the original funding, delivery, acceptance, settlement and seller-withdrawal transactions.

## Run locally

Use **Node.js 24** and **pnpm 11.25.0**:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
pnpm start
```

Open **http://127.0.0.1:3000/#overview**. Change `PORT` in your own `.env` if that port is occupied. Do not overwrite an existing configured `.env`. Use `pnpm dev` for development.

The interface, unsigned sales preview and recorded proof work without provider credentials. Protected model, wallet and purchase actions stop when their configuration is missing. `/health` may report liveness OK and `ready: false`; liveness alone does not establish purchase readiness.

### Live configuration

The public repository contains no functioning credentials, private workflow databases, owner delegations or active quote catalog. Configure your own accounts and deployment together:

| Component | Configuration |
| --- | --- |
| Planner | `PLANNER_API_URL` including `/chat/completions`, `PLANNER_API_KEY`, `PLANNER_MODEL` |
| JEV | `TYPESAFE_API_KEY`, a pinned `JEV_MODEL`, activated `REVIEW_POLICY_PATH`, persistent `REVIEW_JOURNAL_DB_PATH` |
| Privy | Application credentials, authenticated wallet owners and explicitly installed delegated role policies |
| Monad | Verified chain/RPC, ERC20, escrow, gate, reviewer and committee addresses |
| Provider offers | Valid, signed offers through `QUOTE_CATALOG_PATH` |
| Worker | Private `AUTOMATION_DATA_DIRECTORY`, persistent operation journals and authorized role material |

The live purchase route requires an activated policy that evaluates the full written intent. Bundled policy and calibration files are fixed test resources; their presence does not authorize activating an older policy for a new intent. The code verifies policy/report bindings.

Keep a single active worker for a given set of wallet and operation journals. Preserve the current private state when moving a runtime; do not start a second executor from a stale database copy. Unknown transaction outcomes must be reconciled against their original operation before any new action.

## Verified testnet execution

The public sales example uses 14 days of synthetic store revenue. Its four figures are recomputed from the committed dataset.

| Result | Value |
| --- | --- |
| Sales period | September 1–14, 2026 |
| Total revenue | $16,673.25 |
| Lowest / highest daily revenue | $788.25 / $1,945.50 |
| Seller payment | 0.000010 IPTEST, or 10 smallest units |
| Acceptance | 2 of 3 configured committee members |
| Final state | `ALLOCATED_PAID`; remaining seller credit 0 |
| Network | Monad Testnet, chain 10143 |

The [October 9 public proof](artifacts/acceptance/sales-report-purchase/verified-purchase.json) preserves the original verified observation. That purchase required supplementary source-mapping evidence after an abstention and reconciliation of an interrupted settlement response.

A later server-run purchase also reached verified delivery and seller payment: [October 13 withdrawal transaction](https://testnet.monadvision.com/tx/0x8d71fa48b079e0875cdf251df2398a5c53c697954aac39b4a7012e16b8dd5de2). A separate recorded request returned ABSTAIN and stopped before payment. These are individual testnet observations, not a guarantee that a fresh request will pass.

## Architecture and cryptographic binding

- **Planner and JEV:** proposal selection is separate from evidence review. A model judgment alone is not spending authority.
- **Protocol:** hash commitments and EIP-712 signatures bind offers, task/evidence context, review receipts and one-use authorizations. Review receipts are application-issued attestations, not signatures issued by the JEV provider.
- **Privy execution:** authenticated, delegated roles constrain wallet methods. The planner has no arbitrary-calldata signing interface.
- **Persistent worker:** encrypted server-side task records, immutable operation reservations, duplicate-send protection and reconciliation of unknown outcomes.
- **Monad contracts:** a PACT-inspired `ContextVoteEscrow`, fixed asset checks, 2-of-3 acceptance, allocation and separately verified withdrawal. A transaction hash or allocated credit alone is not proof of receipt.
- **TypeScript SDK:** authenticated workflow APIs and an independent public-chain reader. See [client examples](examples/client/README.md) and [chain reader](examples/chain-client/README.md).

Signatures make changes to the bound context detectable; they do not prove that JEV's semantic judgment is correct. Delivery verification establishes the four computed figures against the supplied input, not the real-world truth of that input. The configured committee is not claimed to be an independently operated decentralized oracle.

### Experimental adaptor signatures

Open **Developer tools** and expand **Historical adaptor signature experiment (recording)** to compare PASS and REJECT and try the tamper controls. This separate experiment uses real recorded ECDSA adaptor cryptography with **simulated JEV answers**. Browser checks inspect record bindings; native tests verify the adaptor operations.

With CMake, a C compiler and tar available on macOS or Linux:

```sh
pnpm tools:adaptor
pnpm test:adaptor
pnpm demo:adaptor
```

The installer fetches SHA-256-pinned upstream source and public DLC vectors into `.tools/` and builds locally. The prototype binds a pre-signature to a candidate, completes it on PASS with a separate signed result binding, and rejects altered order/result contexts. Its transcripts use experiment keys; a completed transcript intentionally permits witness extraction.

Adaptor certificates are not live spending permissions. The deployed escrow uses the existing EIP-712 authorization path. No BBS signature implementation, Full PACT implementation, or IMAS/CDAS security claim is made.

## Checks

```sh
pnpm typecheck
pnpm test:unit
pnpm build
```

Native contract and ABI checks:

```sh
pnpm tools:foundry
pnpm test:contract:monad
pnpm abi:check
```

The application suite has an opt-in real-compiler integration test. After installing Foundry and compiling the contracts, enable it with:

```sh
FOUNDRY_OFFLINE=true INTENTPASS_RUNTIME_ARTIFACT_INTEGRATION=1 pnpm test:unit
```

Native adaptor checks run separately through `pnpm test:adaptor`; missing native tools fail that command explicitly. Application tests, native contract tests and historical chain records establish different properties. They do not constitute a production security audit.

## Repository map

```text
apps/web/       Interface and authenticated HTTP APIs
apps/worker/    Persistent procurement and reconciliation
packages/      Protocol, adapters, storage, automation and SDK
contracts/     Solidity contracts and contract tests
examples/      SDK clients, chain reader and sample sales CSV
tests/         Application, regression and native crypto tests
fixtures/      Fixed synthetic test inputs
scripts/       Build, test and operator utilities
assets/        Existing website brand mark
artifacts/     Curated public proof and fixed policy test resources
third-party/   Dependency licenses and notices
```

## Scope, privacy and license

This is a deployed testnet prototype. The active product uses IPTEST ERC20 settlement and encrypted server-side workflow storage. Cleanverse and Mera are outside the active product; legacy compatibility code and regression tests remain. The Mera package is development-only.

The server can decrypt its workflow vault. Configured model providers receive the task and review evidence. Unsigned task exports contain plaintext. Keep `.env`, role material, database files, keys and runtime backups private. An API key or read-only session does not grant wallet-owner authority.

The independent SDK's next real authenticated procurement and additional policy-denial/refund/compensation acceptance remain incomplete. No complete hackathon acceptance or production audit is claimed.

Original code is [MIT licensed](LICENSE). Third-party terms are preserved under `third-party/`; the adaptor dependency is described in [its notice](third-party/adaptor-signatures-NOTICE.md). Codex assisted with implementation, testing, documentation and interface development. The logo here is the existing website's SVG mark. Interface references included the AEGIS and Airlock hackathon presentations; their branding, code and wallet integrations were not copied.
