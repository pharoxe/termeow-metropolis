# Termeow automation ingress

This Worker is isolated under the `termeow-automation-ingress` name and uses the dedicated
`termeow-automation-events` queue plus `termeow-automation-dlq` dead-letter queue.

External signal producers submit:

```http
POST /v1/automations/:automationId/fire
Authorization: Bearer <INGRESS_SECRET>
Content-Type: application/json

{"sourceEventId":"provider:unique-event-id","observedMarketCapUsd":1250000}
```

The Worker validates and queues the event. Its queue consumer calls the Railway control plane
with `AUTOMATION_TRIGGER_SECRET`. Neon enforces `(automation_id, source_event_id)` uniqueness,
so retries cannot execute the same event twice.

Secrets are configured with Wrangler and never belong in this directory:

- `INGRESS_SECRET`
- `AUTOMATION_TRIGGER_SECRET`
