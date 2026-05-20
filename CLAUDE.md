# Brainwave — Project Conventions

## Project context

- Live URL: https://brainwave.wingmate-builder.com
- Repo: https://github.com/furoyce/brainwave
- Linear project: **Brainwave** on team **JRF** (https://linear.app/jrf/project/brainwave-44f19339c4f9)
- Stack: FastAPI + WebSocket backend (`realtime_server.py`, entrypoint `realtime_server:app`), static HTML/JS frontend, OpenAI Realtime API for transcription, Gemini for Readability/Correctness.
- Deploy target: Vercel (project under team `wingmate-b5e12139`). Entrypoint is declared in `pyproject.toml` under `[tool.vercel]`.

## Linear workflow (mandatory)

When working on this project, always close the loop in Linear:

1. **Before starting open-ended work**, list issues in the Brainwave project (`list_issues` filtered by `project: "Brainwave"` across `Todo` / `Backlog` / `In Progress`). If a pending issue matches the request, pick it up and link the work to it instead of creating a new one.
2. **For every shipped change**, ensure there is a Linear issue in the Brainwave project tracking it. Create one if missing — `team: "JRF"`, `project: "Brainwave"`, with PR / commit / docs links in `links`.
3. **After each meaningful update** (push, PR open, fix, build green/red), post a `save_comment` on the issue summarizing what changed and which commit/PR it landed in. Keep the issue `state` reflecting reality: `In Review` while a PR is open, `Done` once merged.
4. **Do not** open Linear issues outside the JRF team's Brainwave project from this repo.
