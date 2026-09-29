import type { DnsRecord } from "../records";
import type { EdgeProvider, EdgeStatus, FetchLike } from "./types";

interface VercelDomain {
  name: string;
  verified?: boolean;
  verification?: { type: string; domain: string; value: string; reason?: string }[];
  error?: { code?: string; message?: string };
}

/**
 * Vercel Domains API: attaches the seller host to the web project; Vercel issues the certificate once DNS points at it.
 * Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID (optional).
 */
export class VercelEdgeProvider implements EdgeProvider {
  readonly name = "vercel";
  readonly caaIssuers = ["letsencrypt.org"];
  constructor(
    private readonly token = process.env.VERCEL_TOKEN ?? "",
    private readonly projectId = process.env.VERCEL_PROJECT_ID ?? "",
    private readonly teamId = process.env.VERCEL_TEAM_ID ?? "",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private url(path: string) {
    return `https://api.vercel.com${path}${this.teamId ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(this.teamId)}` : ""}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    if (!this.token || !this.projectId) throw new Error("Vercel edge provider needs VERCEL_TOKEN and VERCEL_PROJECT_ID");
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
  }

  private async statusOf(name: string, d: VercelDomain): Promise<EdgeStatus> {
    const records: DnsRecord[] = (d.verification ?? []).filter((v) => v.type.toUpperCase() === "TXT").map((v) => ({ type: "TXT", name: v.domain, value: v.value, purpose: "ownership" }));
    if (!d.verified) return { state: "pending", detail: "unverified", error: d.verification?.[0]?.reason, records };
    const cfg = await this.call<{ misconfigured?: boolean }>("GET", `/v6/domains/${encodeURIComponent(name)}/config`);
    if (cfg.json.misconfigured) return { state: "pending", detail: "verified, DNS not pointing at Vercel yet", records };
    return { state: "active", detail: "verified", records };
  }

  async createCustomHostname(hostname: string) {
    const { status, json } = await this.call<VercelDomain>("POST", `/v10/projects/${encodeURIComponent(this.projectId)}/domains`, { name: hostname });
    if (json.error?.code === "domain_already_in_use" || status === 409) {
      const cur = await this.call<VercelDomain>("GET", `/v9/projects/${encodeURIComponent(this.projectId)}/domains/${encodeURIComponent(hostname)}`);
      if (cur.status === 200) return { ref: hostname, status: await this.statusOf(hostname, cur.json) };
    }
    if (status >= 400 || json.error) throw new Error(`Vercel add domain failed: ${json.error?.message ?? status}`);
    return { ref: hostname, status: await this.statusOf(hostname, json) };
  }

  async getStatus(ref: string): Promise<EdgeStatus> {
    const { status, json } = await this.call<VercelDomain>("GET", `/v9/projects/${encodeURIComponent(this.projectId)}/domains/${encodeURIComponent(ref)}`);
    if (status === 404) return { state: "failed", error: "Domain no longer attached to the project" };
    if (status >= 400) throw new Error(`Vercel domain status failed: ${json.error?.message ?? status}`);
    return this.statusOf(ref, json);
  }

  async delete(ref: string): Promise<void> {
    const { status, json } = await this.call<{ error?: { message?: string } }>("DELETE", `/v9/projects/${encodeURIComponent(this.projectId)}/domains/${encodeURIComponent(ref)}`);
    if (status >= 400 && status !== 404) throw new Error(`Vercel delete failed: ${json.error?.message ?? status}`);
  }
}
