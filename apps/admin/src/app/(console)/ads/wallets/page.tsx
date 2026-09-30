import { PageHeader, Alert } from "@cnote/ui";
import { requireStaff } from "@/lib/auth";
import { AdsNav } from "../ads-nav";
import { CreditWalletForm } from "../forms";

export const metadata = { title: "Ad wallets" };

export default async function WalletsPage() {
  await requireStaff("/ads/wallets", "billing.adjust");
  return (
    <>
      <PageHeader title="Ad wallets" description="Pilot top-up: after a bank transfer, finance credits the seller's ad wallet here and issues the GST invoice from the accounting system." />
      <AdsNav active="/ads/wallets" />
      <Alert tone="info">Credit the ex-GST amount. The entry is append-only and audited; repeating the same bank reference never credits twice. Online top-up with automatic GST invoices arrives with payment collection.</Alert>
      <CreditWalletForm />
    </>
  );
}
