import type { TemplateDefinition } from "./types";

const defs = new Map<string, TemplateDefinition>();

/** Register template definitions (each module registers its own keys at import time). Re-registering a key replaces it (HMR-safe). */
export function defineTemplates(list: TemplateDefinition[]): void {
  for (const d of list) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(d.key)) throw new Error(`Invalid template key "${d.key}" (expected e.g. "auth.password_reset")`);
    defs.set(d.key, d);
  }
}

export function listTemplateDefinitions(): TemplateDefinition[] {
  return [...defs.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function getTemplateDefinition(key: string): TemplateDefinition | undefined {
  return defs.get(key);
}

/** Example values for every variable of a definition (used by preview and test sends). */
export function exampleVars(def: TemplateDefinition): Record<string, string> {
  return Object.fromEntries(def.variables.map((v) => [v.name, v.example]));
}
