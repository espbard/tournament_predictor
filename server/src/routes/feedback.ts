import { Router } from 'express';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback, users } from '../db/schema.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { generateId } from 'lucia';

export const feedbackRouter = Router();

const VALID_TYPES = ['feature_request', 'improvement', 'bug'] as const;
const VALID_STATUSES = ['pending', 'will_do', 'implemented', 'fixed', 'wont_do'] as const;

feedbackRouter.post('/', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    if (user.isAdmin) return res.status(403).json({ error: 'Admins cannot submit feedback' });

    const { type, message } = req.body;
    if (!type || !message?.trim()) return res.status(400).json({ error: 'type and message required' });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type' });

    const [row] = await db
      .insert(feedback)
      .values({ id: generateId(15), userId: user.id, type, message: message.trim() })
      .returning();

    return res.json(row);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

feedbackRouter.get('/my', requireAuth, async (_req, res) => {
  try {
    const user = res.locals.user;
    const rows = await db
      .select({
        id: feedback.id,
        type: feedback.type,
        message: feedback.message,
        status: feedback.status,
        createdAt: feedback.createdAt,
        updatedAt: feedback.updatedAt,
      })
      .from(feedback)
      .where(eq(feedback.userId, user.id))
      .orderBy(desc(feedback.createdAt));
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

feedbackRouter.get('/', requireAdmin, async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: feedback.id,
        userId: feedback.userId,
        username: users.username,
        type: feedback.type,
        message: feedback.message,
        status: feedback.status,
        createdAt: feedback.createdAt,
        updatedAt: feedback.updatedAt,
      })
      .from(feedback)
      .leftJoin(users, eq(feedback.userId, users.id))
      .orderBy(desc(feedback.createdAt));
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

feedbackRouter.patch('/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });

    const [row] = await db
      .update(feedback)
      .set({ status, updatedAt: new Date() })
      .where(eq(feedback.id, id))
      .returning();

    if (!row) return res.status(404).json({ error: 'not found' });
    return res.json(row);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

feedbackRouter.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(feedback).where(eq(feedback.id, id));
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
