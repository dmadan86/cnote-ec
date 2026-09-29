# ADR-028: Pluggable transports: transactional outbox with EventTransport and JobQueue factories

**Status:** Accepted
**Note:** Supersedes: the Kafka-as-backbone indicative choice in ADR-006 for Phase 1. ADR-007's append-only event log is unchanged.

**Context.** ADR-006/007 want an event backbone and a versioned append-only event log. Kafka is heavy for the team; dual writes (DB then broker) lose events on crash. Async work (email, notifications, cache purge, trust rescoring) also needs a work queue.

**Options.**
1. Kafka now.
2. Dual write to DB and Redis. Loses or duplicates events.
3. Transactional outbox: `emit(tx, type, aggregate, payload)` inserts the event in the same DB transaction as the state change; a relay publishes to an `EventTransport`; work goes through a `JobQueue`. Both have drivers behind a factory.

**Decision.** Option 3. `@cnote/core` exposes `emit`, `relayOutbox`, `EventTransport` (Redis Streams, one consumer group per module, at-least-once, ack after handler success) and `JobQueue` (`createJobQueue(driver)`; `QUEUE_DRIVER=redis|kafka|memory`, default redis). Event types and versions are declared in `events/catalog.ts`; a payload change means a new version, never an edit. Handlers must be idempotent. `apps/worker` runs the relay, each module's `worker` observers, queue consumers and scheduled jobs.

**Rationale.**
- No lost events: state change and event commit atomically.
- Modules stay decoupled: observers subscribe to events, no direct cross-module calls for side effects.
- Kafka (or Event Hubs, MSK) can replace Redis Streams by adding a driver; the stub is at `core/queue/kafka.ts`.

**Consequences.**
- At-least-once delivery forces idempotent handlers and dedupe keys.
- Redis is a critical dependency (durability via AOF or managed Redis with persistence); the outbox table remains the recovery source.
- Outbox growth needs a retention or partition policy (open item).

**Review.** Move to Kafka when sustained throughput exceeds what one Redis stream and consumer groups handle comfortably (order of 5k events/s), or when cross-team consumers need replay beyond the outbox.
