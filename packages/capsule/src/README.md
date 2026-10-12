# Original-record and compatibility modules

These modules preserve task/authorization commitments, verification of original signatures, encryption formats, and legacy recovery compatibility. Historical payload versions are not silently rewritten.

Mera and Passkey recovery are retired from the active interface. The Mera dependency is development-only for regression tests. New background purchases use the local worker vault in `apps/worker/src/workflow-vault.ts`; the server can decrypt that vault.

Retaining these modules does not claim completed cross-device acceptance or authorize reuse of an expired order. Decryption alone is never authorization to submit a transaction.
