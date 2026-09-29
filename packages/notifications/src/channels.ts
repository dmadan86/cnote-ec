// Extra-channel adapters (WhatsApp/SMS). Email goes through @cnote/email. Real providers plug in
// with setChannelAdapter(); the default is a console stub so nothing leaves the process.
import type { ExtraChannel } from "./types";

export interface ChannelMessage {
  personId: string;
  /** phone number in E.164 */
  to: string;
  text: string;
  kind: string;
}

export interface ChannelAdapter {
  readonly channel: ExtraChannel;
  send(msg: ChannelMessage): Promise<void>;
}

const consoleAdapter = (channel: ExtraChannel): ChannelAdapter => ({
  channel,
  async send(msg) {
    // Mask the number: logs must not carry raw PII.
    console.info(`[notifications:${channel}] (stub) to ${msg.to.slice(0, 3)}******${msg.to.slice(-2)} kind=${msg.kind}`);
  },
});

const adapters: Partial<Record<ExtraChannel, ChannelAdapter>> = {};

export function setChannelAdapter(adapter: ChannelAdapter | { channel: ExtraChannel; reset: true }): void {
  if ("reset" in adapter) delete adapters[adapter.channel];
  else adapters[adapter.channel] = adapter;
}

export function getChannelAdapter(channel: "whatsapp" | "sms"): ChannelAdapter {
  return (adapters[channel] ??= consoleAdapter(channel));
}
