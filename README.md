# Brainwave: Real-Time Speech Recognition and Summarization Tool

## Table of Contents

1. [Introduction](#introduction)
2. [Deployment](#deployment)
3. [Code Structure & Architecture](#code-structure--architecture)
4. [Tests](#tests)

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

- `OPENAI_API_KEY` — used to mint ephemeral session tokens for the OpenAI Realtime API and to back the Readability / Correctness / Read aloud endpoints.
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

- `POST /api/token` — mints an ephemeral OpenAI Realtime session token that the browser uses to open a direct WebRTC connection to the OpenAI API. The requested model is validated against the catalog below and determines which session shape is minted (`build_session_config`).
- `GET /api/models` — the model catalog the frontend reads: realtime models, transcription models, and the speech-generation model with its voices.
- `POST /api/readability` and `POST /api/correctness` — streaming text-processing endpoints.
- `POST /api/speech` — proxies OpenAI's speech-generation endpoint (`gpt-4o-mini-tts`) so the Editor can read text aloud without exposing the API key. Input is capped at 4096 characters per request, matching the upstream limit; the browser splits longer documents.
- `POST /api/transcripts` — persists completed transcripts to Postgres.
- `GET /` — serves the inlined `INDEX_HTML`, regenerated from `public/index.html` rather than hand-edited.

The function imports `openai`, `httpx`, and `psycopg2` directly; it does not depend on any other modules in the repo.

### Frontend — `public/`

- `public/index.html` — top bar with Transcribe / Editor mode toggle and model selector; main content area; bottom controls (record / clear / copy).
- `public/main.js` — WebRTC connection to OpenAI Realtime, transcript stream handling for both session types, Editor mode with live markdown preview, the Readability / Correctness clients, and the Read aloud (text-to-speech) client.
- `public/style.css` — styles for both modes.

`public/index.html` is the file to edit; the bytes actually served at `/` come from the `INDEX_HTML` string in `api/index.py`. They are kept byte-identical, so after editing the HTML, copy it across rather than editing both by hand.

Vercel serves `public/*` as static assets, except for `/` and `/api/*`, which are rewritten to the function (see `vercel.json`).

### Model selection

The dropdown offers two families, and they behave differently enough that the grouping is part of the UI:

| Group | Model | What you get |
| --- | --- | --- |
| Transcribe & clean up | `gpt-realtime-2.1` (default) | Speech-to-speech model held to text output. Applies `TRANSCRIPTION_PROMPT`: punctuation, casing, filler removal, paragraphing — never translation. |
| Verbatim speech-to-text | `gpt-realtime-whisper` | Streaming STT with a tunable latency/accuracy `delay`. Verbatim — no cleanup, no filler removal. Billed per minute of audio. |

Two entries, deliberately. OpenAI also offers `gpt-realtime-2.1-mini` and `gpt-realtime-1.5` in the realtime family, and `gpt-live-transcribe` (their recommended starting model) alongside `gpt-realtime-whisper` for streaming STT. All of them work; the dropdown is kept to one cleaned-up option and one verbatim option rather than exposing the full catalog. Adding one back is a line in `REALTIME_MODELS` / `TRANSCRIPTION_MODELS` in `api/index.py` plus an `<option>` in `public/index.html` — `/api/token` rejects anything not in those tuples, so both ends have to agree.

The two families need different session shapes, which is why `/api/token` builds the request body rather than passing a model string straight through:

- **Realtime models** run as `type: "realtime"` sessions and stream `response.output_text.delta` events.
- **Speech-to-text models** are not valid session models at all. They run as `type: "transcription"` sessions and stream `conversation.item.input_audio_transcription.delta` / `.completed` events instead. `gpt-realtime-whisper` additionally rejects voice activity detection, so the transcription session runs with `turn_detection: null` and commits the audio buffer when the user stops recording.

Because a transcription session emits no `response.done`, the frontend finalizes it when the transcription events go quiet rather than on a single terminating event.

### Read aloud

The Editor toolbar can read the document back using `gpt-4o-mini-tts`, OpenAI's speech-generation model. Markdown is flattened first so the voice doesn't pronounce syntax, and the text is split on paragraph and sentence boundaries to stay under the endpoint's 4096-character limit — the opening chunk is kept short so audio starts quickly, and each chunk is prefetched while the previous one plays.

Thirteen voices are available (`marin` is the default; OpenAI recommends `marin` or `cedar`), and the choice persists in `localStorage`. An "AI voice" badge is shown during playback: OpenAI's usage policies require disclosing that the voice is synthetic.

---

## Tests

```bash
pip install -r requirements.txt
pytest tests/
```

`tests/test_api.py` pins the model catalog and the session shape each model is minted with — the drift that breaks recording in production is a model being deprecated upstream while the dropdown keeps offering it.

---

## Conclusion

**Brainwave** revolutionizes the way users capture and organize their ideas by providing a seamless speech recognition and summarization tool. Its real-time processing capabilities, combined with multilingual support and sophisticated text enhancement, make it an invaluable asset for anyone looking to efficiently manage their thoughts and ideas. Whether you're brainstorming, taking notes, or organizing project ideas, Brainwave ensures that your spoken words are transformed into clear, organized, and actionable summaries.

For any questions, contributions, or feedback, feel free to [open an issue](https://github.com/grapeot/brainwave/issues) or submit a pull request on the repository.

---

*Empower Your Ideas with Brainwave!*