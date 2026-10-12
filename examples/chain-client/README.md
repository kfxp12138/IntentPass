# Independent public-chain reader

Read the finalized sales order with the public SDK, without a login or wallet:

```sh
pnpm example:chain 0xc41f5cd3145202a9bdc9535ba02270642ca8450da3fca7614774f44fa87cd175
```

The client imports `EscrowReader` and queries the fixed Monad Testnet deployment in `monad-testnet.json`. It checks the original order, credits, withdrawals, and escrow ledger at one finalized block, then rechecks the block anchor. It does not read the server `.env`, sign, send, approve, or withdraw.

An optional `INTENTPASS_RPC_URL` overrides the public read endpoint. Do not put authenticated URLs in command arguments. RPC availability and historical access depend on the selected provider.

A successful historical read is not a new purchase or evidence of independent authenticated SDK procurement.
