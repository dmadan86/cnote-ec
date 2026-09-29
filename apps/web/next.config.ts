import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@cnote/ui", "@cnote/core", "@cnote/ai", "@cnote/identity", "@cnote/catalogue", "@cnote/billing", "@cnote/enquiry", "@cnote/search"],
  serverExternalPackages: ["@cnote/db", "@prisma/client", "@prisma/adapter-pg", "pg", "ioredis"],
};

export default nextConfig;
