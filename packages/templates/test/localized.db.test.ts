import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineTemplates } from "../src/registry";
import { isChannelEnabled, renderText } from "../src/render";
import { seedDefaultTemplates } from "../src/seed";

const KEY = `test.loc_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
defineTemplates([
  {
    key: KEY, name: "Localized", description: "d", category: "transactional", channels: ["in_app", "email"],
    variables: [{ name: "amount", description: "a", example: "₹1,000" }],
    defaults: { in_app: { subject: "Paid {{amount}}", body: "You were paid {{amount}}." }, email: { subject: "Paid", body: "You were paid {{amount}}." } },
    localized: {
      hi: { in_app: { subject: "भुगतान {{amount}}", body: "आपको {{amount}} मिले।" }, email: { subject: "भुगतान", body: "आपको {{amount}} मिले।" } },
      kn: { in_app: { subject: "ಪಾವತಿ {{amount}}", body: "ನಿಮಗೆ {{amount}} ಪಾವತಿಯಾಗಿದೆ." }, sms: { body: "ignored: channel not declared" } },
    },
  },
]);

async function cleanup() {
  const ts = await prisma.messageTemplate.findMany({ where: { key: KEY }, select: { id: true } });
  const ids = ts.map((t) => t.id);
  await prisma.messageTemplate.updateMany({ where: { id: { in: ids } }, data: { publishedVersionId: null } });
  await prisma.messageTemplateVersion.deleteMany({ where: { templateId: { in: ids } } });
  await prisma.messageTemplate.deleteMany({ where: { id: { in: ids } } });
  for (const loc of ["en", "hi", "kn", "ta"]) for (const ch of ["in_app", "email", "sms"]) await redis.del(`tpl:ptr:${KEY}:${ch}:${loc}`);
}
beforeAll(cleanup);
afterAll(cleanup);

describe("localized seed", () => {
  it("seeds per-locale rows, flags machine-drafted locales for review, is idempotent and renders per locale", async () => {
    await seedDefaultTemplates();
    const rows = await prisma.messageTemplate.findMany({ where: { key: KEY }, include: { published: true } });
    const by = Object.fromEntries(rows.map((r) => [`${r.channel}:${r.locale}`, r]));
    expect(Object.keys(by).sort()).toEqual(["email:en", "email:hi", "in_app:en", "in_app:hi", "in_app:kn"]);
    expect(by["in_app:hi"]!.published!.changeNote).toBe("Initial hi version from code defaults");
    expect(by["in_app:kn"]!.published!.changeNote).toMatch(/^NEEDS REVIEW/);
    expect((await seedDefaultTemplates()).templates).toBe(0);

    expect((await renderText(KEY, "in_app", { amount: "₹5" }, { locale: "hi" })).body).toBe("आपको ₹5 मिले।");
    expect((await renderText(KEY, "in_app", { amount: "₹5" }, { locale: "kn" })).title).toBe("ಪಾವತಿ ₹5");
    expect((await renderText(KEY, "in_app", { amount: "₹5" }, { locale: "ta" })).body).toBe("You were paid ₹5."); // falls back to en
    expect(await isChannelEnabled(KEY, "in_app", "hi")).toBe(true);
  });

  it("code fallback uses the localized default when no DB row exists", async () => {
    await cleanup();
    expect((await renderText(KEY, "in_app", { amount: "₹9" }, { locale: "hi" })).body).toBe("आपको ₹9 मिले।");
    expect((await renderText(KEY, "in_app", { amount: "₹9" }, { locale: "xx" })).body).toBe("You were paid ₹9.");
  });
});
