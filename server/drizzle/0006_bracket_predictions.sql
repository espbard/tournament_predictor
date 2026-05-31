CREATE TABLE "bracket_predictions" (
  "competition_id" text NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "predictions" json NOT NULL DEFAULT '{}',
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "bracket_predictions_pkey" PRIMARY KEY("competition_id","user_id")
);
