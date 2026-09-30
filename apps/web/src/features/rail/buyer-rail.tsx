"use client";
import { LogIn, PanelLeftClose, PanelLeftOpen, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@cnote/ui";
import { LocaleLink } from "@/i18n/link";
import { useUserState } from "@/features/user-state/store";
import { RAIL_GROUPS, PROFILE_HREF, SIGN_IN_HREF, activeHref, isUnder, railGroups, type RailItem } from "./items";
import { applyRailState, parseRailState, railFromCookieString, type RailState } from "./state";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
const HEADER_H = "var(--site-header-h, 6.5rem)";

const noopSubscribe = () => () => undefined;
const readRail = (): RailState => parseRailState(document.documentElement.dataset.rail);
/** The live state is the <html data-rail> attribute; observe it so every toggle (and the pre-paint script) is reflected. */
const subscribeRail = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-rail"] });
  return () => mo.disconnect();
};

/**
 * Site-wide rail (64px icons, 240px labelled). Desktop only (lg+); below that the header menu (and, on dashboard pages,
 * SectionStrip) navigate. The open/closed state is CSS: `rail-expanded:` variants match `html[data-rail=expanded]`, which
 * RAIL_SCRIPT sets before first paint from the cookie, so the server HTML is always the collapsed markup (no hydration
 * mismatch, no request-reading). Collapsed: each link keeps its accessible name as visually hidden text, and a supplementary
 * tooltip shows on hover and keyboard focus (hoverable, persistent until pointer/focus leaves, Escape dismisses: WCAG 1.4.13).
 * Signed-in items are added after /api/me reports a session (until then the items are hidden, like the header's account cluster).
 */
