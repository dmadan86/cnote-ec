// Account emails (password reset, "someone tried to register with your email") are ENQUEUED, never awaited on the
// request path: a known and an unknown address then take the same time, and a slow or failing mail provider cannot
// leak (or block) account existence. The worker's identity module consumes the topic and calls the Mailer port.
import { getJobQueue, queueConsumer } from "@cnote/core";
import { getMailer } from "./mailer";

export interface AccountMail {
  to: string;
  subject: string;
  text: string;
}
declare module "@cnote/core" {
  interface JobTopics {
    "identity.mail": AccountMail;
  }
}

export const MAIL_TOPIC = "identity.mail";

/** Best effort: a queue hiccup is logged and swallowed so it cannot be observed by the caller. */
export async function enqueueAccountMail(msg: AccountMail): Promise<void> {
  try {
    await getJobQueue().enqueue(MAIL_TOPIC, msg, { maxAttempts: 5 });
  } catch (err) {
    console.error("account mail enqueue failed", err);
  }
}

export const mailQueueConsumers = [queueConsumer(MAIL_TOPIC, async (m) => getMailer().send(m.payload))];
