import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Lets `next dev` accept requests on both localhost and 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
