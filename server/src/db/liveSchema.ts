import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  integer,
  json,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type { LiveBonusAnswerType, LiveScoringConfig } from '@tournament-predictor/shared';
import { users } from './schema';

// ── Live (API-linked) tournaments ─────────────────────────────────────────────
//
// A completely separate tournament type from the tables in ./schema.ts. Nothing here
// references tournaments / teams / matches / competitions / predictions; the only shared
// table is `users`. See docs/LIVE_TOURNAMENTS_PLAN.md before changing anything.
//
// Unlike the manual tables, every table here has a real primary key and the unique
// constraints the data actually requires — in particular on live_predictions, where the
// manual `predictions` table relies on app-level enforcement.

// ── Enums ─────────────────────────────────────────────────────────────────────

export const liveProviderEnum = pgEnum('live_provider', ['football_data', 'big_balls']);

export const liveTournamentStatusEnum = pgEnum('live_tournament_status', [
  'upcoming',
  'active',
  'completed',
]);

export const liveFixtureStatusEnum = pgEnum('live_fixture_status', [
  'scheduled',
  'in_play',
  'paused',
  'finished',
  'postponed',
  'suspended',
  'cancelled',
]);

export const liveQualificationStatusEnum = pgEnum('live_qualification_status', [
  'qualified',
  'pending',
  'eliminated',
]);

// Its own enum rather than the manual type's `bonus_answer_type`, so the live list can
// grow or shrink without touching a type the manual tournaments depend on.
export const liveBonusAnswerTypeEnum = pgEnum('live_bonus_answer_type', [
  'number',
  'player',
  'team',
  'yes_no',
  'country',
]);

// ── Tables ────────────────────────────────────────────────────────────────────

export const liveTournaments = pgTable(
  'live_tournaments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    imageUrl: text('image_url'),
    /** Which entry of LIVE_TOURNAMENT_PRESETS this was created from. */
    presetKey: text('preset_key'),
    provider: liveProviderEnum('provider').notNull().default('football_data'),
    /**
     * Where fixtures come from, when that is not `provider`. Null means the same
     * provider serves everything, which is the normal case.
     */
    fixtureProvider: liveProviderEnum('fixture_provider'),
    /**
     * The fixture provider's own identifier for the competition — providers do not agree
     * on those either. Null falls back to `providerCompetitionId`.
     */
    fixtureProviderCompetitionId: text('fixture_provider_competition_id'),
    providerCompetitionId: text('provider_competition_id').notNull(),
    /** Season identifier as the provider expresses it — football-data uses the start year. */
    season: text('season').notNull(),
    /** LiveFormatKey — resolved through getLiveFormat() in shared/src/live/formats.ts. */
    format: text('format').notNull(),
    /** Stages before this one are ingested but never predictable. */
    startStageKey: text('start_stage_key').notNull(),
    status: liveTournamentStatusEnum('status').notNull().default('upcoming'),
    syncEnabled: boolean('sync_enabled').notNull().default(true),
    lastStructureSyncAt: timestamp('last_structure_sync_at'),
    lastFixtureSyncAt: timestamp('last_fixture_sync_at'),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  t => ({
    providerSeasonUnique: uniqueIndex('live_tournaments_provider_competition_season_unique').on(
      t.provider,
      t.providerCompetitionId,
      t.season,
    ),
  }),
);

export const liveTeams = pgTable(
  'live_teams',
  {
    id: text('id').primaryKey(),
    liveTournamentId: text('live_tournament_id')
      .notNull()
      .references(() => liveTournaments.id, { onDelete: 'cascade' }),
    providerTeamId: text('provider_team_id').notNull(),
    name: text('name').notNull(),
    shortName: text('short_name'),
    tla: text('tla'),
    /** Mirrored into R2 during sync so it serves through /api/images/*. */
    crestUrl: text('crest_url'),
    groupName: text('group_name'),
    /** Derived from provider data by the sync engine — never set by hand. */
    qualificationStatus: liveQualificationStatusEnum('qualification_status')
      .notNull()
      .default('pending'),
  },
  t => ({
    providerTeamUnique: uniqueIndex('live_teams_tournament_provider_team_unique').on(
      t.liveTournamentId,
      t.providerTeamId,
    ),
  }),
);

