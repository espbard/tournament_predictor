import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { uploadToR2, type R2Folder } from '../lib/r2';

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
      // 'live-players' is here because a player's picture is uploaded by an admin through
      // this form; 'live-teams' is not, because crests are mirrored server-side.
      const allowedTypes = ['users', 'tournaments', 'teams', 'competitions', 'live-players'];
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${allowedTypes.join(', ')}` });
      }

      const url = await uploadToR2(req.file, type as R2Folder);
      return res.json({ url });
    } catch (err: any) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: err.message ?? 'Upload failed' });
    }
  }
);
