"use client";
import { useState } from "react";

const LABELS = ["Poor", "Fair", "Good", "Very good", "Excellent"];

/** Accessible star picker: a native radio group (arrow keys, form value, screen-reader labels). */
export function StarInput({ name = "rating", defaultValue = 0, error }: { name?: string; defaultValue?: number; error?: string }) {
  const [value, setValue] = useState(defaultValue);
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <fieldset aria-describedby={error ? `${name}-err` : undefined}>
      <legend className="mb-1 text-sm font-medium text-ink">Your rating</legend>
      <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label
            key={n}
            onMouseEnter={() => setHover(n)}
            className="cursor-pointer rounded p-1 text-3xl leading-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600"
          >
            <input type="radio" name={name} value={n} checked={value === n} onChange={() => setValue(n)} required className="sr-only" aria-label={`${n} star${n === 1 ? "" : "s"}, ${LABELS[n - 1]}`} />
            <span aria-hidden className={n <= shown ? "text-accent-600" : "text-line"}>★</span>
          </label>
        ))}
        <span aria-hidden className="ml-2 text-sm text-muted">{shown ? LABELS[shown - 1] : "Tap a star"}</span>
      </div>
      {error ? <p id={`${name}-err`} className="mt-1 text-xs text-danger">{error}</p> : null}
    </fieldset>
  );
}
