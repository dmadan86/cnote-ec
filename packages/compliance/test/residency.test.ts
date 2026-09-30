import { describe, expect, it, vi } from "vitest";
import { ResidencyError, assertIndiaResidency, getResidencyReport } from "../src";

const base = { DATABASE_URL: "postgres://u:p@db.ap-south-1.rds.amazonaws.com:5432/x", REDIS_URL: "redis://cache.ap-south-1.cache.amazonaws.com:6379", MEDIA_DRIVER: "s3", MEDIA_REGION: "ap-south-1" };
const status = (env: NodeJS.ProcessEnv, name: string) => getResidencyReport(env).checks.find((c) => c.name.startsWith(name))?.status;

describe("residency report matrix", () => {
  it("passes an all-India AWS setup", () => {
    const r = getResidencyReport(base);
    expect(r.ok).toBe(true);
    expect(r.enforce).toBe(false);
    expect(r.checks.map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
  });
  it.each([
    ["postgres://x@db.us-east-1.rds.amazonaws.com/x", "violation"],
    ["postgres://x@db.eu-west-2.rds.amazonaws.com/x", "violation"],
    ["postgres://x@x.postgres.database.azure.com/x", "warn"],
    ["postgres://x@db.centralindia.postgres.database.azure.com/x", "ok"],
    ["postgres://x@db.asia-south1.gcp.example/x", "ok"],
    ["postgres://x@westeurope.example/x", "violation"],
    ["postgres://x@localhost:5432/x", "ok"],
    ["postgres://x@postgres:5432/x", "ok"],
    ["postgres://x@10.1.2.3:5432/x", "warn"],
  ])("database %s -> %s", (url, want) => expect(status({ DATABASE_URL: url }, "Database")).toBe(want));
  it("host allowlist regex overrides heuristics; invalid regex is a violation", () => {
    expect(status({ DATABASE_URL: "postgres://x@10.1.2.3/x", DATA_RESIDENCY_DB_HOST_ALLOW: "^10\\.1\\." }, "Database")).toBe("ok");
    expect(status({ DATABASE_URL: "postgres://x@10.9.9.9/x", DATA_RESIDENCY_DB_HOST_ALLOW: "^10\\.1\\." }, "Database")).toBe("violation");
    expect(status({ DATABASE_URL: "postgres://x@10.1.2.3/x", DATA_RESIDENCY_DB_HOST_ALLOW: "(" }, "Database")).toBe("violation");
  });
  it("redis and live db are checked too; unparseable urls fall back to host extraction", () => {
    expect(status({ REDIS_URL: "redis://r.us-west-2.cache.amazonaws.com" }, "Redis")).toBe("violation");
    expect(status({ LIVE_DATABASE_URL: "postgres://x@live.ap-south-2.rds.amazonaws.com/x" }, "Live database")).toBe("ok");
    expect(status({ REDIS_URL: "cache.ap-south-1.example:6379" }, "Redis")).toBe("ok");
    expect(getResidencyReport({ DATABASE_URL: "" }).checks.find((c) => c.name === "Database")).toBeUndefined();
  });
  it("media: local ok; s3/gcs need an India region; foreign region violates; unset violates", () => {
    expect(status({ MEDIA_DRIVER: "local" }, "Media")).toBe("ok");
    expect(status({}, "Media")).toBe("ok");
    expect(status({ MEDIA_DRIVER: "s3", MEDIA_REGION: "ap-south-1" }, "Media")).toBe("ok");
    expect(status({ MEDIA_DRIVER: "s3", MEDIA_REGION: "eu-west-1" }, "Media")).toBe("violation");
    expect(status({ MEDIA_DRIVER: "s3", MEDIA_ENDPOINT: "https://s3.us-east-1.amazonaws.com" }, "Media")).toBe("violation");
    expect(status({ MEDIA_DRIVER: "gcs", MEDIA_REGION: "asia-south1" }, "Media")).toBe("ok");
    expect(status({ MEDIA_DRIVER: "s3" }, "Media")).toBe("violation");
    expect(status({ MEDIA_DRIVER: "azure", MEDIA_REGION: "somewhere" }, "Media")).toBe("violation");
  });
  it("R2 cannot be pinned to India: violation unless acknowledged; EU jurisdiction always violates", () => {
    const r2 = { MEDIA_DRIVER: "r2", MEDIA_ENDPOINT: "https://acct.r2.cloudflarestorage.com", MEDIA_REGION: "auto" };
    expect(status(r2, "Media")).toBe("violation");
    expect(status({ ...r2, DATA_RESIDENCY_R2_ACK: "true" }, "Media")).toBe("warn");
    expect(status({ MEDIA_DRIVER: "r2", DATA_RESIDENCY_R2_ACK: "true" }, "Media")).toBe("warn");
    expect(status({ MEDIA_DRIVER: "r2", MEDIA_ENDPOINT: "https://acct.eu.r2.cloudflarestorage.com", DATA_RESIDENCY_R2_ACK: "true" }, "Media")).toBe("violation");
  });
  it("flags external AI providers as a warning", () => {
    expect(status({ AI_PROVIDER: "anthropic" }, "AI")).toBe("warn");
    expect(status({ AI_PROVIDER: "heuristic" }, "AI")).toBeUndefined();
  });
});

describe("assertIndiaResidency", () => {
  it("throws only when enforced", () => {
    const bad = { ...base, DATABASE_URL: "postgres://x@db.us-east-1.rds.amazonaws.com/x" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(assertIndiaResidency(bad).ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(() => assertIndiaResidency({ ...bad, DATA_RESIDENCY_ENFORCE: "true" })).toThrow(ResidencyError);
    try {
      assertIndiaResidency({ ...bad, DATA_RESIDENCY_ENFORCE: "true" });
    } catch (e) {
      expect((e as ResidencyError).violations[0]!.name).toBe("Database");
      expect((e as Error).message).toMatch(/us-east-1/);
    }
    expect(assertIndiaResidency({ ...base, DATA_RESIDENCY_ENFORCE: "true" }).ok).toBe(true);
    warn.mockRestore();
  });
});
