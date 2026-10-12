# Local configuration

## Preview without accounts

The quick start in the root README runs with blank provider credentials. The interface, sales preview, and recorded proof are available. `/health` can report liveness OK and `ready: false` at the same time: this is expected without live services. Missing integration settings are not replaced with a fake successful transaction.

For another local port, change `PORT` in your own `.env`. `pnpm dev` runs the development server; `pnpm build` followed by `pnpm start` runs the built interface. Node 24 is required for SQLite support.

## Live integrations

Configure your own accounts and deployment together; the review bundle contains no functioning credentials, owner delegations, quote catalog, database, or vault.

| Group | Requirements |
| --- | --- |
| Planner | `PLANNER_API_URL` ending in `/chat/completions`, `PLANNER_API_KEY`, `PLANNER_MODEL` |
| JEV | `TYPESAFE_API_KEY`, versioned `JEV_MODEL`, trusted `REVIEW_POLICY_PATH`, persistent `REVIEW_JOURNAL_DB_PATH` |
| Privy | Your app/client configuration, app secret, authenticated owners, and explicitly installed role policies |
| Monad | Verified chain ID, RPC, test ERC20, escrow, eligibility gate, reviewer, and committee configuration |
| Offers | Trusted task-bound signed offers supplied through `QUOTE_CATALOG_PATH` |
| Execution | Durable journal paths, private `AUTOMATION_DATA_DIRECTORY`, and original delegated role material |

The demo's configured planner was Kimi through an OpenAI-compatible endpoint. The public policy resource uses `jev-1.13.0` with the original 0.75 threshold. The version-2 policy files are regression resources, not an instruction to activate that candidate. Review-policy loaders verify the pinned fixture/report bytes; do not edit their contents to make a review pass.

Configuration validation lives in `packages/protocol/src/deployment.ts`, `packages/adapters/src/status.ts`, and the `configured-*.ts` web modules. Operator utilities remain under `scripts/`; review a utility's required inputs before using it with your own accounts. Neither an app API key nor a read-only session grants wallet-owner authority.

Reviewing historical receipts does not need a wallet. To make a new purchase, use a new valid task and signed offers, your own authorized roles, and funded testnet accounts. Old signatures and expired quotes are not reusable permissions.

## Private data

`.env`, `.tools`, databases, and generated build output are ignored. Keep populated configuration and all original workflow records private. Do not reset an existing reservation or discard an unknown transaction hash to retry a send. The server can decrypt its local workflow vault; this is not end-to-end private model inference.

The explicit unsigned task export contains plaintext. Model review and procurement disclose the supplied task/evidence to configured services. The offline sales preview does not.
