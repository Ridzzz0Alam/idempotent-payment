import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The payments API is never called from the browser. All fan-out happens in the
  // route handler so the browser's six-connections-per-host limit cannot
  // silently throttle the burst and make a broken backend look correct.
  env: {
    IDEM_API_URL: process.env.IDEM_API_URL ?? "http://localhost:8080",
    API_1_URL: process.env.API_1_URL ?? "http://localhost:8081",
    API_2_URL: process.env.API_2_URL ?? "http://localhost:8082",
  },
};

export default nextConfig;
