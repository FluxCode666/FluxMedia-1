/** Storage assets are served by the Go gateway, including ownership checks,
 * runtime buckets, S3/MinIO reads and width based WebP thumbnails. */
import { proxyExternalApi } from "@/features/external-api/go-proxy";

export const GET = proxyExternalApi;
export const PUT = proxyExternalApi;
export const DELETE = proxyExternalApi;
