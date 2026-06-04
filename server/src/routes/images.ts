import { Router } from 'express';
import { getFromR2 } from '../lib/r2';

export const imagesRouter = Router();

const VALID_FOLDERS = new Set(['users', 'tournaments', 'teams', 'competitions']);

imagesRouter.get('/:folder/:filename', async (req, res) => {
  const { folder, filename } = req.params;

  if (!VALID_FOLDERS.has(folder) || filename.includes('..') || filename.includes('/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    const { body, contentType } = await getFromR2(`${folder}/${filename}`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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
