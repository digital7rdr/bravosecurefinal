import {S3Client} from '@aws-sdk/client-s3';
import type {ConfigService} from '@nestjs/config';

/**
 * 2026-10-12 — the S3 client used ONLY to presign the URLs handed to phones
 * (media attachments, voice notes, the Vault).
 *
 * Presigning is offline (no network call), but the URL's host is the client's
 * endpoint. With MEDIA_S3_ENDPOINT=http://minio:9000 — the internal docker
 * name, right for the server's own calls — every upload / download URL named
 * minio:9000, which no phone can reach, so nothing was ever uploaded.
 * MEDIA_S3_PUBLIC_ENDPOINT (https://media.bravosecure.cloud: Caddy → MinIO
 * with the Host header kept, MINIO_SERVER_URL set to the same) is the host
 * those URLs must name. Unset → the internal client (R2 / AWS, where the one
 * endpoint is already public).
 */
export function publicSigner(config: ConfigService, internal: S3Client): S3Client {
  const pub = (config.get<string>('media.publicEndpoint') ?? '').trim();
  if (!pub) return internal;
  return new S3Client({
    region: config.get<string>('media.region') ?? 'auto',
    endpoint: pub,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.get<string>('media.accessKeyId') ?? '',
      secretAccessKey: config.get<string>('media.secretAccessKey') ?? '',
    },
  });
}
