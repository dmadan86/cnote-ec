"use client";
import { LIMITS, parseMarkup, richTextSchema, toMarkup, type ImageRef, type Section, type SectionOf } from "@cnote/storefront/document";
import type { RenderData } from "@cnote/storefront/render";
import { Alert, Field, Select, Textarea } from "@cnote/ui";
import { useId, useState } from "react";
import { CheckField, ListEditor, NumberField, SelectField, TextField } from "./fields";
import { ImagePicker, ProductMultiPicker } from "./pickers";
import type { SellerImageLite } from "./types";

interface Common {
  images: SellerImageLite[];
  data: RenderData;
  /** bumped on undo/redo/restore so uncontrolled-ish fields re-read the document */
  resetToken: number;
}
type P<T extends Section["type"]> = Common & { s: SectionOf<T>; set: (patch: Partial<SectionOf<T>>) => void };

const TONES = [
  { value: "default", label: "Plain" },
  { value: "surface", label: "Soft tint" },
  { value: "brand", label: "Brand colour" },
] as const;
const Tone = ({ s, set }: { s: Section; set: (p: { tone: Section["tone"] }) => void }) => (
  <SelectField label="Background" value={s.tone} onChange={(tone) => set({ tone })} options={[...TONES]} />
);

/** Rich text is edited as light markup; the local draft avoids the field rewriting what you type. */
function RichField({ label, value, onChange }: { label: string; value: SectionOf<"about">["body"]; onChange: (v: SectionOf<"about">["body"]) => void }) {
  const id = useId();
  const [text, setText] = useState(() => toMarkup(value));
  const parsed = parseMarkup(text);
  const ok = richTextSchema.safeParse(parsed);
  return (
    <Field
      label={label}
      htmlFor={id}
      hint="Blank line = new paragraph. **bold**, *italic*, [label](https://link). Start lines with - for bullets or 1. for numbers."
      error={ok.success ? undefined : ok.error.issues[0]?.message ?? "This text is too long."}
    >
      <Textarea
        id={id}
        rows={9}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const p = parseMarkup(e.target.value);
          if (richTextSchema.safeParse(p).success) onChange(p);
        }}
      />
    </Field>
  );
}

export function BlockForm({ s, set, ...common }: { s: Section; set: (patch: Record<string, unknown>) => void } & Common) {
  const k = `${s.id}:${common.resetToken}`;
  switch (s.type) {
    case "hero": return <HeroForm key={k} s={s} set={set} {...common} />;
    case "productGrid": return <GridForm key={k} s={s} set={set} {...common} />;
    case "featuredProduct": return <FeaturedForm key={k} s={s} set={set} {...common} />;
    case "about": return <AboutForm key={k} s={s} set={set} {...common} />;
    case "certifications": return <CertForm key={k} s={s} set={set} {...common} />;
    case "gallery": return <GalleryForm key={k} s={s} set={set} {...common} />;
    case "stats": return <StatsForm key={k} s={s} set={set} {...common} />;
    case "testimonials": return <TestimonialsForm key={k} s={s} set={set} {...common} />;
    case "faq": return <FaqForm key={k} s={s} set={set} {...common} />;
    case "contact": return <ContactForm key={k} s={s} set={set} {...common} />;
    case "trustStrip":
      return <Alert tone="info">The trust strip shows your verification level, trust score and buyer rating straight from the marketplace. It cannot be edited, and it is always shown on every page. You can only choose where it sits.</Alert>;
    case "spacer":
      return <SelectField label="Size" value={s.size} onChange={(size) => set({ size })} options={[{ value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }]} />;
    case "divider":
      return <p className="text-sm text-muted">A thin line between sections. Nothing to configure.</p>;
  }
}

function HeroForm({ s, set, images }: P<"hero">) {
  return (
    <div className="space-y-4">
      <TextField label="Headline" value={s.headline} max={LIMITS.headline} onChange={(headline) => set({ headline })} />
      <TextField label="Supporting text" value={s.subhead} max={LIMITS.subhead} multiline rows={3} onChange={(subhead) => set({ subhead })} />
      <TextField label="Button text" value={s.ctaLabel} max={LIMITS.label} hint="The button always opens the marketplace quote form for your business." onChange={(ctaLabel) => set({ ctaLabel })} />
      <SelectField label="Layout" value={s.layout} onChange={(layout) => set({ layout })} options={[{ value: "split", label: "Text and image side by side" }, { value: "centered", label: "Centered text" }, { value: "banner", label: "Wide image above text" }]} />
      <ImagePicker label="Image" value={s.image} images={images} onChange={(image: ImageRef | null) => set({ image })} defaultAlt={s.headline} />
      <Tone s={s} set={set} />
    </div>
  );
}

