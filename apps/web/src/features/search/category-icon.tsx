import {
  Armchair, Building2, CookingPot, Factory, Flame, Gift, HardHat, Headphones, HeartPulse, LayoutGrid, Package, PencilRuler, Pill, Shirt, Wheat,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  package: Package, shirt: Shirt, "pencil-ruler": PencilRuler, "cooking-pot": CookingPot, headphones: Headphones, gift: Gift,
  armchair: Armchair, "heart-pulse": HeartPulse, factory: Factory, wheat: Wheat, "building-2": Building2, "hard-hat": HardHat,
  pill: Pill, flame: Flame,
};

/** Maps a category's lucide icon name (kebab-case) to a component; unknown names get a generic tile. */
export function CategoryIcon({ name, className }: { name: string | null; className?: string }) {
  const Icon = (name && ICONS[name]) || LayoutGrid;
  return <Icon className={className} aria-hidden />;
}
