import type { DnsRecord } from "../records";
import type { EdgeProvider, EdgeStatus, FetchLike } from "./types";

interface CfResult {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string; validation_errors?: { message: string }[]; validation_records?: { txt_name?: string; txt_value?: string; http_url?: string; cname?: string; cname_target?: string }[] };
  verification_errors?: string[];
  ownership_verification?: { type: string; name: string; value: string };
}
interface CfEnvelope {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: CfResult | CfResult[] | null;
}

/**
 * Cloudflare for SaaS Custom Hostnames. Sellers CNAME to our fallback origin hostname (STOREFRONT_CNAME_TARGET,
 * which must be the zone's fallback origin); Cloudflare issues the certificate (HTTP DCV) and proxies to us.
 * Env: CF_API_TOKEN (Zone > SSL and Certificates: Edit), CF_ZONE_ID.
 */
export class CloudflareEdgeProvider implements EdgeProvider {
  readonly name = "cloudflare";
  readonly caaIssuers = ["letsencrypt.org", "pki.goog", "digicert.com", "ssl.com", "sectigo.com"];
  constructor(
    private readonly token = process.env.CF_API_TOKEN ?? "",
    private readonly zoneId = process.env.CF_ZONE_ID ?? "",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: CfEnvelope }> {
    if (!this.token || !this.zoneId) throw new Error("Cloudflare edge provider needs CF_API_TOKEN and CF_ZONE_ID");
    const res = await this.fetchImpl(`https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({ success: false, errors: [], result: null }))) as CfEnvelope;
    return { status: res.status, json };
  }

  static toStatus(r: CfResult): EdgeStatus {
    const ssl = r.ssl?.status ?? "";
    const records: DnsRecord[] = [];
    if (r.ownership_verification?.type === "txt") records.push({ type: "TXT", name: r.ownership_verification.name, value: r.ownership_verification.value, purpose: "ownership" });
    for (const v of r.ssl?.validation_records ?? []) if (v.txt_name && v.txt_value) records.push({ type: "TXT", name: v.txt_name, value: v.txt_value, purpose: "ownership" });
    const detail = `hostname:${r.status} ssl:${ssl || "n/a"}`;
    const errs = [...(r.verification_errors ?? []), ...(r.ssl?.validation_errors ?? []).map((e) => e.message)].filter(Boolean);
    if (r.status === "active" && ssl === "active") return { state: "active", detail, records };
    if (["blocked", "moved", "deleted"].includes(r.status) || ["deleted", "validation_timed_out", "issuance_timed_out", "deactivating"].includes(ssl)) {
      return { state: "failed", detail, error: errs[0] ?? `Cloudflare reported ${r.status}/${ssl}`, records };
    }
    return { state: "pending", detail, error: errs[0], records };
  }

  async createCustomHostname(hostname: string) {
    const { json } = await this.call("POST", "", { hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } });
    if (json.success && json.result && !Array.isArray(json.result)) return { ref: json.result.id, status: CloudflareEdgeProvider.toStatus(json.result) };
    // 1406: duplicate custom hostname, i.e. we created it before; adopt it.
    if (json.errors?.some((e) => e.code === 1406)) {
      const found = await this.call("GET", `?hostname=${encodeURIComponent(hostname)}`);
      const r = Array.isArray(found.json.result) ? found.json.result[0] : null;
      if (r) return { ref: r.id, status: CloudflareEdgeProvider.toStatus(r) };
    }
    throw new Error(`Cloudflare createCustomHostname failed: ${json.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || "unknown error"}`);
  }

  async getStatus(ref: string): Promise<EdgeStatus> {
    const { status, json } = await this.call("GET", `/${encodeURIComponent(ref)}`);
    if (status === 404) return { state: "failed", error: "Hostname no longer exists at the edge provider" };
    if (!json.success || !json.result || Array.isArray(json.result)) throw new Error(`Cloudflare getStatus failed: ${json.errors?.map((e) => e.message).join("; ") || status}`);
    return CloudflareEdgeProvider.toStatus(json.result);
  }

  async delete(ref: string): Promise<void> {
    const { status, json } = await this.call("DELETE", `/${encodeURIComponent(ref)}`);
    if (status === 404) return;
    if (!json.success) throw new Error(`Cloudflare delete failed: ${json.errors?.map((e) => e.message).join("; ") || status}`);
  }
}
