import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { uploadToR2 } from '../lib/r2';

export const uploadRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (jpeg, png, gif, webp)'));
    }
  },
});

uploadRouter.post(
  '/',
  requireAuth,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const type = req.body.type as string;
      if (!['users', 'tournaments', 'teams', 'competitions'].includes(type)) {
        return res.status(400).json({ error: 'Invalid type. Must be users, tournaments, teams, or competitions' });
      }

      const url = await uploadToR2(req.file, type as 'users' | 'tournaments' | 'teams' | 'competitions');
      return res.json({ url });
    } catch (err: any) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: err.message ?? 'Upload failed' });
    }
  }
);
