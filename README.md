# Brainwave: Real-Time Speech Recognition and Summarization Tool

## Table of Contents

1. [Introduction](#introduction)
2. [Deployment](#deployment)
3. [Code Structure & Architecture](#code-structure--architecture)

---

## Introduction

### Background

In the era of rapid information exchange, capturing and organizing ideas swiftly is paramount. **Brainwave** addresses this need by providing a robust speech recognition input method that allows users to effortlessly input their thoughts, regardless of their initial organization. Leveraging advanced technologies, Brainwave transforms potentially messy and unstructured verbal inputs into coherent and logical summaries, enhancing productivity and idea management.

### Goals

- **Efficient Speech Recognition:** Enable users to quickly input ideas through speech, reducing the friction of manual typing.
- **Organized Summarization:** Automatically process and summarize spoken input into structured and logical formats.
- **Multilingual Support:** Cater to a diverse user base by supporting multiple languages, ensuring accessibility and convenience.

### Technical Advantages

1. **Real-Time Processing:**
   - **Low Latency:** Processes audio streams in real-time, providing immediate transcription and summarization, which is essential for maintaining the flow of thoughts.
   - **Continuous Interaction:** Unlike traditional batch processing systems, Brainwave offers seamless real-time interaction, ensuring that users receive timely response on their inputs.

2. **Multilingual Proficiency:**
   - **Diverse Language Support:** Handles inputs in multiple languages without the need for separate processing pipelines, enhancing versatility and user accessibility.
   - **Automatic Language Detection:** Identifies the language of the input automatically, streamlining the user experience.

3. **Sophisticated Text Processing:**
   - **Error Correction:** Utilizes advanced algorithms to identify and correct errors inherent in speech recognition, ensuring accurate transcriptions.
   - **Readability Enhancement:** Improves punctuation and structure of the transcribed text, making summaries clear and professional.
   - **Intent Recognition:** Understands the context and intent behind the spoken words, enabling the generation of meaningful summaries.

---

## Deployment

Brainwave runs on Vercel: the Python serverless function in `api/index.py` is the entrypoint, and the static frontend lives in `public/`. Routing is configured by `vercel.json` (`/` and `/api/*` both go to the function; everything else is served as a static asset out of `public/`).

### Required environment variables

- `OPENAI_API_KEY` — used to mint ephemeral session tokens for the OpenAI Realtime API and to back the Readability / Correctness endpoints.
- `DATABASE_URL` — Postgres connection string used by `api/index.py` to persist transcripts.

### Local development

```bash
pip install -r requirements.txt
vercel dev          # runs the function + static assets locally on http://localhost:3000
```

### Production deploys

Pushes to `master` trigger a production deploy on the `brainwave` Vercel project. The custom domain `brainwave.wingmate-builder.com` is aliased to the latest READY production deployment.

---

## Code Structure & Architecture

### Backend — `api/index.py`

A single Vercel serverless function built on FastAPI. Routes:

- `POST /api/token` — mints an ephemeral OpenAI Realtime session token that the browser uses to open a direct WebRTC connection to the OpenAI API.
- `POST /api/readability` and `POST /api/correctness` — streaming text-processing endpoints.
- `POST /api/transcripts` — persists completed transcripts to Postgres.
- `GET /` — serves the inlined `INDEX_HTML` (the source-of-truth duplicate of `public/index.html`).

The function imports `openai`, `httpx`, and `psycopg2` directly; it does not depend on any other modules in the repo.

### Frontend — `public/`

- `public/index.html` — top bar with Transcribe / Editor mode toggle and model selector; main content area; bottom controls (record / clear / copy).
- `public/main.js` — WebRTC connection to OpenAI Realtime, marker-detection of the transcript stream, Editor mode with live markdown preview, and the Readability / Correctness clients.
- `public/style.css` — styles for both modes.

Vercel serves `public/*` as static assets, except for `/` and `/api/*`, which are rewritten to the function (see `vercel.json`).

## Conclusion

**Brainwave** revolutionizes the way users capture and organize their ideas by providing a seamless speech recognition and summarization tool. Its real-time processing capabilities, combined with multilingual support and sophisticated text enhancement, make it an invaluable asset for anyone looking to efficiently manage their thoughts and ideas. Whether you're brainstorming, taking notes, or organizing project ideas, Brainwave ensures that your spoken words are transformed into clear, organized, and actionable summaries.

For any questions, contributions, or feedback, feel free to [open an issue](https://github.com/grapeot/brainwave/issues) or submit a pull request on the repository.

---

*Empower Your Ideas with Brainwave!*