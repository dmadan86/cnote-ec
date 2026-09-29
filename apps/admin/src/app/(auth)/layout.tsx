import { Activity } from "lucide-react";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-brand-900 p-4">
      <div className="flex items-center gap-2 text-white">
        <Activity className="size-6 text-accent-500" aria-hidden />
        <span className="text-xl font-bold">Back office</span>
        <span className="rounded bg-accent-500 px-1.5 py-0.5 text-[10px] font-extrabold tracking-widest">ADMIN</span>
      </div>
      <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-lg">{children}</div>
      <p className="text-xs text-brand-200">Authorised staff only. Activity is logged.</p>
    </div>
  );
}
