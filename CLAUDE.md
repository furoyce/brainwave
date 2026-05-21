# Brainwave — Project Conventions

## Project context

- Live URL: https://brainwave.wingmate-builder.com
- Repo: https://github.com/furoyce/brainwave
- Linear project: **Brainwave** on team **JRF** (https://linear.app/jrf/project/brainwave-44f19339c4f9)
- Stack: WebRTC frontend (browser connects directly to OpenAI Realtime via ephemeral tokens) + FastAPI serverless function at `api/index.py` for token minting, Readability / Correctness streaming, and transcript persistence. Static assets in `public/`. Postgres for transcript storage (via `psycopg2` and `DATABASE_URL`).
- Deploy target: Vercel (project `brainwave` under team `wingmate-b5e12139`). `api/index.py` is at the conventional path Vercel's FastAPI builder auto-detects. `vercel.json` rewrites `/` and `/api/*` to the function; everything else is served from `public/` as a static asset.
- `public/index.html` is the source-of-truth for the rendered UI, but the bytes actually served at `/` come from the `INDEX_HTML` string inlined in `api/index.py`. Keep the two in sync when adding model options or UI elements.

## Linear workflow (mandatory)

When working on this project, always close the loop in Linear:

1. **Before starting open-ended work**, list issues in the Brainwave project (`list_issues` filtered by `project: "Brainwave"` across `Todo` / `Backlog` / `In Progress`). If a pending issue matches the request, pick it up and link the work to it instead of creating a new one.
2. **For every shipped change**, ensure there is a Linear issue in the Brainwave project tracking it. Create one if missing — `team: "JRF"`, `project: "Brainwave"`, with PR / commit / docs links in `links`.
3. **After each meaningful update** (push, PR open, fix, build green/red), post a `save_comment` on the issue summarizing what changed and which commit/PR it landed in. Keep the issue `state` reflecting reality: `In Review` while a PR is open, `Done` once merged.
4. **Do not** open Linear issues outside the JRF team's Brainwave project from this repo.
