// @cnote/disputes with its real escrow + quality adapters installed (composition root, ADR-006).
// Import disputes from here, not from "@cnote/disputes" directly.
import "server-only";
import { wireDisputeAdapters } from "@cnote/disputes";

wireDisputeAdapters();

export * from "@cnote/disputes";
