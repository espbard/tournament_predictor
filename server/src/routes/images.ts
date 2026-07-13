import { Router } from 'express';
import sharp from 'sharp';
import type { Readable } from 'stream';
import { getFromR2 } from '../lib/r2';

export const imagesRouter = Router();

const VALID_FOLDERS = new Set(['users', 'tournaments', 'teams', 'competitions']);
const MAX_RESIZE_WIDTH = 512;

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function parseWidth(raw: unknown): number | null {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_RESIZE_WIDTH);
}

imagesRouter.get('/:folder/:filename', async (req, res) => {
  const { folder, filename } = req.params;
  const width = parseWidth(req.query.w);

  if (!VALID_FOLDERS.has(folder) || filename.includes('..') || filename.includes('/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    const { body, contentType } = await getFromR2(`${folder}/${filename}`);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (width) {
      const buffer = await streamToBuffer(body);
      res.setHeader('Content-Type', contentType);
      try {
        res.send(await sharp(buffer).resize({ width, withoutEnlargement: true }).toBuffer());
      } catch (resizeErr) {
        console.error('Image resize error, falling back to original:', resizeErr);
        res.send(buffer);
      }
      return;
    }

    res.setHeader('Content-Type', contentType);
    body.pipe(res);
  } catch (err: any) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NoSuchKey') {
      res.status(404).json({ error: 'Image not found' });
    } else {
      console.error('R2 proxy error:', err);
      res.status(500).json({ error: 'Failed to load image' });
    }
  }
});
