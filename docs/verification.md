# Verification

## Public purchase evidence

The final sales proof is `artifacts/acceptance/sales-report-purchase/verified-purchase.json`. It records original context bindings, recomputed metrics, finalized chain state, receipts/events, and the seller's withdrawal. The observation was made on October 9, 2026 at finalized block 69470454; it is a historical result, not a live balance.

Order: `0xc41f5cd3145202a9bdc9535ba02270642ca8450da3fca7614774f44fa87cd175`.

The first review abstained. Additional source-to-dataset mapping evidence passed the unchanged rule. An interrupted settlement response was reconciled using the original transaction hash before withdrawal. No duplicate settlement was sent. These facts define the evidence's limits even though the intermediate operational logs are not in this review bundle.

The earlier numeric purchase proof is retained because the product's historical view and its regression tests bind to its exact public data. Frozen review policy and calibration files are retained only where loaders/tests need their exact hashes; they are not a full chronology of development or a claim that every policy candidate is active.

## Review snapshot checks

See `verification.json` in this directory for the final packaging checks. Application tests use fixtures and explicit test doubles unless stated otherwise. Native contract tests execute locally. Neither creates a fresh public purchase.

No credential, browser session, delegation, private task record, database, or live wallet material is included. Reviewers can build and inspect the product with blank configuration. Live integration testing needs the reviewer's own setup.
