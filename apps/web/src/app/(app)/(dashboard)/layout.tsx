import { SectionStrip } from "@/features/rail/buyer-rail";

/**
 * Signed-in dashboard chrome (account, buyer, conversations, wishlist, rfq). The site rail itself comes from the shared
 * SiteFrame in the parent layout; this group only adds the section strip that replaces the dashboard rail below lg.
 */
export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SectionStrip />
      {children}
    </>
  );
}
