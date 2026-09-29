import type { ApiPrincipal } from "@cnote/developer";

export type AppEnv = { Variables: { principal: ApiPrincipal; requestId: string } };
