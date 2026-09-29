export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}
export interface SmsSender {
  send(msg: { to: string; text: string }): Promise<void>;
}

/** No email/SMS provider yet (Phase 1): messages are written to the server log. */
export const consoleMailer: Mailer = {
  async send({ to, subject, text }) {
    console.info(`[mail] to=${to} subject="${subject}"\n${text}`);
  },
};
export const consoleSms: SmsSender = {
  async send({ to, text }) {
    console.info(`[sms] to=${to} ${text}`);
  },
};

let mailer: Mailer = consoleMailer;
let sms: SmsSender = consoleSms;
export const getMailer = () => mailer;
export const setMailer = (m: Mailer) => void (mailer = m);
export const getSmsSender = () => sms;
export const setSmsSender = (s: SmsSender) => void (sms = s);
