// ADR-002 / ADR-005 / ADR-009: rate contracts are private between two parties and must never influence search ranking, lead matching,
// trust scores or ad placement. Guards the sources (a contract input cannot be wired into ranking without this failing) and proves
// that the matching pipeline is a pure function with no contract input.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rankCandidates, type Candidate, type SellerSignals } from "../src/scoring";

const root = join(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
const TERM = /rate[_ -]?contract|RateContract|call[_-]?off|callOff/i;

describe("rate contracts stay out of ranking, matching, trust and ads (ADR-005)", () => {
  it("the matching and scoring sources never mention contracts", () => {
    for (const f of ["scoring.ts", "matching.ts", "leads.ts", "create.ts"]) expect(readFileSync(join(root, "enquiry", "src", f), "utf8"), f).not.toMatch(TERM);
  });

  it("search, catalogue retrieval, identity trust scoring, reviews and ads sources never mention contracts", () => {
    for (const pkg of ["search", "ads", "reviews", "promotions"]) {
      for (const f of walk(join(root, pkg, "src"))) expect(readFileSync(f, "utf8"), f).not.toMatch(TERM);
    }
    for (const f of ["retrieval.ts", "tiers.ts", "live.ts"]) expect(readFileSync(join(root, "catalogue", "src", f), "utf8"), f).not.toMatch(TERM);
    for (const f of walk(join(root, "identity", "src"))) {
      if (/trust|score/i.test(f)) expect(readFileSync(f, "utf8"), f).not.toMatch(TERM);
    }
  });

  it("the contract tables are read only by the enquiry module", () => {
    const owners = new Set<string>();
    for (const pkg of readdirSync(root)) {
      let files: string[] = [];
      try { files = walk(join(root, pkg, "src")); } catch { continue; }
      for (const f of files) if (/prisma\.rateContract|tx\.rateContract|(FROM|INTO|UPDATE) rate_contract/i.test(readFileSync(f, "utf8"))) owners.add(pkg);
    }
    expect([...owners].sort()).toEqual(["db", "enquiry"]);
  });

  it("lead ranking is a pure function of similarity, trust and geography: it takes no contract input", () => {
    const cands: Candidate[] = ["a", "b", "c"].map((id, i) => ({ sellerBusinessId: id, listingId: `l-${id}`, similarity: 0.9 - i * 0.1 }));
    const sig = (trustScore: number): SellerSignals => ({ trustScore, verificationTier: 2, badgeActive: true, city: "Pune", state: "MH", pincode: "411001" });
    const profiles = new Map([["a", sig(60)], ["b", sig(90)], ["c", sig(70)]]);
    const geo = { city: "Pune", state: "MH", pincode: "411001" };
    const base = rankCandidates(cands, profiles, geo);
    // Extra fields that a contract relationship could plausibly add are ignored by the ranking.
    const withContracts = new Map([...profiles].map(([k, v]) => [k, { ...v, hasRateContract: k === "c", contractValuePaise: 9e9 } as SellerSignals]));
    expect(rankCandidates(cands, withContracts, geo)).toEqual(base);
  });
});
