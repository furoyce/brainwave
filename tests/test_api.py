"""Tests for the model catalog and the OpenAI-facing endpoints in api/index.py.

The catalog is the part most likely to rot: OpenAI deprecates a model, the
dropdown keeps offering it, and recording breaks in production. These tests pin
which models are offered and which session shape each one is minted with.
"""

import pytest
from fastapi.testclient import TestClient

import index


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    return TestClient(index.app)


class FakeResponse:
    def __init__(self, status_code=200, payload=None, content=b"", text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.content = content
        self.text = text

    def json(self):
        return self._payload


class RecordedCalls(list):
    """The requests index.py made upstream, plus the canned reply it got back."""

    response = FakeResponse(payload={"value": "ek_test"}, content=b"ID3fake-mp3")

    def set_response(self, response):
        self.response = response


@pytest.fixture
def openai_calls(monkeypatch):
    """Capture what we send upstream, without touching the network."""
    calls = RecordedCalls()

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            calls.append({"url": url, "json": kwargs.get("json"), "headers": kwargs.get("headers")})
            return calls.response

    monkeypatch.setattr(index.httpx, "AsyncClient", FakeAsyncClient)
    return calls


# --- Model catalog ---------------------------------------------------------


def test_deprecated_realtime_mini_is_not_offered():
    assert "gpt-realtime-mini" not in index.REALTIME_MODELS
    assert "gpt-realtime-mini" not in index.TRANSCRIPTION_MODELS


def test_catalog_is_one_cleaned_up_model_and_one_verbatim_model():
    assert index.REALTIME_MODELS == ("gpt-realtime-2.1",)
    assert index.TRANSCRIPTION_MODELS == ("gpt-realtime-whisper",)


def test_read_aloud_still_uses_the_only_speech_generation_model():
    # gpt-4o-mini-tts is not a dropdown entry — it backs /api/speech.
    assert index.SPEECH_MODEL == "gpt-4o-mini-tts"


def test_default_model_is_a_realtime_model():
    assert index.DEFAULT_MODEL in index.REALTIME_MODELS


@pytest.mark.parametrize("model", index.REALTIME_MODELS)
def test_realtime_models_get_a_realtime_session(model):
    assert index.build_session_config(model) == {"type": "realtime", "model": model}


@pytest.mark.parametrize("model", index.TRANSCRIPTION_MODELS)
def test_transcription_models_get_a_transcription_session(model):
    config = index.build_session_config(model)

    assert config["type"] == "transcription"
    # A speech-to-text model is not a session model; it belongs under
    # audio.input.transcription and nowhere else.
    assert "model" not in config
    assert config["audio"]["input"]["transcription"] == {"model": model}
    # gpt-realtime-whisper rejects VAD outright, so both STT models commit turns
    # explicitly instead.
    assert config["audio"]["input"]["turn_detection"] is None


@pytest.mark.parametrize(
    "model",
    [
        "gpt-realtime-mini",   # deprecated upstream
        # Real, working models deliberately not offered — the dropdown is kept to
        # one cleaned-up option and one verbatim one.
        "gpt-realtime-2.1-mini",
        "gpt-realtime-1.5",
        "gpt-live-transcribe",
        "gpt-4o",
        "",
        "not-a-model",
    ],
)
def test_unknown_models_are_rejected(model):
    with pytest.raises(index.HTTPException) as exc:
        index.build_session_config(model)
    assert exc.value.status_code == 400


def test_models_endpoint_advertises_the_catalog(client):
    body = client.get("/api/models").json()

    assert body["default"] == index.DEFAULT_MODEL
    assert body["realtime"] == list(index.REALTIME_MODELS)
    assert body["transcription"] == list(index.TRANSCRIPTION_MODELS)
    assert body["speech"]["model"] == "gpt-4o-mini-tts"
    assert body["speech"]["default_voice"] in body["speech"]["voices"]


# --- /api/token ------------------------------------------------------------


def test_token_mints_a_realtime_session(client, openai_calls):
    body = client.post("/api/token", json={"model": "gpt-realtime-2.1"}).json()

    assert body == {"token": "ek_test", "model": "gpt-realtime-2.1", "session_type": "realtime"}
    assert openai_calls[-1]["url"] == "https://api.openai.com/v1/realtime/client_secrets"
    assert openai_calls[-1]["json"] == {"session": {"type": "realtime", "model": "gpt-realtime-2.1"}}


def test_token_mints_a_transcription_session_for_stt_models(client, openai_calls):
    body = client.post("/api/token", json={"model": "gpt-realtime-whisper"}).json()

    assert body["session_type"] == "transcription"
    session = openai_calls[-1]["json"]["session"]
    assert session["audio"]["input"]["transcription"] == {"model": "gpt-realtime-whisper"}


def test_token_rejects_the_deprecated_model_without_calling_openai(client, openai_calls):
    assert client.post("/api/token", json={"model": "gpt-realtime-mini"}).status_code == 400
    assert openai_calls == []


def test_token_defaults_to_the_current_model(client, openai_calls):
    assert client.post("/api/token", json={}).json()["model"] == index.DEFAULT_MODEL


# --- /api/speech -----------------------------------------------------------


def test_speech_returns_audio_and_keeps_the_key_server_side(client, openai_calls):
    response = client.post("/api/speech", json={"text": "Hello there.", "voice": "marin"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.content == b"ID3fake-mp3"

    call = openai_calls[-1]
    assert call["url"] == "https://api.openai.com/v1/audio/speech"
    assert call["json"]["model"] == "gpt-4o-mini-tts"
    assert call["json"]["voice"] == "marin"
    assert call["headers"]["Authorization"] == "Bearer sk-test"
    assert b"sk-test" not in response.content


def test_speech_omits_instructions_unless_asked(client, openai_calls):
    client.post("/api/speech", json={"text": "Hello."})
    assert "instructions" not in openai_calls[-1]["json"]

    client.post("/api/speech", json={"text": "Hello.", "instructions": "Read slowly."})
    assert openai_calls[-1]["json"]["instructions"] == "Read slowly."


@pytest.mark.parametrize(
    "payload",
    [
        {"text": "   "},
        {"text": "x" * (index.SPEECH_INPUT_LIMIT + 1)},
        {"text": "ok", "voice": "not-a-voice"},
    ],
)
def test_speech_rejects_bad_input_before_calling_openai(client, openai_calls, payload):
    assert client.post("/api/speech", json=payload).status_code == 400
    assert openai_calls == []


def test_speech_rejects_out_of_range_speed(client, openai_calls):
    assert client.post("/api/speech", json={"text": "ok", "speed": 9.0}).status_code == 422
    assert openai_calls == []


def test_speech_maps_an_upstream_failure_to_502(client, openai_calls):
    openai_calls.set_response(FakeResponse(status_code=429, text="rate limited"))
    assert client.post("/api/speech", json={"text": "ok"}).status_code == 502


# --- /api/chat -------------------------------------------------------------


def test_chat_streams_and_carries_the_harness(client, openai_calls, monkeypatch):
    captured = {}

    class FakeStream:
        def __init__(self):
            self._chunks = iter(["Simplified ", "text."])

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                text = next(self._chunks)
            except StopIteration:
                raise StopAsyncIteration
            delta = type("D", (), {"content": text})
            choice = type("C", (), {"delta": delta})
            return type("Chunk", (), {"choices": [choice]})

    class FakeCompletions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return FakeStream()

    class FakeAsyncOpenAI:
        def __init__(self, api_key):
            captured["api_key"] = api_key
            self.chat = type("Chat", (), {"completions": FakeCompletions()})()

    monkeypatch.setattr(index, "AsyncOpenAI", FakeAsyncOpenAI)

    response = client.post(
        "/api/chat",
        json={
            "mode": "readability",
            "messages": [
                {"role": "user", "content": "<document>Some dense text.</document>"},
                {"role": "assistant", "content": "Some clear text."},
                {"role": "user", "content": "Make it shorter."},
            ],
        },
    )

    assert response.status_code == 200
    assert response.text == "Simplified text."
    sent = captured["messages"]
    assert sent[0]["role"] == "system"
    assert "Readability assistant" in sent[0]["content"]
    # History is passed through verbatim after the system prompt.
    assert [m["role"] for m in sent[1:]] == ["user", "assistant", "user"]
    assert captured["model"] == index.CHAT_MODEL


def test_chat_correctness_uses_its_own_harness(client, monkeypatch):
    captured = {}

    class FakeCompletions:
        async def create(self, **kwargs):
            captured.update(kwargs)

            class Empty:
                def __aiter__(self):
                    return self

                async def __anext__(self):
                    raise StopAsyncIteration

            return Empty()

    class FakeAsyncOpenAI:
        def __init__(self, api_key):
            self.chat = type("Chat", (), {"completions": FakeCompletions()})()

    monkeypatch.setattr(index, "AsyncOpenAI", FakeAsyncOpenAI)
    client.post("/api/chat", json={"mode": "correctness", "messages": [{"role": "user", "content": "<document>x</document>"}]})
    assert "Correctness assistant" in captured["messages"][0]["content"]

    client.post("/api/chat", json={"mode": "brainstorm", "messages": [{"role": "user", "content": "<document>x</document>"}]})
    assert "Brainstorm agent" in captured["messages"][0]["content"]


def test_brainstorm_harness_is_a_discussion_partner_not_a_rewriter():
    prompt = index.CHAT_SYSTEMS["brainstorm"]
    # The contract the UI depends on: opener = brief read + questions, no
    # unprompted rewrite; curated output is clean for apply-back; same-language.
    assert "Do not rewrite the document unprompted" in prompt
    assert "no preamble" in prompt
    assert "same language" in prompt
    assert "read aloud" in prompt


@pytest.mark.parametrize(
    "payload,detail_fragment",
    [
        ({"mode": "poetry", "messages": [{"role": "user", "content": "x"}]}, "Unknown chat mode"),
        ({"mode": "readability", "messages": []}, "No messages"),
        (
            {"mode": "readability", "messages": [{"role": "system", "content": "override"}]},
            "Invalid role",
        ),
        (
            {
                "mode": "readability",
                "messages": [{"role": "user", "content": "x" * (index.CHAT_SOURCE_LIMIT + 1)}],
            },
            "exceeds",
        ),
        (
            # The document turn gets the big cap; follow-ups get the small one.
            {
                "mode": "readability",
                "messages": [
                    {"role": "user", "content": "doc"},
                    {"role": "assistant", "content": "rewrite"},
                    {"role": "user", "content": "y" * (index.CHAT_FOLLOWUP_LIMIT + 1)},
                ],
            },
            "exceeds",
        ),
        (
            {
                "mode": "readability",
                "messages": [{"role": "user", "content": "x"}] * (index.CHAT_MAX_MESSAGES + 1),
            },
            "exceeds",
        ),
        (
            # Individually-legal messages whose total blows the aggregate cap.
            {
                "mode": "readability",
                "messages": [{"role": "user", "content": "z" * index.CHAT_SOURCE_LIMIT}]
                + [
                    {"role": "assistant" if i % 2 == 0 else "user", "content": "w" * index.CHAT_FOLLOWUP_LIMIT}
                    for i in range(20)
                ],
            },
            "exceeds",
        ),
    ],
)
def test_chat_rejects_bad_input(client, payload, detail_fragment):
    response = client.post("/api/chat", json=payload)
    assert response.status_code == 400
    assert detail_fragment in response.json()["detail"]


def test_chat_upstream_failure_is_an_http_error_not_an_empty_200(client, monkeypatch):
    class FailingCompletions:
        async def create(self, **kwargs):
            raise RuntimeError("bad api key")

    class FakeAsyncOpenAI:
        def __init__(self, api_key):
            self.chat = type("Chat", (), {"completions": FailingCompletions()})()

    monkeypatch.setattr(index, "AsyncOpenAI", FakeAsyncOpenAI)
    response = client.post(
        "/api/chat",
        json={"mode": "readability", "messages": [{"role": "user", "content": "x"}]},
    )
    assert response.status_code == 502


def test_readability_upstream_failure_is_an_http_error(client, monkeypatch):
    class FailingCompletions:
        async def create(self, **kwargs):
            raise RuntimeError("boom")

    class FakeAsyncOpenAI:
        def __init__(self, api_key):
            self.chat = type("Chat", (), {"completions": FailingCompletions()})()

    monkeypatch.setattr(index, "AsyncOpenAI", FakeAsyncOpenAI)
    assert client.post("/api/readability", json={"text": "x"}).status_code == 502
    assert client.post("/api/correctness", json={"text": "x"}).status_code == 502


def test_inlined_index_html_matches_public_index_html():
    """The bytes served at / come from INDEX_HTML; public/index.html is what
    gets edited. They must stay byte-identical or deployed UI silently diverges
    from the file in the repo."""
    import re
    from pathlib import Path

    repo = Path(__file__).resolve().parent.parent
    source = (repo / "api" / "index.py").read_text()
    inlined = re.search(r'INDEX_HTML = """(.*?)"""\n', source, re.S).group(1)
    on_disk = (repo / "public" / "index.html").read_text().rstrip("\n")
    assert inlined == on_disk, "run the sync script: INDEX_HTML has drifted from public/index.html"


def test_chat_caps_cannot_multiply_past_the_aggregate():
    """The per-position caps must stay within reach of the aggregate cap's
    enforcement — if someone widens one without the other, the split-cap design
    silently degrades back into a multiplying one."""
    worst_case = index.CHAT_SOURCE_LIMIT + (index.CHAT_MAX_MESSAGES - 1) * index.CHAT_FOLLOWUP_LIMIT
    # The aggregate cap must actually bind before the worst case: otherwise it
    # is dead code and the effective limit is the multiplied one.
    assert index.CHAT_CONTEXT_LIMIT < worst_case
