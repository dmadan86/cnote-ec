import { prisma } from "@cnote/db";
import { bust, tplPtrKey } from "./cache";
import { DEFAULT_LAYOUT } from "./assemble";
import { listTemplateDefinitions } from "./registry";
import { cleanEmailHtml, cleanPlainText } from "./sanitize";

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * Idempotent: creates the "default" layout (v1 published) and, for every registered definition/channel that has
 * no DB row yet, a published v1 from the code defaults. Existing rows (and staff edits) are never touched.
 */
export async function seedDefaultTemplates(): Promise<{ layouts: number; templates: number }> {
  let layouts = 0;
  let templates = 0;

  if (!(await prisma.messageLayout.findUnique({ where: { key: "default" } }))) {
    try {
      await prisma.$transaction(async (tx) => {
        const l = await tx.messageLayout.create({ data: { key: "default", name: "Default" } });
        const v = await tx.messageLayoutVersion.create({
          data: {
            layoutId: l.id, version: 1, status: "published", publishedAt: new Date(),
            headerHtml: cleanEmailHtml(DEFAULT_LAYOUT.headerHtml), footerHtml: cleanEmailHtml(DEFAULT_LAYOUT.footerHtml),
            theme: JSON.parse(JSON.stringify(DEFAULT_LAYOUT.theme)),
          },
        });
        await tx.messageLayout.update({ where: { id: l.id }, data: { publishedVersionId: v.id } });
      });
      layouts++;
    } catch (e) {
      if (!isUnique(e)) throw e; // concurrent seeder won
    }
  }

  for (const def of listTemplateDefinitions()) {
    for (const channel of def.channels) {
      const d = def.defaults[channel];
      if (!d) continue;
      if (await prisma.messageTemplate.findUnique({ where: { key_channel_locale: { key: def.key, channel, locale: "en" } } })) continue;
      try {
        await prisma.$transaction(async (tx) => {
          const t = await tx.messageTemplate.create({ data: { key: def.key, channel, locale: "en", name: def.name, description: def.description } });
          const email = channel === "email";
          const v = await tx.messageTemplateVersion.create({
            data: {
              templateId: t.id, version: 1, status: "published", publishedAt: new Date(), changeNote: "Initial version from code defaults",
              subject: d.subject ? cleanPlainText(d.subject, "Subject", { multiline: false }) : null,
              preheader: email && d.preheader ? cleanPlainText(d.preheader, "Preheader", { multiline: false }) : null,
              body: email ? cleanEmailHtml(d.body) : cleanPlainText(d.body),
            },
          });
          await tx.messageTemplate.update({ where: { id: t.id }, data: { publishedVersionId: v.id } });
        });
        templates++;
        await bust(tplPtrKey(def.key, channel, "en"));
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
    }
  }
  return { layouts, templates };
}
