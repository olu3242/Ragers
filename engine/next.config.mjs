/**
 * The engine core is authored as dependency-free TypeScript with explicit `.ts`
 * import specifiers, so Node can run it directly with type stripping and the
 * test suite needs no build step. Webpack resolves those exact paths as-is;
 * `extensionAlias` keeps that working for any `.js` specifier that appears.
 */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
