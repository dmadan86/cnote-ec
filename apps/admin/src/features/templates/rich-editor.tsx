"use client";
import { cn } from "@cnote/ui";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Braces, Eraser, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Quote,
  Redo2, Strikethrough, Underline, Undo2, Unlink,
} from "lucide-react";
import { useId, useRef, useState } from "react";

export interface EditorVariable {
  name: string;
  description: string;
}

const SAFE_LINK = /^(https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+|\{\{[\w.]+\}\})$/i;
export const isSafeLink = (u: string) => SAFE_LINK.test(u.trim());

const EDITOR_CSS = `
.tpl-editor .ProseMirror{min-height:14rem;padding:.75rem 1rem;outline:none;font-size:15px;line-height:1.55}
.tpl-editor .ProseMirror:focus-visible{box-shadow:inset 0 0 0 2px var(--color-brand-500)}
.tpl-editor .ProseMirror p{margin:0 0 .75rem}
.tpl-editor .ProseMirror h1{font-size:1.5rem;font-weight:700;margin:0 0 .75rem}
.tpl-editor .ProseMirror h2{font-size:1.25rem;font-weight:700;margin:0 0 .6rem}
.tpl-editor .ProseMirror h3{font-size:1.05rem;font-weight:700;margin:0 0 .5rem}
.tpl-editor .ProseMirror ul{list-style:disc;padding-left:1.4rem;margin:0 0 .75rem}
.tpl-editor .ProseMirror ol{list-style:decimal;padding-left:1.4rem;margin:0 0 .75rem}
.tpl-editor .ProseMirror blockquote{border-left:3px solid var(--color-accent-500);padding-left:.8rem;color:#4b5563;margin:0 0 .75rem}
.tpl-editor .ProseMirror a{color:var(--color-brand-700);text-decoration:underline}
.tpl-editor .ProseMirror hr{border:0;border-top:1px solid var(--color-line);margin:1rem 0}
.tpl-editor .ProseMirror img{max-width:100%;height:auto}
.tpl-editor .ProseMirror img.ProseMirror-selectednode{outline:2px solid var(--color-brand-500)}
.tpl-editor .ProseMirror p.is-editor-empty:first-child::before{content:attr(data-placeholder);color:#9ca3af;float:left;height:0;pointer-events:none}
`;

function Btn({ label, onClick, active, disabled, children }: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault() /* keep the editor selection */}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-ink transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-40",
        active && "bg-brand-50 text-brand-700",
      )}
    >
      {children}
    </button>
  );
}
const Sep = () => <span aria-hidden className="mx-1 h-5 w-px bg-line" />;

