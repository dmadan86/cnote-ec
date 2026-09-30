"use client";
import { Bell, Bot, ClipboardList, LogOut, Store, User } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@cnote/ui";
import { LocaleLink as Link } from "@/i18n/link";
import { Popover } from "./popover";
import { SELLER_APP_URL } from "./site";

const A2A_ON = ["1", "true", "yes"].includes((process.env.NEXT_PUBLIC_A2A_ENABLED ?? "").toLowerCase());

export function AccountMenu({ name, email, isSeller }: { name: string | null; email: string | null; isSeller: boolean }) {
  const t = useTranslations("shell");
  const display = name ?? email ?? t("account");
  return (
    <Popover
      align="right"
      panelClassName="w-64"
      ariaLabel={t("accountMenuFor", { name: display })}
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
          <Link href="/buyer/enquiries" className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
            <User className="size-4" aria-hidden /> {t("myEnquiries")}
          </Link>
        </li>
        <li>
          <Link href="/buyer/orders" className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
            <ClipboardList className="size-4" aria-hidden /> {t("myOrders")}
          </Link>
        </li>
        {A2A_ON ? (
          <li>
            <Link href="/buyer/agents" className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
              <Bot className="size-4" aria-hidden /> {t("myAgents")}
            </Link>
          </li>
        ) : null}
        <li>
          <Link href="/account/notifications" className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
            <Bell className="size-4" aria-hidden /> {t("notifications")}
          </Link>
        </li>
        {isSeller ? (
          <li>
            <a href={SELLER_APP_URL} className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
              <Store className="size-4" aria-hidden /> {t("sellerDashboard")}
            </a>
          </li>
        ) : null}
        <li>
          <form method="post" action="/api/auth/signout">
            <button type="submit" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
              <LogOut className="size-4" aria-hidden /> {t("signOut")}
            </button>
          </form>
        </li>
      </ul>
    </Popover>
  );
}
