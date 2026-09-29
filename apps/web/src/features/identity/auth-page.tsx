import { isGoogleConfigured } from "@cnote/identity";
import type { ReactNode } from "react";

export const googleEnabled = () => isGoogleConfigured();

export const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
    </div>
  );
}
