# Tournament Predictor

A web app for predicting sports tournament outcomes. Small private groups compete to see who can best predict match results.

## Tech stack

- **Frontend** — React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, Zustand
- **Backend** — Node.js, Express, TypeScript, Drizzle ORM
- **Database** — PostgreSQL
- **Auth** — Lucia v3 (username + password, session cookie)
- **Deployment** — Railway (single service — Express serves the built React app)

---

## Prerequisites

- Node.js 20+
- A PostgreSQL database (local or Railway)

---

## Local development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set `DATABASE_URL` to your local PostgreSQL connection string.

### 3. Run database migrations

Generate SQL from the Drizzle schema, then apply it:

```bash
npm run db:generate   # writes migration files to server/drizzle/
npm run db:migrate    # applies migrations to the database
```

Re-run both commands whenever you change `server/src/db/schema.ts`.

### 4. Start the dev servers

```bash
npm run dev
```

This starts two processes in parallel:

| Process | URL |
|---|---|
| Vite (React) | http://localhost:5173 |
| Express (API) | http://localhost:3000 |

Vite proxies all `/api` requests to Express, so you only ever open `localhost:5173` in the browser.

---

## Other commands

```bash
# Run only the backend
npm run dev -w server

# Run only the frontend
npm run dev -w client

# Type-check without building
cd client && npx tsc --noEmit
cd server && npx tsc --noEmit
```

---

## Production build

```bash
npm run build    # builds client (Vite) then server (tsup)
npm run start    # starts Express, which serves client/dist/ as static files
```

The server reads `PORT` from the environment (Railway sets this automatically).

---

## Adding shadcn/ui components

```bash
cd client
npx shadcn-ui@latest add button
npx shadcn-ui@latest add input
# etc.
```

---

## Project structure

```
├── client/          # React + Vite frontend
│   └── src/
│       ├── pages/       # Route-level page components
│       ├── components/  # Shared UI components
│       ├── lib/         # api.ts fetch wrapper, utils
│       └── store/       # Zustand stores
├── server/          # Express backend
│   └── src/
│       ├── db/          # Drizzle schema, migrations, client
│       ├── routes/      # Express routers (one file per domain)
│       ├── middleware/  # Auth (requireAuth, requireAdmin)
│       └── lib/         # Scoring engine
├── shared/          # Zod schemas and TypeScript types used by both
└── package.json     # npm workspaces root
```
