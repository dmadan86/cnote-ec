import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import { listEmailLog, maskEmailsInText } from "../src";

// Staff delivery log (admin /queues/email): masked recipients, addresses masked inside provider errors too.
describe("listEmailLog", () => {
  it("filters, masks error text, and keyset-paginates newest first", async () => {
    const tag = `el-${randomUUID()}`;
    const mk = (i: number, status: "sent" | "failed") =>
      prisma.emailMessage.create({
        data: {
          toMasked: "a***@x.com", template: tag, category: "transactional", subject: "s", status,
          lastError: status === "failed" ? "bounce for bob@example.com" : null, sentAt: status === "sent" ? new Date() : null,
          createdAt: new Date(Date.now() - i * 1000),
        },
      });
    for (let i = 0; i < 3; i++) await mk(i, i === 0 ? "failed" : "sent");
    try {
      const p1 = await listEmailLog({ template: tag.toUpperCase(), limit: 2 });
      expect(p1.items).toHaveLength(2);
      expect(p1.items[0]!.lastError).toBe("bounce for b***@example.com");
      expect(p1.items[1]!.sentAt).toBeTruthy();
      const p2 = await listEmailLog({ template: tag, limit: 2, cursor: p1.nextCursor! });
      expect(p2.items).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();
      expect((await listEmailLog({ template: tag, status: "failed" })).items).toHaveLength(1);
      expect((await listEmailLog({ template: tag, status: "bogus" })).items).toHaveLength(3); // unknown status = no filter
      expect((await listEmailLog({ template: tag, limit: 0 })).items).toHaveLength(1); // clamped to >= 1
      expect(await listEmailLog()).toBeTruthy();
    } finally {
      await prisma.emailMessage.deleteMany({ where: { template: tag } });
    }
  });

  it("maskEmailsInText masks every address and leaves other text alone", () => {
    expect(maskEmailsInText("to a.b@x.in and c@y.co.in failed")).toBe("to a***@x.in and c***@y.co.in failed");
    expect(maskEmailsInText("no address here")).toBe("no address here");
  });
});