export const liveFixtures = pgTable(
  'live_fixtures',
  {
    id: text('id').primaryKey(),
    liveTournamentId: text('live_tournament_id')
      .notNull()
      .references(() => liveTournaments.id, { onDelete: 'cascade' }),
    providerFixtureId: text('provider_fixture_id').notNull(),
    // Nullable: knockout fixtures exist before the teams that will contest them are known.
    homeTeamId: text('home_team_id').references(() => liveTeams.id, { onDelete: 'set null' }),
    awayTeamId: text('away_team_id').references(() => liveTeams.id, { onDelete: 'set null' }),
    kickoffAt: timestamp('kickoff_at'),
    /** Provider distinguishes a provisional date from a confirmed kickoff time. */
    kickoffConfirmed: boolean('kickoff_confirmed').notNull().default(false),
    status: liveFixtureStatusEnum('status').notNull().default('scheduled'),
    /** Internal stage key. Null when the provider stage is unmapped — surfaced as a warning. */
    stageKey: text('stage_key'),
    /** Raw provider stage string, kept so a provider rename is diagnosable. */
    providerStage: text('provider_stage'),
    groupName: text('group_name'),
    matchday: integer('matchday'),
    /** Groups the two legs of a two-legged tie. Null for single-leg fixtures. */
    tieKey: text('tie_key'),
    legNumber: integer('leg_number'),
    /**
     * Whole-number multiplier on every point this fixture awards. Set by an admin, never
     * by the provider — the sync upsert deliberately leaves it alone.
     */
    multiplier: integer('multiplier').notNull().default(1),

    // Score at the end of normal time (90 minutes plus stoppage). The ONLY score that
    // awards points — extra time and penalties are stored for display but never scored.
    normalTimeHome: integer('normal_time_home'),
    normalTimeAway: integer('normal_time_away'),
    halfTimeHome: integer('half_time_home'),
    halfTimeAway: integer('half_time_away'),
    extraTimeHome: integer('extra_time_home'),
    extraTimeAway: integer('extra_time_away'),
    penaltiesHome: integer('penalties_home'),
    penaltiesAway: integer('penalties_away'),
    /** Provider full-time score, including extra time. Display only. */
    finalHome: integer('final_home'),
    finalAway: integer('final_away'),

    winner: text('winner'),
    minute: integer('minute'),
    /** The provider's score object verbatim, so any mapping bug stays diagnosable. */
    providerScoreRaw: json('provider_score_raw'),
    providerLastUpdated: timestamp('provider_last_updated'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    providerFixtureUnique: uniqueIndex('live_fixtures_tournament_provider_fixture_unique').on(
      t.liveTournamentId,
      t.providerFixtureId,
    ),
    kickoffIdx: index('live_fixtures_tournament_kickoff_idx').on(t.liveTournamentId, t.kickoffAt),
    stageIdx: index('live_fixtures_tournament_stage_idx').on(t.liveTournamentId, t.stageKey),
    statusIdx: index('live_fixtures_status_idx').on(t.status),
  }),
);

