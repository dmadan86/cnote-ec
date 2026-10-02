// DRAFT FOR COUNSEL REVIEW: the copy of this page (messages/*.legal.json, namespace legal.refund) is a working draft.
import { LegalDoc, legalMetadata } from "@/features/legal/legal-doc";

export const generateMetadata = (props: { params: Promise<{ locale: string }> }) => legalMetadata(props.params, "/refund-policy", "refund");
export const revalidate = 3600;

export default function Page(props: { params: Promise<{ locale: string }> }) {
  return <LegalDoc params={props.params} ns="refund" version="refund" />;
}
