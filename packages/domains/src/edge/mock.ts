import type { EdgeProvider, EdgeStatus } from "./types";

/** Dev/test provider: hostnames become active immediately, nothing leaves the process. */
export class MockEdgeProvider implements EdgeProvider {
  readonly name = "mock";
  readonly caaIssuers = ["letsencrypt.org", "pki.goog", "digicert.com", "sectigo.com", "ssl.com"];
  readonly hosts = new Map<string, EdgeStatus>();
  constructor(private readonly initial: EdgeStatus = { state: "active", detail: "mock" }) {}
  async createCustomHostname(hostname: string) {
    if (!this.hosts.has(hostname)) this.hosts.set(hostname, this.initial);
    return { ref: `mock:${hostname}`, status: this.hosts.get(hostname)! };
  }
  async getStatus(ref: string): Promise<EdgeStatus> {
    return this.hosts.get(ref.replace(/^mock:/, "")) ?? { state: "failed", error: "Unknown hostname" };
  }
  async delete(ref: string) {
    this.hosts.delete(ref.replace(/^mock:/, ""));
  }
  /** test helper */
  set(hostname: string, status: EdgeStatus) {
    this.hosts.set(hostname, status);
  }
}