export const liveStandings = pgTable(
  'live_standings',
  {
    id: text('id').primaryKey(),
    liveTournamentId: text('live_tournament_id')
      .notNull()
      .references(() => liveTournaments.id, { onDelete: 'cascade' }),
    stageKey: text('stage_key').notNull(),
    groupName: text('group_name'),
    teamId: text('team_id')
      .notNull()
      .references(() => liveTeams.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    played: integer('played').notNull().default(0),
    won: integer('won').notNull().default(0),
    drawn: integer('drawn').notNull().default(0),
    lost: integer('lost').notNull().default(0),
    goalsFor: integer('goals_for').notNull().default(0),
    goalsAgainst: integer('goals_against').notNull().default(0),
    goalDifference: integer('goal_difference').notNull().default(0),
    points: integer('points').notNull().default(0),
    form: text('form'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    // A team appears once per stage. group_name is deliberately NOT part of the key —
    // it is nullable, and Postgres treats NULLs as distinct, which would let duplicates
    // through for single-table formats.
    teamStageUnique: uniqueIndex('live_standings_tournament_stage_team_unique').on(
      t.liveTournamentId,
      t.stageKey,
      t.teamId,
    ),
  }),
);

export const liveCompetitions = pgTable('live_competitions', {
  id: text('id').primaryKey(),
  liveTournamentId: text('live_tournament_id')
    .notNull()
    .references(() => liveTournaments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  imageUrl: text('image_url'),
  inviteCode: text('invite_code').notNull().unique(),
  // Share-link token. Null until somebody presses Invite for the first time.
  inviteToken: text('invite_token').unique(),
  scoringConfig: json('scoring_config').notNull().$type<LiveScoringConfig>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  // Deliberately no prediction_deadline column: the live type locks per fixture only.
});

export const liveCompetitionMembers = pgTable(
  'live_competition_members',
  {
    id: text('id').primaryKey(),
    liveCompetitionId: text('live_competition_id')
      .notNull()
      .references(() => liveCompetitions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
    // Denormalised score aggregate, recomputed by the scoring trigger.
    correctOutcomePoints: integer('correct_outcome_points').notNull().default(0),
    correctGoalDifferencePoints: integer('correct_goal_difference_points').notNull().default(0),
    exactScorePoints: integer('exact_score_points').notNull().default(0),
    /** Exact-position plus band points from the table prediction. */
    tablePoints: integer('table_points').notNull().default(0),
    /** Bonus question points. Stays zero until the tournament is marked completed. */
    bonusPoints: integer('bonus_points').notNull().default(0),
    /** Top-scorer ranking points. Also withheld until the tournament is completed. */
    scorerPoints: integer('scorer_points').notNull().default(0),
    totalPoints: integer('total_points').notNull().default(0),
  },
  t => ({
    memberUnique: uniqueIndex('live_competition_members_competition_user_unique').on(
      t.liveCompetitionId,
      t.userId,
    ),
  }),
);

export const livePredictions = pgTable(
  'live_predictions',
  {
    id: text('id').primaryKey(),
    liveCompetitionId: text('live_competition_id')
      .notNull()
      .references(() => liveCompetitions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    liveFixtureId: text('live_fixture_id')
      .notNull()
      .references(() => liveFixtures.id, { onDelete: 'cascade' }),
    homeScore: integer('home_score').notNull(),
    awayScore: integer('away_score').notNull(),
    /** Null until the fixture finishes and scoring runs. */
    points: integer('points'),
    correctOutcomePoints: integer('correct_outcome_points').notNull().default(0),
    correctGoalDifferencePoints: integer('correct_goal_difference_points').notNull().default(0),
    exactScorePoints: integer('exact_score_points').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    predictionUnique: uniqueIndex('live_predictions_competition_user_fixture_unique').on(
      t.liveCompetitionId,
      t.userId,
      t.liveFixtureId,
    ),
    fixtureIdx: index('live_predictions_fixture_idx').on(t.liveFixtureId),
  }),
);

export const liveTablePredictions = pgTable(
  'live_table_predictions',
  {
    id: text('id').primaryKey(),
    liveCompetitionId: text('live_competition_id')
      .notNull()
      .references(() => liveCompetitions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which table stage this predicts — a format could grow a second one later. */
    stageKey: text('stage_key').notNull(),
    /**
     * live_teams ids, top of the table first. Stored whole rather than a row per team
     * because the ordering *is* the prediction and it is only ever read and written
     * complete. No FK, so a team removed from the tournament degrades to a stale id
     * rather than destroying the whole prediction.
     */
    orderedTeamIds: json('ordered_team_ids').notNull().$type<string[]>(),
    /** Null until every fixture in the stage has been played and scoring runs. */
    points: integer('points'),
    exactPositionPoints: integer('exact_position_points').notNull().default(0),
    bandPoints: integer('band_points').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    tablePredictionUnique: uniqueIndex('live_table_predictions_competition_user_stage_unique').on(
      t.liveCompetitionId,
      t.userId,
      t.stageKey,
    ),
  }),
);

export const livePlayers = pgTable(
  'live_players',
  {
    id: text('id').primaryKey(),
    liveTournamentId: text('live_tournament_id')
      .notNull()
      .references(() => liveTournaments.id, { onDelete: 'cascade' }),
    /**
     * The provider's own player id, when the row came from the scorers feed.
     *
     * Null for a player an admin typed in, which is also what protects that player's
     * hand-entered goals: the sync only writes rows it can identify.
     */
    providerPlayerId: text('provider_player_id'),
    name: text('name').notNull(),
    teamId: text('team_id').references(() => liveTeams.id, { onDelete: 'set null' }),
    /** The provider's own wording — "Centre-Forward". Only used to filter the admin list. */
    position: text('position'),
    imageUrl: text('image_url'),
    goals: integer('goals').notNull().default(0),
    /** Breaks a tie on goals. See rankLiveScorers in server/src/live/scorerScoring.ts. */
    assists: integer('assists').notNull().default(0),
    /** Whether the player is in the shortlist users rank. Admin-chosen, false by default. */
    isSelected: boolean('is_selected').notNull().default(false),
    providerLastUpdated: timestamp('provider_last_updated'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    // Postgres treats NULLs as distinct, so every hand-added player is unique here
    // however many of them there are — which is exactly what this needs.
    providerPlayerUnique: uniqueIndex('live_players_tournament_provider_player_unique').on(
      t.liveTournamentId,
      t.providerPlayerId,
    ),
    tournamentIdx: index('live_players_tournament_idx').on(t.liveTournamentId),
  }),
);

export const liveScorerPredictions = pgTable(
  'live_scorer_predictions',
  {
    id: text('id').primaryKey(),
    liveCompetitionId: text('live_competition_id')
      .notNull()
      .references(() => liveCompetitions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * live_players ids, top scorer first. Stored whole for the same reason the table
     * prediction is, and with no FK for the same reason: a player dropped from the
     * shortlist should leave a stale id, not destroy the ranking around it.
     */
    orderedPlayerIds: json('ordered_player_ids').notNull().$type<string[]>(),
    /** Null until the tournament is marked completed and scoring runs. */
    points: integer('points'),
    exactPositionPoints: integer('exact_position_points').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    scorerPredictionUnique: uniqueIndex('live_scorer_predictions_competition_user_unique').on(
      t.liveCompetitionId,
      t.userId,
    ),
  }),
);

export const liveGameweekSelections = pgTable(
  'live_gameweek_selections',
  {
    id: text('id').primaryKey(),
    liveTournamentId: text('live_tournament_id')
      .notNull()
      .references(() => liveTournaments.id, { onDelete: 'cascade' }),
    /** A gameweek is one matchday inside one stage, so both identify it. */
    stageKey: text('stage_key').notNull(),
    matchday: integer('matchday').notNull(),
    /**
     * live_fixtures ids the admin picked out of this gameweek. Stored whole rather than a
     * row per fixture because it is only ever read and written complete. No FK, so a
     * fixture the provider drops degrades to a stale id rather than silently widening the
     * selection. A row is never stored empty — see the route — because "no row" already
     * means "nothing selected".
     */
    selectedFixtureIds: json('selected_fixture_ids').notNull().$type<string[]>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    gameweekUnique: uniqueIndex('live_gameweek_selections_tournament_stage_matchday_unique').on(
      t.liveTournamentId,
      t.stageKey,
      t.matchday,
    ),
  }),
);

export const liveBonusQuestions = pgTable('live_bonus_questions', {
  id: text('id').primaryKey(),
  liveTournamentId: text('live_tournament_id')
    .notNull()
    .references(() => liveTournaments.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  answerType: liveBonusAnswerTypeEnum('answer_type').notNull().default('number').$type<LiveBonusAnswerType>(),
  points: integer('points').notNull(),
  /** Null until an admin records it. A JSON array of strings when several answers count. */
  correctAnswer: text('correct_answer'),
  /**
   * Per-question deadline. Null means the default — one hour before the first match of the
   * tournament's starting stage, the same instant the table prediction locks. See
   * shared/src/live/lock.ts.
   */
  lockAt: timestamp('lock_at'),

  // ── Optional constraints — see shared/src/live/bonus.ts ─────────────────────
  /** Inclusive bounds on a number answer. Null on either side leaves that side open. */
  minValue: integer('min_value'),
  maxValue: integer('max_value'),
  /** A number answer within ±leeway of the correct one scores in full. */
  leeway: integer('leeway'),
  /**
   * The only answers a player, team or country question accepts, stored whole because it
   * is only ever read and written complete. Null or empty means every option is available.
   */
  options: json('options').$type<string[]>(),

  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const liveBonusAnswers = pgTable(
  'live_bonus_answers',
  {
    id: text('id').primaryKey(),
    questionId: text('question_id')
      .notNull()
      .references(() => liveBonusQuestions.id, { onDelete: 'cascade' }),
    liveCompetitionId: text('live_competition_id')
      .notNull()
      .references(() => liveCompetitions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    answer: text('answer').notNull(),
    /** Null until the tournament is completed and bonus scoring runs. */
    points: integer('points'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => ({
    // The uniqueness the manual bonus_answers table enforces in app code only.
    answerUnique: uniqueIndex('live_bonus_answers_question_competition_user_unique').on(
      t.questionId,
      t.liveCompetitionId,
      t.userId,
    ),
    competitionIdx: index('live_bonus_answers_competition_idx').on(t.liveCompetitionId),
  }),
);

// ── Relations ─────────────────────────────────────────────────────────────────

export const liveTournamentsRelations = relations(liveTournaments, ({ many }) => ({
  teams: many(liveTeams),
  fixtures: many(liveFixtures),
  standings: many(liveStandings),
  competitions: many(liveCompetitions),
  gameweekSelections: many(liveGameweekSelections),
  bonusQuestions: many(liveBonusQuestions),
}));

export const liveBonusQuestionsRelations = relations(liveBonusQuestions, ({ one, many }) => ({
  tournament: one(liveTournaments, {
    fields: [liveBonusQuestions.liveTournamentId],
    references: [liveTournaments.id],
  }),
  answers: many(liveBonusAnswers),
}));

export const liveBonusAnswersRelations = relations(liveBonusAnswers, ({ one }) => ({
  question: one(liveBonusQuestions, {
    fields: [liveBonusAnswers.questionId],
    references: [liveBonusQuestions.id],
  }),
  competition: one(liveCompetitions, {
    fields: [liveBonusAnswers.liveCompetitionId],
    references: [liveCompetitions.id],
  }),
  user: one(users, {
    fields: [liveBonusAnswers.userId],
    references: [users.id],
  }),
}));

export const liveGameweekSelectionsRelations = relations(liveGameweekSelections, ({ one }) => ({
  tournament: one(liveTournaments, {
    fields: [liveGameweekSelections.liveTournamentId],
    references: [liveTournaments.id],
  }),
}));

export const liveTeamsRelations = relations(liveTeams, ({ one }) => ({
  tournament: one(liveTournaments, {
    fields: [liveTeams.liveTournamentId],
    references: [liveTournaments.id],
  }),
}));

export const liveFixturesRelations = relations(liveFixtures, ({ one, many }) => ({
  tournament: one(liveTournaments, {
    fields: [liveFixtures.liveTournamentId],
    references: [liveTournaments.id],
  }),
  homeTeam: one(liveTeams, {
    fields: [liveFixtures.homeTeamId],
    references: [liveTeams.id],
    relationName: 'liveFixtureHomeTeam',
  }),
  awayTeam: one(liveTeams, {
    fields: [liveFixtures.awayTeamId],
    references: [liveTeams.id],
    relationName: 'liveFixtureAwayTeam',
  }),
  predictions: many(livePredictions),
}));

export const liveStandingsRelations = relations(liveStandings, ({ one }) => ({
  tournament: one(liveTournaments, {
    fields: [liveStandings.liveTournamentId],
    references: [liveTournaments.id],
  }),
  team: one(liveTeams, {
    fields: [liveStandings.teamId],
    references: [liveTeams.id],
  }),
}));

export const liveCompetitionsRelations = relations(liveCompetitions, ({ one, many }) => ({
  tournament: one(liveTournaments, {
    fields: [liveCompetitions.liveTournamentId],
    references: [liveTournaments.id],
  }),
  members: many(liveCompetitionMembers),
  predictions: many(livePredictions),
}));

export const liveCompetitionMembersRelations = relations(liveCompetitionMembers, ({ one }) => ({
  competition: one(liveCompetitions, {
    fields: [liveCompetitionMembers.liveCompetitionId],
    references: [liveCompetitions.id],
  }),
  user: one(users, {
    fields: [liveCompetitionMembers.userId],
    references: [users.id],
  }),
}));

export const liveTablePredictionsRelations = relations(liveTablePredictions, ({ one }) => ({
  competition: one(liveCompetitions, {
    fields: [liveTablePredictions.liveCompetitionId],
    references: [liveCompetitions.id],
  }),
  user: one(users, {
    fields: [liveTablePredictions.userId],
    references: [users.id],
  }),
}));

export const livePredictionsRelations = relations(livePredictions, ({ one }) => ({
  competition: one(liveCompetitions, {
    fields: [livePredictions.liveCompetitionId],
    references: [liveCompetitions.id],
  }),
  user: one(users, {
    fields: [livePredictions.userId],
    references: [users.id],
  }),
  fixture: one(liveFixtures, {
    fields: [livePredictions.liveFixtureId],
    references: [liveFixtures.id],
  }),
}));
