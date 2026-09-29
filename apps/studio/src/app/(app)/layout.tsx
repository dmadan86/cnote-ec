import { Alert, buttonClasses, Container } from "@cnote/ui";
import { StudioShell } from "@/features/studio/shell";
import { requireSellerSession } from "@/lib/auth";
import { SELLER_APP_URL } from "@/lib/env";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSellerSession("/");
  const biz = session.business;
  if (!biz || !biz.isSeller) {
    return (
      <StudioShell name={session.email ?? ""}>
        <Container className="max-w-xl py-16">
          <Alert tone="info">Storefront Studio is for seller accounts. Set up your seller profile first, then come back here.</Alert>
          <a href={`${SELLER_APP_URL}/onboarding`} className={buttonClasses("primary", "md", "mt-4")}>Set up your seller account</a>
        </Container>
      </StudioShell>
    );
  }
  return <StudioShell name={biz.name}>{children}</StudioShell>;
}
