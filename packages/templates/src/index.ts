// @cnote/templates — admin-editable email/notification content (DB is the source of truth).
// Code owns template KEYS + their variables (registry); staff own the words, layout and images.
// PUBLIC CONTRACT — @cnote/email, @cnote/notifications and apps/admin depend on these. Extend, don't break.

export type { LayoutTheme, RenderedEmail, RenderedText, TemplateCategory, TemplateChannel, TemplateContentDefault, TemplateDefinition, TemplateVariable } from "./types";
export { defineTemplates, exampleVars, getTemplateDefinition, listTemplateDefinitions } from "./registry";
export { isChannelEnabled, previewEmail, previewLayout, previewText, renderEmail, renderEmailContent, renderText, type RenderEmailOptions } from "./render";
export { seedDefaultTemplates } from "./seed";
export { DEFAULT_LAYOUT, DEFAULT_THEME, FONT_FAMILIES, parseTheme } from "./assemble";
export { cleanEmailHtml, cleanPlainText, htmlToText, neutralizeMustache, sanitizeEmailHtml, TEMPLATE_ASSET_PATH } from "./sanitize";
export {
  MAX_ASSET_BYTES, deleteTemplateAsset, listTemplateAssets, readTemplateAsset, templateAssetCdnUrl, uploadTemplateAsset, type TemplateAssetView,
} from "./assets";
export * from "./store";
