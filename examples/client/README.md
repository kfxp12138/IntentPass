# Independent TypeScript client

Run from the repository root with Node 24 and the locked dependencies installed:

```sh
pnpm example:run health
```

`INTENTPASS_URL` selects the service (HTTPS or loopback HTTP). Authenticated operations need the original user's short-lived `INTENTPASS_TOKEN` from the caller's own login flow. Never substitute an app secret, wallet authorization key, or private key. The client does not read the server `.env`, log in, or create wallet authority.

The client implements catalog/proposal/review, prepare/finalize, preflight, original submission/reconciliation, order queries, and workflow/procurement APIs. JSON input comes from stdin, not command-line secrets. See `client.ts` for the command parser and `packages/protocol/src/purchase-client.ts` for the API.

```sh
pnpm example:run catalog
pnpm example:run propose < propose-request.json
pnpm example:run review < review-request.json
pnpm example:run workflows
```

Request files are caller-supplied private data, not bundled live examples. Signing requires the authenticated original wallet or its valid delegation. PASS alone is not payment authorization; `submit --confirm` and `procure --confirm` are financial workflow actions. Do not run them merely to test connectivity.

The optional local browser bridge passes a short-lived session to a fixed child process through stdin memory. Read access and procurement have separate enable flags; neither flag creates wallet authority.

Protocol and client regression tests are included. A new independent authenticated SDK purchase remains incomplete; the public sales proof came from the delegated background runtime, not an independently completed SDK procurement.
