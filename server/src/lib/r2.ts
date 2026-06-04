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

export async function uploadToR2(
  file: Express.Multer.File,
  folder: 'users' | 'tournaments' | 'teams' | 'competitions'
): Promise<string> {
  const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
  const key = `${folder}/${randomUUID()}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  // Return a proxy URL so images are served through the app server,
  // avoiding direct browser requests to Cloudflare (which corporate firewalls block).
  return `/api/images/${key}`;
}

export async function getFromR2(key: string): Promise<{ body: Readable; contentType: string }> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!response.Body) throw new Error('Empty R2 response body');
  return {
    body: response.Body as unknown as Readable,
    contentType: response.ContentType ?? 'application/octet-stream',
  };
}
