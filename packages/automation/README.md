# Automation controllers

This package exposes preparation, payment, and original-order fulfillment controllers. Callers provide authenticated or delegated role sessions; the controllers do not create wallet authority or expose arbitrary signing.

The active product orchestrates these modules through `apps/worker/src/background-procurement.ts`, with a durable queue and encrypted local workflow storage. Original-operation records survive failure and are reconciled before further action. The worker verifies actual withdrawal transfers rather than treating an allocated credit or transaction hash as payment.

Browser controllers and legacy recovery hooks remain for regression coverage. The current product does not use Mera or request a Passkey ceremony. See the root architecture and security guides for the active workflow and its limits.
