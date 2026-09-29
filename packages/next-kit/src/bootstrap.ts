import "server-only";
// Server start-up wiring shared by the three apps (imported for its side effect from ./index).
// identity sends mail through a pluggable Mailer; route it through the queued, template-driven email module.
import { createQueuedMailer } from "@cnote/email";
import { setMailer } from "@cnote/identity";

const KEY = Symbol.for("cnote.next-kit.bootstrapped");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;

/** Idempotent (survives HMR / module duplication via a globalThis flag). */
export function bootstrap(): void {
  if (g[KEY]) return;
  g[KEY] = true;
  setMailer(createQueuedMailer());
}

bootstrap();
