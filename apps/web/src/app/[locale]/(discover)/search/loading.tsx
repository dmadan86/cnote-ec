import { Container, Grid, ProductCardSkeleton, Skeleton } from "@cnote/ui";

export default function Loading() {
  return (
    <Container className="py-6 lg:py-8" aria-busy>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="mt-4 h-11 w-full" />
      <Grid className="mt-8">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i}>
            <ProductCardSkeleton />
          </li>
        ))}
      </Grid>
    </Container>
  );
}
