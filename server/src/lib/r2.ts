import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import path from 'path';
import type { Readable } from 'stream';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME ?? 'tournament-predictor-assets';

/** Folders the image proxy will serve. Keep in sync with VALID_FOLDERS in routes/images.ts. */
export type R2Folder =
  | 'users'
  | 'tournaments'
  | 'teams'
  | 'competitions'
  | 'live-teams'
  | 'live-players';

/** Whether R2 credentials are configured at all. Lets callers skip optional uploads. */
export function isR2Configured(): boolean {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

/**
 * Upload raw bytes and return the proxy URL they will be served from.
 *
 * Separate from uploadToR2 because not everything we store arrives as a multipart
 * upload — team crests are fetched from the data provider and mirrored server-side.
 */
export async function uploadBufferToR2(
  buffer: Buffer,
  opts: { folder: R2Folder; contentType: string; extension: string }
): Promise<string> {
  const ext = opts.extension.startsWith('.') ? opts.extension : `.${opts.extension}`;
  const key = `${opts.folder}/${randomUUID()}${ext.toLowerCase()}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: opts.contentType,
    })
  );

  // Return a proxy URL so images are served through the app server,
  // avoiding direct browser requests to Cloudflare (which corporate firewalls block).
  return `/api/images/${key}`;
}

export async function uploadToR2(
  file: Express.Multer.File,
  folder: R2Folder
): Promise<string> {
  return uploadBufferToR2(file.buffer, {
    folder,
    contentType: file.mimetype,
    extension: path.extname(file.originalname).toLowerCase() || '.jpg',
  });
}

export async function getFromR2(key: string): Promise<{ body: Readable; contentType: string }> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!response.Body) throw new Error('Empty R2 response body');
  return {
    body: response.Body as unknown as Readable,
    contentType: response.ContentType ?? 'application/octet-stream',
  };
}
