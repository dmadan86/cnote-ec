import { hasPrivilege } from "@cnote/admin";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";

export default async function StorefrontsIndex() {
  const { staff } = await requireStaff("/storefronts");
  redirect(hasPrivilege(staff, "storefronts.review") ? "/storefronts/review" : "/storefronts/templates");
}
