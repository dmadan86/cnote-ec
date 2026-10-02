import { CookieTable as KitCookieTable, durationText } from "@cnote/next-kit/consent";
import { STORAGE_REGISTRY, type StorageCategory } from "./registry";

export { durationText };

/** The buyer web's cookie table: the shared component bound to this app's registry (the single source of truth). */
export function CookieTable({ category, label }: { category: StorageCategory; label: string }) {
  return <KitCookieTable registry={STORAGE_REGISTRY} category={category} label={label} />;
}
