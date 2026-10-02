"use client";
// Follow button for the static supplier profile and seller card. The surrounding HTML is static; whether the visitor is signed in
// comes from the shared per-user store and whether they follow this supplier from GET /api/follow/<id> (private, no-store).
// Guests are sent to sign in on click. No browser storage is used (nothing to register in the consent registry).
import { buttonClasses, cn } from "@cnote/ui";
import { UserCheck, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ensureFresh, useUserState } from "@/features/user-state/store";
import { toggleFollowAction } from "./actions";

export function FollowIsland({ businessId, name, className, size = "md" }: { businessId: string; name: string; className?: string; size?: "md" | "lg" }) {
  const t = useTranslations("retention");
  const u = useUserState();
  const router = useRouter();
  // state is kept with the supplier it belongs to, and only used while signed in (no setState in the effect body)
  const [answer, setAnswer] = useState<{ businessId: string; following: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    if (u.status !== "ready" || !u.signedIn) return;
    const ctl = new AbortController();
    fetch(`/api/follow/${businessId}`, { signal: ctl.signal, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<{ following: boolean }>) : null))
      .then((d) => d && setAnswer({ businessId, following: d.following }))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [businessId, u.status, u.signedIn]);

  const following = u.signedIn && answer?.businessId === businessId ? answer.following : false;

  function click() {
    if (!u.signedIn) {
      const next = `${window.location.pathname}${window.location.search}`;
      router.push(`/signin?next=${encodeURIComponent(next)}`);
      return;
    }
    const before = following;
    setAnswer({ businessId, following: !before });
    setMessage("");
    start(async () => {
      try {
        await ensureFresh();
        const r = await toggleFollowAction(businessId);
        if (r.ok) {
          setAnswer({ businessId, following: r.following });
          setMessage(t(r.following ? "follow.nowFollowing" : "follow.unfollowed", { name }));
        } else {
          setAnswer({ businessId, following: before });
          setMessage(r.error);
        }
      } catch {
        setAnswer({ businessId, following: before });
        setMessage(t("follow.error"));
      }
    });
  }

  const Icon = following ? UserCheck : UserPlus;
  return (
    <>
      <button
        type="button"
        aria-pressed={following}
        aria-busy={pending}
        aria-label={following ? t("follow.followingLabel", { name }) : u.signedIn || u.status !== "ready" ? t("follow.followLabel", { name }) : t("follow.signInLabel", { name })}
        title={t("follow.hint")}
        onClick={click}
        className={cn(buttonClasses(following ? "outline-brand" : "outline", size, "min-h-11"), className)}
        data-testid="follow-button"
      >
        <Icon className="size-4" aria-hidden /> {following ? t("follow.following") : t("follow.follow")}
      </button>
      <span role="status" aria-live="polite" className="sr-only">{message}</span>
    </>
  );
}
