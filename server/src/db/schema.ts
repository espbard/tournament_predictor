import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  integer,
  json,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type { ScoringConfig } from '@tournament-predictor/shared';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const tournamentStatusEnum = pgEnum('tournament_status', [
  'upcoming',
  'active',
  'completed',
]);

export const matchStageEnum = pgEnum('match_stage', [
  'group',
  'round_of_32',
  'round_of_16',
  'quarter_final',
  'semi_final',
  'bronze_final',
  'final',
]);

export const matchStatusEnum = pgEnum('match_status', ['scheduled', 'completed']);

// ── Tables ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  hashedPassword: text('hashed_password').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Lucia v3 sessions table
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
});

export const tournaments = pgTable('tournaments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: tournamentStatusEnum('status').notNull().default('upcoming'),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const groups = pgTable('groups', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
});

export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
  imageUrl: text('image_url'),
});

export const matches = pgTable('matches', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  homeTeamId: text('home_team_id').references(() => teams.id),
  awayTeamId: text('away_team_id').references(() => teams.id),
  stage: matchStageEnum('stage').notNull(),
  scheduledAt: timestamp('scheduled_at'),
  status: matchStatusEnum('status').notNull().default('scheduled'),
  homeScore: integer('home_score'),
  awayScore: integer('away_score'),
});

export const competitions = pgTable('competitions', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id')
    .notNull()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  imageUrl: text('image_url'),
  inviteCode: text('invite_code').notNull().unique(),
  scoringConfig: json('scoring_config').notNull().$type<ScoringConfig>(),
  predictionDeadline: timestamp('prediction_deadline'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const competitionMembers = pgTable('competition_members', {
  competitionId: text('competition_id')
    .notNull()
    .references(() => competitions.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
});

export const predictions = pgTable('predictions', {
  id: text('id').primaryKey(),
  competitionId: text('competition_id')
    .notNull()
    .references(() => competitions.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  matchId: text('match_id')
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  homeScore: integer('home_score').notNull(),
  awayScore: integer('away_score').notNull(),
  // For knockout draws: which team the user thinks will progress from ET/pens
  progressingTeamId: text('progressing_team_id').references(() => teams.id),
  points: integer('points'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ── Relations ─────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  competitionMembers: many(competitionMembers),
  predictions: many(predictions),
}));

export const tournamentsRelations = relations(tournaments, ({ many }) => ({
  teams: many(teams),
  groups: many(groups),
  matches: many(matches),
  competitions: many(competitions),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  tournament: one(tournaments, {
    fields: [groups.tournamentId],
    references: [tournaments.id],
  }),
  teams: many(teams),
}));

export const matchesRelations = relations(matches, ({ one }) => ({
  tournament: one(tournaments, {
    fields: [matches.tournamentId],
    references: [tournaments.id],
  }),
  homeTeam: one(teams, {
    fields: [matches.homeTeamId],
    references: [teams.id],
  }),
  awayTeam: one(teams, {
    fields: [matches.awayTeamId],
    references: [teams.id],
  }),
}));

export const competitionsRelations = relations(competitions, ({ one, many }) => ({
  tournament: one(tournaments, {
    fields: [competitions.tournamentId],
    references: [tournaments.id],
  }),
  members: many(competitionMembers),
  predictions: many(predictions),
}));
