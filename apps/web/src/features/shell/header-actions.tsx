"use client";
import { ClipboardList, FileText, Heart, Scale, User } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { buttonClasses } from "@cnote/ui";
import { useUserState } from "@/features/user-state/store";
import { AccountMenu } from "./account-menu";
import { PincodePicker } from "./pincode-picker";

const noopSubscribe = () => () => undefined;

const linkCls =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

function CountBadge({ n }: { n: number }) {
  return n > 0 ? (
    <span className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-bold text-white">
      {n}
      <span className="sr-only"> items</span>
    </span>
  ) : null;
}

/**
 * The per-user part of the (otherwise static) site header. The server-rendered HTML is the signed-out view
 * (sign in / join links crawlers should see); once /api/me answers, signed-in users get Saved, the account menu
 * and live counts. While the answer is in flight the account cluster is visually hidden to avoid a sign-in flash.
 */
export function HeaderActions() {
  const u = useUserState();
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const settling = hydrated && (u.status === "idle" || u.status === "loading");

  return (
    <>
      <div className="hidden lg:block">
        <PincodePicker />
      </div>
      <Link href="/rfq/new" className={`${linkCls} hidden lg:inline-flex`}>
        <FileText className="size-4" aria-hidden /> Request Quote
      </Link>
      <Link href="/buyer/enquiries" className={`${linkCls} hidden lg:inline-flex`}>
        <ClipboardList className="size-4" aria-hidden /> Orders
      </Link>
      {u.signedIn ? (
        <Link href="/wishlist" className={`${linkCls} hidden lg:inline-flex`}>
          <Heart className="size-4" aria-hidden /> Saved
          <CountBadge n={u.savedCount} />
        </Link>
      ) : null}
      <Link href="/compare" className={`${linkCls} hidden lg:inline-flex`}>
        <Scale className="size-4" aria-hidden /> Compare
        <CountBadge n={u.compareIds.length} />
      </Link>
      <div className={settling ? "hidden invisible lg:flex lg:items-center lg:gap-2" : "hidden lg:flex lg:items-center lg:gap-2"} aria-busy={settling || undefined}>
        {u.signedIn ? (
          <AccountMenu name={u.name} email={u.email} isSeller={u.isSeller} />
        ) : (
          <>
            <Link href="/signin" className={linkCls}>
              <User className="size-4" aria-hidden /> Sign in
            </Link>
            <Link href="/signup" className={buttonClasses("primary", "md")}>
              Join for Free
            </Link>
          </>
        )}
      </div>
    </>
  );
}
