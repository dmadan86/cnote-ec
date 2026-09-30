import { WINDOW_MS } from "./config";

/** Meta's customer service window: free-form messages are allowed for 24h after the customer's last message. */
export const windowUntilFor = (customerMessageAt: Date): Date => new Date(customerMessageAt.getTime() + WINDOW_MS);
export const isWithinWindow = (windowUntil: Date | null | undefined, now: Date = new Date()): boolean => !!windowUntil && windowUntil.getTime() > now.getTime();
/** Later message can only extend the window, never shorten it (out-of-order webhooks). */
export const extendWindow = (current: Date | null | undefined, customerMessageAt: Date): Date => {
  const next = windowUntilFor(customerMessageAt);
  return current && current > next ? current : next;
};
