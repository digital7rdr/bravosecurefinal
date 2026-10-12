import {S3Client, PutObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {publicSigner} from './public-signer';

/**
 * 2026-10-12 — presigned media URLs must name the host phones can reach. The
 * server's own client talks to MinIO as http://minio:9000; the URLs handed to
 * phones must say https://media.bravosecure.cloud.
 */
const cfg = (vals: Record<string, string>) => ({get: (k: string) => vals[k]}) as never;
const BASE = {'media.region': 'us-east-1', 'media.accessKeyId': 'k', 'media.secretAccessKey': 's'};
const internal = new S3Client({region: 'us-east-1', endpoint: 'http://minio:9000', forcePathStyle: true, credentials: {accessKeyId: 'k', secretAccessKey: 's'}});

describe('publicSigner', () => {
  it('signs upload and download URLs for the public media host', async () => {
    const signer = publicSigner(cfg({...BASE, 'media.publicEndpoint': 'https://media.bravosecure.cloud'}), internal);
    const put = new URL(await getSignedUrl(signer, new PutObjectCommand({Bucket: 'bravo-messenger-media', Key: 'att/x', ContentLength: 5, ContentType: 'application/octet-stream'}), {expiresIn: 300}));
    const get = new URL(await getSignedUrl(signer, new GetObjectCommand({Bucket: 'bravo-messenger-media', Key: 'att/x'}), {expiresIn: 300}));
    for (const u of [put, get]) {
      expect(u.origin).toBe('https://media.bravosecure.cloud');
      expect(u.pathname).toBe('/bravo-messenger-media/att/x');
      expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('without a public endpoint it is the internal client (R2 / AWS unchanged)', async () => {
    expect(publicSigner(cfg(BASE), internal)).toBe(internal);
    const url = new URL(await getSignedUrl(internal, new GetObjectCommand({Bucket: 'b', Key: 'k'}), {expiresIn: 60}));
    expect(url.host).toBe('minio:9000');   // the bug this fixes, when the env is missing
  });
});