function GridForm({ s, set, data }: P<"productGrid">) {
  const catId = useId();
  return (
    <div className="space-y-4">
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <SelectField
        label="Products to show"
        value={s.source.kind}
        onChange={(kind) => set({ source: kind === "all" ? { kind } : kind === "category" ? { kind, categorySlug: data.categories[0]?.slug ?? "" } : { kind, listingIds: [] } })}
        options={[{ value: "all", label: "All my published products" }, { value: "category", label: "One category" }, { value: "handpicked", label: "Hand-picked products" }]}
        hint="Only listings that are published and approved are ever shown."
      />
      {s.source.kind === "category" ? (
        data.categories.length ? (
          <Field label="Category" htmlFor={catId}>
            <Select id={catId} value={s.source.categorySlug} onChange={(e) => set({ source: { kind: "category", categorySlug: e.target.value } })}>
              {data.categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </Select>
          </Field>
        ) : <p className="text-sm text-muted">You have no published listings with a category yet.</p>
      ) : null}
      {s.source.kind === "handpicked" ? <ProductMultiPicker products={data.products} selected={s.source.listingIds} max={LIMITS.handpickedMax} onChange={(listingIds) => set({ source: { kind: "handpicked", listingIds } })} /> : null}
      <NumberField label="How many to show" value={s.limit} min={1} max={LIMITS.productGridMax} onChange={(limit) => set({ limit })} />
      <SelectField label="Columns (wide screens)" value={String(s.columns) as "2" | "3" | "4"} onChange={(v) => set({ columns: Number(v) as 2 | 3 | 4 })} options={[{ value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]} />
      <Tone s={s} set={set} />
    </div>
  );
}

function FeaturedForm({ s, set, data }: P<"featuredProduct">) {
  const id = useId();
  return (
    <div className="space-y-4">
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <Field label="Product" htmlFor={id}>
        <Select id={id} value={s.listingId ?? ""} onChange={(e) => set({ listingId: e.target.value || null })}>
          <option value="">Automatic (your first listing)</option>
          {data.products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </Select>
      </Field>
      <Tone s={s} set={set} />
    </div>
  );
}

function AboutForm({ s, set, images }: P<"about">) {
  return (
    <div className="space-y-4">
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <RichField label="Text" value={s.body} onChange={(body) => set({ body })} />
      <ImagePicker label="Image" value={s.image} images={images} onChange={(image) => set({ image })} defaultAlt={s.title} />
      <Tone s={s} set={set} />
    </div>
  );
}

function CertForm({ s, set }: P<"certifications">) {
  return (
    <div className="space-y-4">
      <Alert tone="warning">Certifications are declared by you and shown as such. List only certificates you hold. Verified status comes from the platform trust strip.</Alert>
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <ListEditor label="Certifications" items={s.items} max={LIMITS.certifications} addLabel="Add certification" blank={() => ({ name: "", issuer: "", year: "" })} onChange={(items) => set({ items })}
        render={(c, upd) => (
          <>
            <TextField label="Name" value={c.name} max={LIMITS.short} onChange={(name) => upd({ name })} />
            <TextField label="Issued by" value={c.issuer} max={LIMITS.short} onChange={(issuer) => upd({ issuer })} />
            <TextField label="Year" value={c.year} max={4} onChange={(year) => upd({ year })} />
          </>
        )} />
      <Tone s={s} set={set} />
    </div>
  );
}

function GalleryForm({ s, set, images }: P<"gallery">) {
  return (
    <div className="space-y-4">
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <ListEditor label="Images" items={s.images} max={LIMITS.gallery} addLabel="Add image" blank={() => ({ src: "placeholder:factory", alt: "" }) as ImageRef} onChange={(list) => set({ images: list })}
        render={(im, upd, i) => <ImagePicker label={`Image ${i + 1}`} value={im} images={images} nullable={false} onChange={(v) => v && upd(v)} />} />
      <Tone s={s} set={set} />
    </div>
  );
}

function StatsForm({ s, set }: P<"stats">) {
  return (
    <div className="space-y-4">
      <Alert tone="warning">Only publish numbers you can stand behind. Buyers will read these as facts about your business.</Alert>
      <ListEditor label="Numbers" items={s.items} max={LIMITS.stats} min={1} addLabel="Add number" blank={() => ({ value: "", label: "" })} onChange={(items) => set({ items })}
        render={(it, upd) => (
          <>
            <TextField label="Value" value={it.value} max={12} placeholder="e.g. 15+" onChange={(value) => upd({ value })} />
            <TextField label="Label" value={it.label} max={LIMITS.label} placeholder="e.g. Years in business" onChange={(label) => upd({ label })} />
          </>
        )} />
      <Tone s={s} set={set} />
    </div>
  );
}

function TestimonialsForm({ s, set, data }: P<"testimonials">) {
  return (
    <div className="space-y-4">
      <Alert tone="info">Reviews on this block come only from approved buyer reviews on your products. You cannot write or edit them. {data.testimonials.length ? `${data.testimonials.length} qualifying review${data.testimonials.length === 1 ? "" : "s"} available now.` : "None are available yet, so the block stays hidden on your live storefront until buyers leave reviews."}</Alert>
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <NumberField label="How many to show" value={s.limit} min={1} max={LIMITS.testimonials} onChange={(limit) => set({ limit })} />
      <Tone s={s} set={set} />
    </div>
  );
}

function FaqForm({ s, set }: P<"faq">) {
  return (
    <div className="space-y-4">
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <ListEditor label="Questions" items={s.items} max={LIMITS.faq} min={1} addLabel="Add question" blank={() => ({ q: "", a: "" })} onChange={(items) => set({ items })}
        render={(f, upd) => (
          <>
            <TextField label="Question" value={f.q} max={120} onChange={(q) => upd({ q })} />
            <TextField label="Answer" value={f.a} max={LIMITS.body} multiline rows={3} onChange={(a) => upd({ a })} />
          </>
        )} />
      <Tone s={s} set={set} />
    </div>
  );
}

function ContactForm({ s, set }: P<"contact">) {
  return (
    <div className="space-y-4">
      <Alert tone="info">Buyers contact you through the marketplace quote form. Your phone number and email are never printed on the page; they are shared with a buyer only after you accept their enquiry.</Alert>
      <TextField label="Title" value={s.title} max={LIMITS.title} onChange={(title) => set({ title })} />
      <TextField label="Text" value={s.body} max={300} multiline rows={3} onChange={(body) => set({ body })} />
      <TextField label="Button text" value={s.ctaLabel} max={LIMITS.label} onChange={(ctaLabel) => set({ ctaLabel })} />
      <CheckField label="Show my city" checked={s.showCity} onChange={(showCity) => set({ showCity })} hint="Taken from your business profile." />
      <Tone s={s} set={set} />
    </div>
  );
}
