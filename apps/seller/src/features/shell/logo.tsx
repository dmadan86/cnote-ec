import Link from "next/link";
import { Store } from "lucide-react";
import { BRAND } from "@/lib/brand";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
      <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
        <Store className="size-4" aria-hidden />
      </span>
      <span className="text-lg font-extrabold tracking-tight text-ink">
        {BRAND} <span className="font-semibold text-brand-600">Seller</span>
      </span>
    </Link>
  );
}