export function SiteRail() {
  const t = useTranslations("rail");
  const pathname = usePathname();
  const active = activeHref(pathname);
  const u = useUserState();
  const state = useSyncExternalStore(subscribeRail, readRail, () => "collapsed" as RailState);
  const expanded = state === "expanded";
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const settling = hydrated && (u.status === "idle" || u.status === "loading");
  const groups = railGroups(u.signedIn);
  const [dismissed, setDismissed] = useState<string[]>([]);

  // If the pre-paint script did not run (blocked, no-JS-then-JS), fall back to the cookie once mounted.
  useEffect(() => {
    if (!document.documentElement.dataset.rail) document.documentElement.dataset.rail = railFromCookieString(document.cookie);
  }, []);

  const toggle = () => applyRailState(expanded ? "collapsed" : "expanded");

  const tip = (id: string, children: ReactNode) => (
    <span
      aria-hidden
      className={cn(
        "fixed left-16 z-50 hidden h-10 items-center pl-2 group-hover/tip:flex group-focus-within/tip:flex rail-expanded:hidden!",
        dismissed.includes(id) && "hidden!",
      )}
    >
      <span className="whitespace-nowrap rounded-md bg-ink px-2.5 py-1.5 text-xs font-medium text-white shadow-lg">{children}</span>
    </span>
  );

  const itemCls = (isActive: boolean) =>
    cn(
      "relative flex h-10 w-10 items-center justify-center rounded-lg text-sm transition-colors rail-expanded:w-full rail-expanded:justify-start rail-expanded:gap-3 rail-expanded:px-3",
      isActive ? "bg-brand-50 font-semibold text-brand-700" : "text-muted hover:bg-canvas hover:text-ink",
      FOCUS,
    );
  const labelCls = "sr-only rail-expanded:not-sr-only rail-expanded:truncate";
  const listCls = "flex flex-col items-center gap-1 rail-expanded:items-stretch";

  // Escape must dismiss a tooltip opened by hover too (focus may be elsewhere), so listen on the document while one is up.
  const [open, setOpen] = useState<string[]>([]); // "hover:<id>" / "focus:<id>" entries
  useEffect(() => {
    if (!open.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(open.map((k) => k.split(":")[1]!));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const enter = (key: string) => setOpen((o) => (o.includes(key) ? o : [...o, key]));
  const leave = (kind: "hover" | "focus", id: string) => {
    const next = open.filter((k) => k !== `${kind}:${id}`);
    setOpen(next);
    // Re-arm the tooltip once neither pointer nor focus is on the item any more.
    if (!next.some((k) => k.endsWith(`:${id}`))) setDismissed((d) => d.filter((x) => x !== id));
  };
  const wrapProps = (id: string) => ({
    onMouseEnter: () => enter(`hover:${id}`),
    onFocus: () => enter(`focus:${id}`),
    onMouseLeave: () => leave("hover", id),
    onBlur: () => leave("focus", id),
  });

  const renderItem = (it: RailItem) => {
    const isActive = active === it.href;
    const Icon = it.icon;
    const label = t(it.label);
    const inner = (
      <>
        {isActive && <span aria-hidden className="absolute -left-1.5 top-2 bottom-2 w-[3px] rounded-full bg-brand-600" />}
        <Icon className="size-5 shrink-0" aria-hidden />
        <span className={labelCls}>{label}</span>
      </>
    );
    return (
      <li key={it.href} className="group/tip relative" {...wrapProps(it.href)}>
        {tip(it.href, label)}
        {it.download ? (
          <a href={it.href} download className={itemCls(false)}>{inner}</a>
        ) : (
          <LocaleLink href={it.href} aria-current={isActive ? "page" : undefined} className={itemCls(isActive)}>{inner}</LocaleLink>
        )}
      </li>
    );
  };

  const divider = <div aria-hidden className="mx-auto my-2 h-px w-6 bg-line rail-expanded:mx-1 rail-expanded:w-auto" />;

  const bottomHref = u.signedIn ? PROFILE_HREF : SIGN_IN_HREF;
  const bottomLabel = u.signedIn ? t("account") : t("signIn");
  const bottomActive = !u.signedIn && isUnder(pathname, SIGN_IN_HREF);

  return (
    <aside
      id="buyer-rail"
      className="hidden w-16 shrink-0 border-r border-line bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none lg:block rail-expanded:w-60"
    >
      <div className="sticky flex flex-col px-3 py-3" style={{ top: HEADER_H, height: `calc(100dvh - ${HEADER_H})` }}>
        <nav aria-label={t("siteNavLabel")} aria-busy={settling || undefined} className="flex min-h-0 flex-1 flex-col">
          <div className={cn("-mx-3 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 [scrollbar-width:thin]", settling && "invisible")}>
            {groups.map((group, i) => (
              <div key={i} className="shrink-0">
                {i > 0 && divider}
                <ul className={listCls}>{group.map(renderItem)}</ul>
              </div>
            ))}
          </div>
          <div className="shrink-0 pt-2">
            {divider}
            <ul className={listCls}>
              <li className="group/tip relative" {...wrapProps("account")}>
                {tip("account", bottomLabel)}
                <LocaleLink href={bottomHref} aria-current={bottomActive ? "page" : undefined} className={itemCls(bottomActive)}>
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                    {u.signedIn ? <UserRound className="size-4" aria-hidden /> : <LogIn className="size-4" aria-hidden />}
                  </span>
                  <span className={labelCls}>{bottomLabel}</span>
                </LocaleLink>
              </li>
            </ul>
          </div>
        </nav>
        <div className="group/tip relative mt-1 flex shrink-0 justify-center rail-expanded:block" {...wrapProps("toggle")}>
          {tip("toggle", t("expand"))}
          <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls="buyer-rail" className={itemCls(false)}>
            <PanelLeftOpen className="size-5 shrink-0 rail-expanded:hidden" aria-hidden />
            <PanelLeftClose className="hidden size-5 shrink-0 rail-expanded:block" aria-hidden />
            <span className="sr-only rail-expanded:hidden">{t("expand")}</span>
            <span className="hidden rail-expanded:inline rail-expanded:truncate">{t("collapse")}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Below lg: the same sections as a horizontally scrollable strip of icon + label links (44px targets). */
export function SectionStrip() {
  const t = useTranslations("rail");
  const pathname = usePathname();
  const active = activeHref(pathname);
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [active]);
  return (
    <nav aria-label={t("stripLabel")} className="border-b border-line bg-surface lg:hidden">
      <ul className="flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:thin]">
        {RAIL_GROUPS.flat().map((it) => {
          const isActive = active === it.href;
          const Icon = it.icon;
          const cls = cn(
            "flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm",
            isActive ? "bg-brand-50 font-semibold text-brand-700 shadow-[inset_0_-3px_0_0_var(--color-brand-600)]" : "text-muted hover:bg-canvas hover:text-ink",
            FOCUS,
          );
          const inner = (<><Icon className="size-5 shrink-0" aria-hidden />{t(it.label)}</>);
          return (
            <li key={it.href} className="shrink-0">
              {it.download ? (
                <a href={it.href} download className={cls}>{inner}</a>
              ) : (
                <LocaleLink ref={isActive ? ref : undefined} href={it.href} aria-current={isActive ? "page" : undefined} className={cls}>{inner}</LocaleLink>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
