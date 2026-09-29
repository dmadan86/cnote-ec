import { cloneElement, isValidElement, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../cn";

const control =
  "w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted " +
  "focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-canvas aria-invalid:border-danger";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-10", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-24 py-2", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "h-10", className)} {...rest} />;
}

export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-ink", className)} {...rest} />;
}

/**
 * Label + control + hint/error, stacked. The single child control is wired for assistive tech (WCAG 1.3.1 / 3.3.1):
 * `aria-describedby` points at the hint or error and `aria-invalid` is set while there is an error. The error is
 * announced when it appears (role="alert"). Pass an element with `id={htmlFor}`; other children are left untouched.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const noteId = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;
  const control =
    noteId && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          "aria-describedby": [(children.props as Record<string, unknown>)["aria-describedby"], noteId].filter(Boolean).join(" "),
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {control}
      {error ? (
        <p id={noteId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={noteId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
