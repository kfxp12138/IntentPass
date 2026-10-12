# Security and scope

- Offers, evidence, authorizations, receipts, and orders are bound to their original context. Changing an input cannot silently reuse the previous approval.
- Authentication is checked against the account's actual linked wallets. Caller-supplied owner identifiers are not authority.
- Wallet methods and role policies constrain execution; the planner cannot submit arbitrary calldata or access wallet private keys.
- Durable reservations preserve unknown operations. A hash or an allocated credit is not proof that the seller received payment.
- The delivery verifier recomputes four exact metrics from committed input. It does not certify that imported sales represent real-world events or establish legal rights beyond the evidence provided.
- Review refusals and insufficient evidence remain recorded. A new evidence version is distinct from retrying an unchanged review until it passes.
- The active workflow uses encrypted local server storage. The server can decrypt it and sends review inputs to configured model providers.

The public proof covers one completed sales-report purchase on Monad Testnet. Evidence supplementation and original-transaction reconciliation were needed. Full unattended operation, every failure path, and production security are not certified by this example.

This repository contains regression tests for retired Mera/Cleanverse interfaces and historical release-verification formats. Their presence is not a claim that those integrations are active or accepted. No secret configuration, live session, wallet database, or ciphertext archive is supplied.
