export type TemplateChannel = "email" | "in_app" | "sms" | "whatsapp";
export type TemplateCategory = "transactional" | "security" | "marketing";

export interface TemplateVariable {
  name: string; // "buyerName" → {{buyerName}}
  description: string;
  example: string;
  required?: boolean;
}

export interface TemplateDefinition {
  key: string; // "auth.password_reset", "lead.matched", …
  name: string;
  description: string;
  category: TemplateCategory;
  channels: TemplateChannel[];
  variables: TemplateVariable[];
  /** Seed content used to create the first published version (and as last-resort fallback). */
  defaults: Partial<Record<TemplateChannel, { subject?: string; preheader?: string; body: string }>>;
}

export interface RenderedEmail {
  subject: string;
  preheader: string | null;
  /** full HTML document: layout header + body + footer, CSS inlined, variables escaped */
  html: string;
  text: string;
  templateVersionId: string | null; // null = code fallback was used
  layoutVersionId: string | null;
}

export interface RenderedText {
  title: string | null;
  body: string;
  templateVersionId: string | null;
}

export interface LayoutTheme {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  /** TemplateAsset id */
  logoAssetId: string | null;
}
