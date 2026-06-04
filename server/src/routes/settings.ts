import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { appConfig } from '../db/schema';
import { requireAdmin } from '../middleware/auth';

export const settingsRouter = Router();

settingsRouter.get('/maintenance', async (_req, res) => {
  const [config] = await db
    .select({ maintenanceMode: appConfig.maintenanceMode })
    .from(appConfig)
    .where(eq(appConfig.id, 'singleton'))
    .limit(1);
  return res.json({ maintenanceMode: config?.maintenanceMode ?? false });
});

settingsRouter.patch('/maintenance', requireAdmin, async (req, res) => {
  const { maintenanceMode } = req.body;
  if (typeof maintenanceMode !== 'boolean') {
    return res.status(400).json({ error: 'maintenanceMode must be a boolean' });
  }
  await db
    .insert(appConfig)
    .values({ id: 'singleton', maintenanceMode })
    .onConflictDoUpdate({ target: appConfig.id, set: { maintenanceMode } });
  return res.json({ maintenanceMode });
});
