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


@pytest.mark.parametrize("model", ["gpt-realtime-mini", "gpt-4o", "", "not-a-model"])
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
