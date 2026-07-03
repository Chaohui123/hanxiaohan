# @onzo/ozon-order

Utilities and sync helpers for Ozon order ingestion and inventory handling (Phase1 skeleton).

Files:
- `src/client.ts` — lightweight wrapper around `@onzo/ozon-api-wrapper` for order requests
- `src/sync.ts` — pagination-based order sync helper
- `src/webhook.ts` — webhook parsing and idempotency key extraction
- `src/inventory.ts` — transactional inventory deduction stub

This package is a Phase1 scaffold; implement business logic (idempotency persistence, transactions, signature validation) before using in production.
