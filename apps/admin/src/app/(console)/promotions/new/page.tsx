import { PageHeader } from "@cnote/ui";
import { PromotionEditor } from "@/features/promotions/editor";
import { requireStaff } from "@/lib/auth";

export const metadata = { title: "New promotion" };
const istInput = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16);

export default async function NewPromotionPage() {
  await requireStaff("/promotions/new", "promotions.manage");
  const now = new Date();
  return (
    <>
      <PageHeader title="New promotion" description="Write the words and pick the image; the layout is fixed. English is required and is the fallback for every language." />
      <PromotionEditor value={{ kind: "hero_banner", template: "hero_split", internalName: "", surfaces: ["home_hero"], priority: 0, startsAt: istInput(now), endsAt: istInput(new Date(now.getTime() + 14 * 86_400_000)), segment: "all", states: "", languages: [], items: "", contents: {} }} />
    </>
  );
}
