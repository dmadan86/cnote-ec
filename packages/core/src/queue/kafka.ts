import type { JobQueue } from "./types";

/**
 * Placeholder for the Kafka driver (ADR-006/ADR-023 scale path). To implement: add a Kafka client
 * (e.g. kafkajs), map topic → Kafka topic, group → consumer group, delay/retry → retry topics
 * (`<topic>.retry.<n>`) and DLQ → `<topic>.dlq`. Nothing outside src/queue needs to change.
 */
export function createKafkaJobQueue(): JobQueue {
  throw new Error("QUEUE_DRIVER=kafka is not implemented yet — see packages/core/src/queue/kafka.ts");
}
