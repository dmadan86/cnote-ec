"use client";
import Link from "next/link";
import { useEffect } from "react";
import { Alert, Button, buttonClasses, Container } from "@cnote/ui";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Container className="py-16">
      <div className="mx-auto max-w-lg text-center">
        <h1 className="text-2xl font-bold text-ink">Something went wrong</h1>
        <Alert tone="danger" className="mt-4 text-left">
          We could not load this page. Please try again. If it keeps happening, come back in a few minutes.
        </Alert>
        <div className="mt-6 flex justify-center gap-3">
          <Button size="lg" onClick={reset}>
            Try again
          </Button>
          <Link href="/" className={buttonClasses("outline", "lg")}>
            Go to home
          </Link>
        </div>
      </div>
    </Container>
  );
}
