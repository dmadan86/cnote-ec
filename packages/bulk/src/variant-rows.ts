// Validation of VARIANT rows. A variant row is a row of the products sheet whose `variant_sku` is filled: `sku` is the PRODUCT's sku,
// the variant:<axis> columns carry the axis values, and price_rupees / moq / availability / available_qty / lead_time_days apply to
// the variant. All variant rows of one product form its complete variant set (it replaces the listing's variants on apply).
import { SKU_RE, categoryAxes, normaliseVariants, MAX_VARIANTS, type VariantInput } from "@cnote/catalogue";
import { parseMoq, parseStockCells, rupeesToPaise, type Bad } from "./cells";
import { VARIANT_PREFIX } from "./columns";
import type { RawRow, RowError } from "./types";
import type { ImportVariant, ValidationContext, ValidationResult } from "./validate";

export const isVariantRow = (r: RawRow): boolean => (r.cells.variant_sku ?? "") !== "";

/**
 * Validates the variant rows and attaches the resulting variant sets to `res.valid` (or appends a variants-only entry for an existing
 * listing that has no product row in the file). `productSkus` are the SKUs of the file's product rows, valid or not.
 */
export function validateVariantRows(rows: RawRow[], ctx: ValidationContext, res: ValidationResult, productSkus: Set<string>): void {
  const byId = new Map(ctx.categories.map((c) => [c.id, c]));
  const groups = new Map<string, RawRow[]>();
  for (const r of rows) groups.set(r.cells.sku ?? "", [...(groups.get(r.cells.sku ?? "") ?? []), r]);

  for (const [sku, group] of groups) {
    const errs: RowError[] = [];
    const at = (row: number): Bad => (column, message) => errs.push({ row, column, message });
    const all = (column: string, message: string) => group.forEach((r) => at(r.row)(column, message));
    const parent = res.valid.find((p) => p.sku === sku && !p.variantsOnly);
    const existing = ctx.existing.get(sku);
    let blocked = false; // the problem is on the product (or already reported), not on a single variant row

    if (!sku || !SKU_RE.test(sku)) {
      all("sku", "SKU may only contain letters, digits, . _ - (max 64 characters)");
      blocked = true;
    } else if (!parent && productSkus.has(sku)) {
      blocked = true; // the product row failed validation and is reported there
    } else if (!parent && !existing) {
      all("sku", `Variant rows need a product: SKU "${sku}" is not in this file and is not one of your listings`);
      blocked = true;
    } else if (!parent && ctx.mode === "create") {
      all("sku", `SKU "${sku}" already exists. Switch to "update by SKU" to change its variants`);
      blocked = true;
    } else if (!parent && existing?.status === "archived") {
      all("sku", `SKU "${sku}" belongs to an archived listing and cannot be edited`);
      blocked = true;
    }

    const category = parent ? byId.get(parent.categoryId) : byId.get(ctx.existingCategoryBySku?.get(sku) ?? "");
    const axes = category ? categoryAxes(category.attributeSchema) : [];
    if (!blocked && !category) {
      all("sku", `Could not read the category of "${sku}" to check its variants`);
      blocked = true;
    } else if (!blocked && !axes.length) {
      all("variant_sku", `Category "${category!.name}" has no variant axes, so its products cannot have variants`);
      blocked = true;
    } else if (!blocked && group.length > MAX_VARIANTS) {
      at(group[MAX_VARIANTS]!.row)("variant_sku", `At most ${MAX_VARIANTS} variants per product`);
      blocked = true;
    }

    const variants: ImportVariant[] = [];
    if (!blocked) {
      const inputs: VariantInput[] = [];
      const seen = new Map<string, number>();
      for (const r of group) {
        const c = r.cells;
        const b = at(r.row);
        const vsku = c.variant_sku ?? "";
        if (!SKU_RE.test(vsku)) b("variant_sku", "Variant SKU may only contain letters, digits, . _ - (max 64 characters)");
        else if (seen.has(vsku.toLowerCase())) b("variant_sku", `Duplicate variant SKU "${vsku}" (also on row ${seen.get(vsku.toLowerCase())})`);
        else seen.set(vsku.toLowerCase(), r.row);

        const axisValues: Record<string, string> = {};
        for (const [k, v] of Object.entries(c)) {
          if (!k.startsWith(VARIANT_PREFIX) || v === "") continue;
          const key = k.slice(VARIANT_PREFIX.length);
          if (!axes.some((a) => a.key === key)) b(k, `"${key}" is not a variant axis of category "${category!.name}"`);
          else axisValues[key] = v;
        }
        let pricePaise: number | undefined;
        if (c.price_rupees) {
          const p = rupeesToPaise(c.price_rupees);
          if (p === null) b("price_rupees", "Price must be an amount in rupees with at most 2 decimals, e.g. 12.50");
          else pricePaise = p;
        }
        const moq = c.moq ? parseMoq(c.moq, b) : undefined;
        const stock = parseStockCells(c, b);
        variants.push({ row: r.row, sku: vsku, axisValues, ...(pricePaise !== undefined ? { pricePaise } : {}), ...(moq !== undefined ? { moq } : {}), ...stock });
        inputs.push({ sku: vsku, axisValues, pricePaise: pricePaise ?? null, moq: moq ?? null, availability: stock.availability, availableQty: stock.availableQty ?? null, leadTimeDays: stock.leadTimeDays ?? null });
      }
      if (!errs.length) {
        // required axes, closed option lists, duplicate combinations, made-to-order lead times: the rules the catalogue enforces on save.
        // The product's own moq / lead time only count when its row is in this file; an existing listing is re-checked on apply.
        const { errors } = normaliseVariants(axes, inputs, { listingMoq: parent?.moq ?? null, listingLeadTimeDays: parent ? (parent.leadTimeDays ?? null) : 0 });
        for (const message of errors) {
          const vsku = /^Variant ([^:]+):/.exec(message)?.[1];
          errs.push({ row: variants.find((v) => v.sku === vsku)?.row ?? group[0]!.row, column: "", message: message.replace(/^Variant [^:]+: /, "") });
        }
      }
    }

    if (errs.length || blocked) {
      res.errors.push(...errs);
      // a partial variant set would delete the rest on apply: apply none, and flag every row of the group
      group.forEach((r) => res.invalidRows.add(r.row));
      if (errs.length && !blocked) res.warnings.push(`Variants of "${sku}" were not applied because some of its variant rows have errors`);
      continue;
    }
    if (parent) parent.variants = variants;
    else {
      res.valid.push({ row: group[0]!.row, sku, categoryId: category!.id, categorySlug: category!.slug, title: "", attributes: {}, imageFiles: [], imageUrls: [], variants, variantsOnly: true });
    }
  }
}
