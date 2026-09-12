import { headers } from "next/headers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

async function proxySession(): Promise<Response> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const response = await fetch(`${base}/api/session/current`, {
    headers: cookie ? { cookie } : undefined,
    cache: "no-store",
  });
  const responseHeaders = new Headers({
    "content-type": response.headers.get("content-type") || "application/json",
    "cache-control": "private, no-store, no-cache, max-age=0, must-revalidate",
    vary: "Cookie",
  });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    responseHeaders.append("set-cookie", value);
  }
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: responseHeaders,
  });
}

export async function GET() { return proxySession(); }
export async function POST() { return proxySession(); }
