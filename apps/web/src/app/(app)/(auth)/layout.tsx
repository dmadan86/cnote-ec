export default function AuthLayout({ children }: LayoutProps<"/">) {
  return <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">{children}</div>;
}
