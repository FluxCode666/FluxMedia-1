import { proxyExternalApi } from "@/features/external-api/go-proxy";

export async function POST(request: Request) { return proxyExternalApi(request); }
