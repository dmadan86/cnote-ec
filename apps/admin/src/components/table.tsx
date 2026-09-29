import { cn } from "@cnote/ui";
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...rest} />
    </div>
  );
}
export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("whitespace-nowrap border-b border-line bg-canvas px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted", className)} {...rest} />;
}
export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-b border-line px-3 py-2 align-top last:border-b-0", className)} {...rest} />;
}
export function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-canvas px-1 py-0.5 font-mono text-xs">{children}</code>;
}
