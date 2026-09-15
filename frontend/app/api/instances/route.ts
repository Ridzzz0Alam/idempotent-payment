import type { InstanceHealth } from "@/lib/types";

export const dynamic = "force-dynamic";

const INSTANCES = [
  { name: "api-1", url: process.env.API_1_URL ?? "http://localhost:8081" },
  { name: "api-2", url: process.env.API_2_URL ?? "http://localhost:8082" },
];

export async function GET() {
  const results: InstanceHealth[] = await Promise.all(
    INSTANCES.map(async ({ name, url }) => {
      try {
        // Short timeout: a stopped container should read as down within the
        // poll interval, not hang the strip for thirty seconds.
        const res = await fetch(`${url}/healthz`, {
          cache: "no-store",
          signal: AbortSignal.timeout(1200),
        });
        return { name, url, up: res.ok };
      } catch {
        return { name, url, up: false };
      }
    }),
  );

  return Response.json(results, { headers: { "Cache-Control": "no-store" } });
}
