/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * The workspace packages ship TypeScript source rather than a build, so Next
   * has to compile them itself.
   */
  transpilePackages: ["@kilowattx/validation"],
  experimental: {
    /** Server Actions run on this origin only. */
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
};

export default nextConfig;
