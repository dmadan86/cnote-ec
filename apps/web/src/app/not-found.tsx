import Link from "next/link";
import { buttonClasses, Container } from "@cnote/ui";

export default function NotFound() {
  return (
    <Container className="py-20 text-center">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-ink">We could not find that page</h1>
      <p className="mx-auto mt-3 max-w-md text-muted">The link may be old or the product may no longer be listed.</p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/" className={buttonClasses("primary", "lg")}>
          Go to home
        </Link>
        <Link href="/search" className={buttonClasses("outline", "lg")}>
          Search products
        </Link>
      </div>
    </Container>
  );
}