function Toolbar({ editor, variables }: { editor: Editor; variables: EditorVariable[] }) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [varsOpen, setVarsOpen] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), strike: e.isActive("strike"),
      h1: e.isActive("heading", { level: 1 }), h2: e.isActive("heading", { level: 2 }), h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"), quote: e.isActive("blockquote"), link: e.isActive("link"),
      left: e.isActive({ textAlign: "left" }), center: e.isActive({ textAlign: "center" }), right: e.isActive({ textAlign: "right" }), justify: e.isActive({ textAlign: "justify" }),
      color: (e.getAttributes("textStyle").color as string | undefined) ?? "#111827",
      canUndo: e.can().undo(), canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();

  function openLink() {
    setLinkUrl((editor.getAttributes("link").href as string | undefined) ?? "https://");
    setLinkErr(null);
    setLinkOpen(true);
  }
  function applyLink() {
    const url = linkUrl.trim();
    if (!isSafeLink(url)) return setLinkErr("Use an http(s):// or mailto: address (or a {{variable}}).");
    c().extendMarkRange("link").setLink({ href: url, target: "_blank", rel: "noopener noreferrer" }).run();
    setLinkOpen(false);
  }

  async function upload(file: File) {
    setUploadErr(null);
    if (file.size > 2 * 1024 * 1024) return setUploadErr("Image is larger than 2 MB.");
    const alt = window.prompt("Describe the image for people who can't see it (alt text):", "");
    if (alt === null) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("alt", alt);
      const res = await fetch("/templates/assets", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) return setUploadErr(data.error ?? "Upload failed.");
      c().setImage({ src: data.url, alt: alt.trim() }).run();
    } catch {
      setUploadErr("Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div role="toolbar" aria-label="Formatting" aria-controls={id} className="border-b border-line bg-surface">
      <div className="flex flex-wrap items-center gap-0.5 p-1.5">
        <Btn label="Heading 1" active={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()}><Heading1 className="size-4" aria-hidden /></Btn>
        <Btn label="Heading 2" active={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()}><Heading2 className="size-4" aria-hidden /></Btn>
        <Btn label="Heading 3" active={s.h3} onClick={() => c().toggleHeading({ level: 3 }).run()}><Heading3 className="size-4" aria-hidden /></Btn>
        <Sep />
        <Btn label="Bold" active={s.bold} onClick={() => c().toggleBold().run()}><Bold className="size-4" aria-hidden /></Btn>
        <Btn label="Italic" active={s.italic} onClick={() => c().toggleItalic().run()}><Italic className="size-4" aria-hidden /></Btn>
        <Btn label="Underline" active={s.underline} onClick={() => c().toggleUnderline().run()}><Underline className="size-4" aria-hidden /></Btn>
        <Btn label="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()}><Strikethrough className="size-4" aria-hidden /></Btn>
        <label className="ml-1 inline-flex h-8 items-center gap-1 rounded-md px-1 text-xs text-muted hover:bg-canvas">
          <span className="sr-only">Text colour</span>
          <input type="color" aria-label="Text colour" value={/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#111827"} onChange={(e) => c().setColor(e.target.value).run()} className="size-6 cursor-pointer rounded border border-line bg-transparent p-0" />
        </label>
        <Btn label="Clear text colour" onClick={() => c().unsetColor().run()}><Eraser className="size-4" aria-hidden /></Btn>
        <Sep />
        <Btn label="Align left" active={s.left} onClick={() => c().setTextAlign("left").run()}><AlignLeft className="size-4" aria-hidden /></Btn>
        <Btn label="Align centre" active={s.center} onClick={() => c().setTextAlign("center").run()}><AlignCenter className="size-4" aria-hidden /></Btn>
        <Btn label="Align right" active={s.right} onClick={() => c().setTextAlign("right").run()}><AlignRight className="size-4" aria-hidden /></Btn>
        <Btn label="Justify" active={s.justify} onClick={() => c().setTextAlign("justify").run()}><AlignJustify className="size-4" aria-hidden /></Btn>
        <Sep />
        <Btn label="Bulleted list" active={s.bullet} onClick={() => c().toggleBulletList().run()}><List className="size-4" aria-hidden /></Btn>
        <Btn label="Numbered list" active={s.ordered} onClick={() => c().toggleOrderedList().run()}><ListOrdered className="size-4" aria-hidden /></Btn>
        <Btn label="Quote" active={s.quote} onClick={() => c().toggleBlockquote().run()}><Quote className="size-4" aria-hidden /></Btn>
        <Btn label="Horizontal rule" onClick={() => c().setHorizontalRule().run()}><Minus className="size-4" aria-hidden /></Btn>
        <Sep />
        <Btn label="Add or edit link" active={s.link} onClick={openLink}><Link2 className="size-4" aria-hidden /></Btn>
        <Btn label="Remove link" disabled={!s.link} onClick={() => c().extendMarkRange("link").unsetLink().run()}><Unlink className="size-4" aria-hidden /></Btn>
        <Btn label={uploading ? "Uploading image…" : "Insert image"} disabled={uploading} onClick={() => fileRef.current?.click()}><ImagePlus className="size-4" aria-hidden /></Btn>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        <Sep />
        <Btn label="Undo" disabled={!s.canUndo} onClick={() => c().undo().run()}><Undo2 className="size-4" aria-hidden /></Btn>
        <Btn label="Redo" disabled={!s.canRedo} onClick={() => c().redo().run()}><Redo2 className="size-4" aria-hidden /></Btn>
        {variables.length ? (
          <div className="relative ml-auto">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={varsOpen}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setVarsOpen((v) => !v)}
              onKeyDown={(e) => e.key === "Escape" && setVarsOpen(false)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2 text-xs font-medium hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              <Braces className="size-3.5" aria-hidden /> Insert variable
            </button>
            {varsOpen ? (
              <ul role="menu" aria-label="Variables" className="absolute right-0 z-20 mt-1 max-h-64 w-72 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg" onKeyDown={(e) => e.key === "Escape" && setVarsOpen(false)}>
                {variables.map((v) => (
                  <li key={v.name} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { c().insertContent({ type: "text", text: `{{${v.name}}}` }).run(); setVarsOpen(false); }}
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none"
                    >
                      <code className="text-xs font-semibold text-brand-700">{`{{${v.name}}}`}</code>
                      <span className="text-xs text-muted">{v.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      {linkOpen ? (
        <form className="flex flex-wrap items-center gap-2 border-t border-line bg-canvas px-2 py-1.5" onSubmit={(e) => { e.preventDefault(); applyLink(); }}>
          <label htmlFor={`${id}-url`} className="text-xs font-medium">Link address</label>
          <input id={`${id}-url`} autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setLinkOpen(false)} aria-invalid={!!linkErr} className="h-8 min-w-64 flex-1 rounded-md border border-line bg-surface px-2 text-sm" />
          <button type="submit" className="h-8 rounded-full bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700">Apply</button>
          <button type="button" onClick={() => setLinkOpen(false)} className="h-8 rounded-full px-3 text-xs font-semibold hover:bg-surface">Cancel</button>
          {linkErr ? <p role="alert" className="w-full text-xs text-danger">{linkErr}</p> : null}
        </form>
      ) : null}
      {uploadErr ? <p role="alert" className="border-t border-line bg-red-50 px-3 py-1.5 text-xs text-danger">{uploadErr}</p> : null}
    </div>
  );
}

/** Rich-text editor for email HTML (TipTap). Output is re-sanitised on the server on every save; this just authors it. */
export function RichEditor({
  value, onChange, variables = [], editable = true, label, placeholder = "Write your message…",
}: {
  value: string;
  onChange: (html: string) => void;
  variables?: EditorVariable[];
  editable?: boolean;
  label: string;
  placeholder?: string;
}) {
  const id = useId();
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    content: value,
    extensions: [
      // StarterKit v3 bundles Link and Underline.
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        code: false, codeBlock: false,
        link: { openOnClick: false, autolink: false, HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" }, isAllowedUri: (url) => isSafeLink(url) },
      }),
      TextStyle, Color,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder }),
    ],
    editorProps: { attributes: { id, role: "textbox", "aria-multiline": "true", "aria-label": label } },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });
  if (!editor) return <div className="h-64 animate-pulse rounded-lg border border-line bg-canvas" aria-busy="true" aria-label={`${label} loading`} />;
  return (
    <div className="tpl-editor overflow-hidden rounded-lg border border-line bg-surface">
      <style>{EDITOR_CSS}</style>
      {editable ? <Toolbar editor={editor} variables={variables} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
}
