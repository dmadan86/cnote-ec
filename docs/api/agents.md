# Agent-to-agent API (ADR-020)

The agent API lets a third-party procurement (or sales) agent negotiate on behalf of a business through typed offers, counters and accepts, instead of chat. It is the external counterpart of the in-app buyer and seller agents. Negotiations are enabled only when the platform runs with `A2A_ENABLED=true`; while it is off, starting a negotiation or sending a message returns `409` ("not enabled"). Reading mandates and negotiations always works.

An agent never has more power than the business's people gave it. It acts only as the business the API key is bound to, only inside a mandate that a person created, and it can never confirm a deal.

## Authentication and scopes

Use a personal API key (`Authorization: Bearer ck_live_...`) created for a business. Two scopes:

| Scope | Allows |
| --- | --- |
| `agents:read` | List/read mandates and negotiations of the key's business. |
| `agents:write` | Start negotiations and send offer, counter, accept, reject and withdraw messages. Implies `agents:read`. |

Both are business-scoped: a key that is not bound to a business gets `403`. A missing scope gets `403` naming the scope.

## Mandates

A mandate is the business's written authority for an agent: side (buyer or seller), category, quantity, its own price limit, lead-time limit, maximum rounds, expiry, and an optional auto-accept setting. Mandates are created, edited, paused and revoked by people in the buyer or seller app. The API cannot create mandates and cannot turn auto-accept on. `GET /v1/agents/mandates` and `GET /v1/agents/mandates/{id}` show your own mandates, including your own limits. The counterparty's mandate and limits are never visible to you.

## The protocol

A message is one of:

| `type` | Body | Meaning |
| --- | --- | --- |
| `offer` | `offer` terms | Opening offer, only when nothing is standing. |
| `counter` | `offer` terms | Counter the other side's standing offer. |
| `accept` | none | Accept the other side's standing offer. |
| `reject` | none | Reject the standing offer; closes the negotiation. |
| `withdraw` | none | Walk away; either side, any time while open. |

Offer terms: `pricePaise` (integer paise per unit), `quantity`, `unit`, `leadTimeDays`, `deliveryTerms` (optional), `validUntil` (`YYYY-MM-DD`, today up to 90 days ahead), `paymentTerms` (optional).

State machine: `open` -> `agreed` -> `accepted`, or `rejected`, `withdrawn`, `expired`. `agreed` means both sides' agents accepted the same terms; it is not yet a deal.

Rules enforced server-side on both sides, identically for humans, internal agents and external agents:

- Your offers and counters must be inside your mandate's own bounds (price, lead time, quantity, capacity).
- Concessions only move one way: a buyer never lowers its own price, a seller never raises its own.
- At most `maxRounds` rounds; an offer cannot be accepted after its `validUntil`; a negotiation expires after its time-to-live.
- It must be your turn, and you cannot accept your own offer.

Errors and violation messages name only your own limits (for example "Price is below your mandate's floor."). You never learn the counterparty's floor or ceiling, and `yourLimits` in a negotiation view contains only your own.

## Human confirmation

There is no confirm endpoint. An accept leaves the negotiation `agreed`. It becomes a deal (a quote and order) only when the business's people confirm it in the app, unless they enabled auto-accept on the mandate and the terms sit inside its auto-accept bounds. `canConfirm` in the view is informational. Every agent action is visible to the business's people in the app.

## Idempotency

`POST /v1/agents/negotiations/{id}/messages` requires an `Idempotency-Key` header (1 to 100 characters, unique per message you intend to send); a missing key returns `422`. Retrying with the same key returns the original result and never sends twice, so retry freely on timeouts. `POST /v1/agents/negotiations` accepts an optional `Idempotency-Key`; starting is also idempotent per match.

## Rate limits and safety

On top of the per-key API limit (see the main docs), agent traffic is limited by the platform (env defaults):

- `A2A_BUSINESS_MSGS_PER_MIN` = 120 messages per business per minute (all agents of the business).
- `A2A_KEY_MSGS_PER_MIN` = 60 messages per API key per minute.
- `A2A_STARTS_PER_HOUR` = 30 negotiations started per business per hour.

Exceeding a limit returns `429` with `Retry-After`. Behaviour is monitored: repeated out-of-bounds attempts, identical message floods and similar patterns are recorded as anomalies and can flag a negotiation for review. Staff can suspend a mandate, an API key or a whole business from agent activity; suspended actors get `403`/`409` responses. Fix the cause and ask the business to contact support to lift a suspension.

## Endpoints

| Method and path | Scope |
| --- | --- |
| `GET /v1/agents/mandates` | `agents:read` |
| `GET /v1/agents/mandates/{id}` | `agents:read` |
| `GET /v1/agents/negotiations?status=&side=&cursor=&limit=` | `agents:read` |
| `GET /v1/agents/negotiations/{id}` | `agents:read` |
| `POST /v1/agents/negotiations` body `{ mandateId, matchId }` | `agents:write` |
| `POST /v1/agents/negotiations/{id}/messages` (header `Idempotency-Key`) | `agents:write` |

The transcript shows each message's `side`, `type`, `offer`, and who sent it (`agent`, `external_agent`, `person`).

## Example flow

```bash
API=https://api.example.com
KEY=ck_live_...

# 1. Your mandates (created by your people in the app)
curl -s $API/v1/agents/mandates -H "Authorization: Bearer $KEY"

# 2. Start on a match you were given (a lead / enquiry match id)
curl -s -X POST $API/v1/agents/negotiations \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: start-match-123" \
  -d '{"mandateId":"<mandate-uuid>","matchId":"<match-uuid>"}'

# 3. Opening offer (buyer side)
curl -s -X POST $API/v1/agents/negotiations/$NEG/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $NEG-1" \
  -d '{"type":"offer","offer":{"pricePaise":118000,"quantity":500,"unit":"pc","leadTimeDays":10,"validUntil":"2026-10-15"}}'

# 4. Read the transcript, then counter or accept
curl -s $API/v1/agents/negotiations/$NEG -H "Authorization: Bearer $KEY"

curl -s -X POST $API/v1/agents/negotiations/$NEG/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $NEG-2" \
  -d '{"type":"accept"}'
# status is now "agreed"; your business's people confirm in the app.
```

## MCP tools

The same capability is available on `/mcp` (same key and scopes): `list_agent_mandates`, `get_agent_mandate`, `list_agent_negotiations`, `get_agent_negotiation` (`agents:read`); `start_agent_negotiation`, `send_agent_offer` (type `offer` or `counter` with terms), `accept_agent_offer`, `reject_agent_offer`, `withdraw_agent_negotiation` (`agents:write`). Write tools take `idempotencyKey` (required for send, accept, reject and withdraw). Agents using these tools must never invent terms, must remember that a human confirms deals, and cannot see the other side's limits.
