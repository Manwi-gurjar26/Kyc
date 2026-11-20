/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * The workspace packages ship TypeScript source rather than a build, so Next
   * has to compile them itself.
   */
  transpilePackages: ["@kilowattx/validation"],
  /**
   * And they import each other NodeNext-style, as `./aadhaar.js` naming a file
   * that is `aadhaar.ts` on disk. tsc and Node understand that; webpack does
   * not until told the `.js` may be a `.ts`. Without this, the first page to
   * import the package fails to build with "Can't resolve './aadhaar.js'".
   */
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  experimental: {
    /** Server Actions run on this origin only. */
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
};

export default nextConfig;
