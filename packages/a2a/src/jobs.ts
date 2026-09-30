import { expireMandates } from "./mandates";
import { expireNegotiations } from "./negotiation";
import { advanceNegotiation, runDueMandates, sweepStalled } from "./agents";

export { advanceNegotiation };
export const runDueMandatesJob = async (): Promise<void> => void (await runDueMandates());
export const sweepJob = async (): Promise<void> => void (await sweepStalled());
export const expireMandatesAndNegotiations = async (): Promise<void> => {
  await expireMandates();
  await expireNegotiations();
};
