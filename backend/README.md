# TaskForge

Background job processing backend: GraphQL API, Postgres + Prisma, pg-boss queue.
Three services, one codebase, no Docker.

## Services

| Service | Entry | Does | Health |
|---|---|---|---|
| api | `src/services/api` | GraphQL, auth, puts jobs on the queue | `:4000/health` |
| worker | `src/services/worker` | runs jobs (REPORT / EMAIL_BATCH / DATA_EXPORT), retries, dead-letter queue | `:4001/health` |
| scheduler | `src/services/scheduler` | cron ticks for recurring jobs + pg-boss maintenance. **Run exactly one** | `:4002/health` |

Shared code (config, logger, prisma client, queue, health, shutdown) lives in `src/shared`.

## Run

```bash
npm install
npx prisma generate
cp .env.example .env     # then fill it in
npm run dev              # all three, prefixed logs
# or one at a time: npm run dev:api | dev:worker | dev:scheduler
npm test
npm run build && npm run start:api   # start:worker, start:scheduler
```

## Job lifecycle

`PENDING -> RUNNING -> COMPLETED`. On failure pg-boss retries with backoff (default 2 retries, 5s then ~10s).
Job is `PENDING` between attempts, `FAILED` after the last one, then lands in `process-job-dlq`.
The DLQ worker makes sure it is `FAILED` and adds a history entry (also catches jobs whose worker crashed).

Every attempt is a `JobLog` row. Results are saved in `Job.result`.

Test it: `createJob(type: REPORT, payload: "fail")` (dev only, simulated failure) and watch `logs`.

## Job types

- **REPORT** `{ days?: 30, scope?: "user" | "all" }` -> counts by status/type, success rate, retried jobs, recent failures. `scope: "all"` is ADMIN only.
- **DATA_EXPORT** `{ format?: "csv" | "json", status?, type? }` -> file in `EXPORT_DIR/<jobId>.<format>`, path in result.
- **EMAIL_BATCH** `{ recipients: string[], subject?, body? }` -> fake sender (nothing leaves the machine). Addresses containing `bounce` fail.

## Ops

- `GET /health` -> 200 / 503 with database + queue checks.
- Rate limit: per IP, in memory (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`), 429 + `Retry-After`. `/health` is exempt.
- SIGINT/SIGTERM: stop accepting requests, finish in-flight, let running jobs finish, close pg-boss and Prisma.
- Logs: pretty in dev, JSON lines when `NODE_ENV=production`.
