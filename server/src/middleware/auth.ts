import { Lucia } from 'lucia';
import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import type { RequestHandler } from 'express';
import { db } from '../db/client';
import { sessions, users } from '../db/schema';

const adapter = new DrizzlePostgreSQLAdapter(db, sessions, users);

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    attributes: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  },
  getUserAttributes(attributes) {
    return {
      username: attributes.username,
      isAdmin: attributes.isAdmin,
      isTestAccount: attributes.isTestAccount,
      isLeaderboardUser: attributes.isLeaderboardUser,
      isComparisonUser: attributes.isComparisonUser,
    };
  },
});

declare module 'lucia' {
  interface Register {
    Lucia: typeof lucia;
    DatabaseUserAttributes: {
      username: string;
      isAdmin: boolean;
      isTestAccount: boolean;
      isLeaderboardUser: boolean;
      isComparisonUser: boolean;
    };
  }
}

async function getValidatedSession(cookieHeader: string | undefined) {
  const sessionId = lucia.readSessionCookie(cookieHeader ?? '');
  if (!sessionId) return null;
  return lucia.validateSession(sessionId);
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const result = await getValidatedSession(req.headers.cookie);
  if (!result?.session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (result.session.fresh) {
    res.setHeader('Set-Cookie', lucia.createSessionCookie(result.session.id).serialize());
  }
  res.locals.user = result.user;
  res.locals.session = result.session;
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const result = await getValidatedSession(req.headers.cookie);
  if (!result?.session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!result.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (result.session.fresh) {
    res.setHeader('Set-Cookie', lucia.createSessionCookie(result.session.id).serialize());
  }
  res.locals.user = result.user;
  res.locals.session = result.session;
  next();
};
