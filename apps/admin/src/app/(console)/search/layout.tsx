import { PageHeader } from "@cnote/ui";
import { SearchTabs } from "@/features/search/tabs";
import { requireStaff } from "@/lib/auth";

export default async function SearchLayout({ children }: { children: React.ReactNode }) {
  await requireStaff("/search/synonyms", "search.read");
  return (
    <>
      <PageHeader title="Search tuning" description="Vernacular synonym dictionary and relevance judgements for buyer search (ADR-004, ADR-009). Ranking is never influenced by plan or ad spend." />
      <SearchTabs />
      {children}
    </>
  );
}
