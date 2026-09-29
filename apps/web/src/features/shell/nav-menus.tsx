import Link from "next/link";
import { Badge } from "@cnote/ui";
import { Popover } from "./popover";
import { NAV } from "./site";

/** Desktop navigation dropdowns (server-rendered panels inside a small client popover). */
export function NavMenus() {
  return (
    <nav aria-label="Primary" className="hidden items-center gap-0.5 lg:flex">
      {NAV.map((g) => (
        <Popover key={g.label} label={g.label} panelClassName="w-72">
          <ul>
            {g.items.map((it) => (
              <li key={it.href}>
                <Link href={it.href} className="flex flex-col gap-0.5 rounded-lg px-3 py-2.5 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    {it.label}
                    {it.soon ? <Badge tone="brand">Coming soon</Badge> : null}
                  </span>
                  {it.description ? <span className="text-xs text-muted">{it.description}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Popover>
      ))}
    </nav>
  );
}
