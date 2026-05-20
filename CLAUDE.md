# Brainwave — Project Conventions

## Project context

- Live URL: https://brainwave.wingmate-builder.com
- Repo: https://github.com/furoyce/brainwave
- Linear project: **Brainwave** on team **JRF** (https://linear.app/jrf/project/brainwave-44f19339c4f9)
- Stack: FastAPI + WebSocket backend (`main.py`, entrypoint `main:app`), static HTML/JS frontend, OpenAI Realtime API for transcription, Gemini for Readability/Correctness.
- Deploy target: Vercel (project under team `wingmate-b5e12139`). The Python entrypoint module is named `main.py` so Vercel's FastAPI builder auto-detects it (the builder only auto-detects `main.py` / `app.py` / `api/index.py` etc.; non-standard module names need either a rename like this one, or an explicit `[tool.vercel] entrypoint` declaration in a fully-fleshed-out `pyproject.toml`).
- `.vercelignore` excludes `tests/` so the FastAPI builder doesn't see a second `app` symbol via `tests/test_realtime_server.py`'s `from main import app`.

## Linear workflow (mandatory)

When working on this project, always close the loop in Linear:

1. **Before starting open-ended work**, list issues in the Brainwave project (`list_issues` filtered by `project: "Brainwave"` across `Todo` / `Backlog` / `In Progress`). If a pending issue matches the request, pick it up and link the work to it instead of creating a new one.
2. **For every shipped change**, ensure there is a Linear issue in the Brainwave project tracking it. Create one if missing — `team: "JRF"`, `project: "Brainwave"`, with PR / commit / docs links in `links`.
3. **After each meaningful update** (push, PR open, fix, build green/red), post a `save_comment` on the issue summarizing what changed and which commit/PR it landed in. Keep the issue `state` reflecting reality: `In Review` while a PR is open, `Done` once merged.
4. **Do not** open Linear issues outside the JRF team's Brainwave project from this repo.
