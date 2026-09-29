import { LogOut, Store, User } from "lucide-react";
import Link from "next/link";
import { Avatar } from "@cnote/ui";
import { signOutAction } from "@cnote/next-kit";
import { Popover } from "./popover";
import { SELLER_APP_URL } from "./site";

export function AccountMenu({ name, email, isSeller }: { name: string | null; email: string | null; isSeller: boolean }) {
  const display = name ?? email ?? "Account";
  return (
    <Popover
      align="right"
      panelClassName="w-64"
      ariaLabel="Account menu"
      label={
        <span className="flex items-center gap-2">
          <Avatar name={display} size="sm" />
          <span className="hidden max-w-28 truncate xl:inline">{display}</span>
        </span>
      }
    >
      <div className="border-b border-line px-3 py-2">
        <p className="truncate text-sm font-semibold text-ink">{display}</p>
        {email && name ? <p className="truncate text-xs text-muted">{email}</p> : null}
      </div>
      <ul className="py-1 text-sm">
        <li>
          <Link href="/buyer/enquiries" className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-brand-50">
            <User className="size-4" aria-hidden /> My enquiries
          </Link>
        </li>
        {isSeller ? (
          <li>
            <a href={SELLER_APP_URL} className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-brand-50">
              <Store className="size-4" aria-hidden /> Seller dashboard
            </a>
          </li>
        ) : null}
        <li>
          <form action={signOutAction}>
            <button type="submit" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-brand-50">
              <LogOut className="size-4" aria-hidden /> Sign out
            </button>
          </form>
        </li>
      </ul>
    </Popover>
  );
}
