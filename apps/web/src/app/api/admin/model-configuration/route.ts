import { proxyExternalApi } from "@/features/external-api/go-proxy";

export async function GET(request: Request) { return proxyExternalApi(request); }
export async function POST(request: Request) { return proxyExternalApi(request); }
export async function DELETE(request: Request) { return proxyExternalApi(request); }
