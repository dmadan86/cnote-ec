// Live-readiness checklist for the admin console (ADR-021): automatic checks from config, registry and wiring, plus the
// manual ONDC certification items (admin-toggled, audited). Never exposes secret values.
import { disputesEnabled } from "@cnote/disputes";
import { configStatus, loadConfig, type OndcConfig } from "./config";
import { getOrderSink } from "./sink";
import { getRegistry } from "./registry";
import { siteVerification } from "./subscribe";
import { CERT_ITEMS, getCertState, getKillSwitch } from "./killswitch";

export interface ReadinessItem { id: string; label: string; ok: boolean; kind: "auto" | "manual"; detail?: string }
export interface Readiness { items: ReadinessItem[]; autoOk: boolean; manualOk: boolean; goLive: boolean; killSwitch: Awaited<ReturnType<typeof getKillSwitch>> }

export async function readiness(cfg: OndcConfig = loadConfig()): Promise<Readiness> {
  const st = configStatus(cfg);
  const items: ReadinessItem[] = [];
  const auto = (id: string, label: string, ok: boolean, detail?: string) => items.push({ id, label, ok, kind: "auto", detail });

  auto("keys", "Signing and encryption keys present", st.signingKey === "configured" && st.encryptionKey === "configured", st.missing.length ? `Missing: ${st.missing.join(", ")}` : st.signingKey === "invalid" ? "Signing key is invalid" : undefined);
  auto("registry_key", "ONDC registry encryption public key set for this environment", !!cfg.registryEncryptionPublicKey, cfg.registryEncryptionPublicKey ? undefined : "ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY");
  let subscribed = false;
  let detail: string | undefined;
  if (cfg.subscriberId && cfg.uniqueKeyId) {
    try {
      const e = await getRegistry().lookup({ subscriberId: cfg.subscriberId, uniqueKeyId: cfg.uniqueKeyId });
      subscribed = !!e && (!cfg.signingPublicKey || e.signingPublicKey === cfg.signingPublicKey);
      detail = !e ? "Not SUBSCRIBED in the registry" : subscribed ? undefined : "Registry signing key differs from ONDC_SIGNING_PRIVATE_KEY";
    } catch {
      detail = "Registry lookup failed";
    }
  } else detail = "Subscriber id / unique key id not set";
  auto("subscribed", "Subscribed in the ONDC registry with our signing key", subscribed, detail);
  auto("site_verification", "Site verification page is served (/ondc-site-verification.html)", siteVerification() !== null, "needs ONDC_SITE_REQUEST_ID and a signing key");
  auto("gateway_auth", "Gateway X-Gateway-Authorization required on /search", cfg.gatewayAuthRequired, "ONDC_REQUIRE_GATEWAY_AUTH (default on in prod)");
  auto("order_sink", "Order sink wired to enquiry (settlement \"ondc\", fulfilment status mirror)", getOrderSink() !== null, "wireOndcOrderSink() in the composition root");
  auto("disputes", "Dispute resolution (ADR-013) enabled for IGM issues", disputesEnabled(), "DISPUTES_ENABLED");
  auto("gro", "Grievance officer contact configured", !!(cfg.groEmail || cfg.groPhone), "ONDC_GRO_EMAIL or ONDC_GRO_PHONE");
  auto("category_map", "Category map configured for the launch vertical", Object.keys(cfg.categoryMap).length > 0, "ONDC_CATEGORY_MAP");
  auto("prod_env", "Environment", cfg.env === "prod", `ONDC_ENV=${cfg.env}`);

  const cert = await getCertState();
  for (const c of CERT_ITEMS) items.push({ id: `cert.${c.id}`, label: c.label, ok: cert[c.id].done, kind: "manual", detail: cert[c.id].note ?? undefined });
  const autoOk = items.filter((i) => i.kind === "auto" && i.id !== "prod_env").every((i) => i.ok);
  const manualOk = items.filter((i) => i.kind === "manual").every((i) => i.ok);
  return { items, autoOk, manualOk, goLive: autoOk && manualOk, killSwitch: await getKillSwitch() };
}
