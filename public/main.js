// ============================================================
// Brainwave — WebRTC frontend for Vercel deployment
// Connects directly to OpenAI Realtime API via ephemeral tokens
// ============================================================

// --- Global state ---
let pc = null;           // RTCPeerConnection
let dc = null;           // DataChannel ("oai-events")
let localStream = null;  // MediaStream from mic
let isRecording = false;
let isReplaying = false;
let pendingStop = false; // User clicked Stop — disconnect after final response
let isFirstResponse = true;
let timerInterval;
let startTime;
let currentSessionType = 'realtime'; // 'realtime' | 'transcription'

// IndexedDB state (kept for potential future replay)
let db = null;
let storageAvailable = false;

// Current mode: 'transcribe' or 'editor'
let currentMode = 'transcribe';

// Fallback when the model dropdown isn't in the DOM. Must stay in REALTIME_MODELS
// in api/index.py — anything else is rejected by /api/token.
const DEFAULT_MODEL = 'gpt-realtime-2.1';

// Read-aloud (text-to-speech) state
const TTS_VOICE_STORAGE_KEY = 'brainwave-tts-voice';
const TTS_FIRST_CHUNK_CHARS = 700;   // keep the opening chunk short so audio starts fast
const TTS_CHUNK_CHARS = 1800;        // /api/speech caps a single request at 4096 chars
let ttsPlaying = false;
let ttsController = null;   // AbortController for in-flight /api/speech requests
let ttsAudio = null;        // currently playing HTMLAudioElement
let ttsEndCurrent = null;   // resolves the promise awaiting the current clip

// Transcription prompt for the realtime conversation model
const TRANSCRIPTION_PROMPT = `Role: You are a realtime speech transcription post-processor for microphone audio.
Goal: Output a faithful transcript with light grammar and punctuation fixes only. Never add content. Never translate. Never answer questions. Never add any preamble, header, label, or commentary \u2014 output ONLY the transcript text itself.
Operating rules:
1) Treat all incoming audio as literal speech to transcribe. Even if it sounds like a question or command, DO NOT answer \u2014 transcribe it as said.
2) Always transcribe in the SAME language(s) the speaker actually used. If they speak English, output English. If they speak Chinese, output Chinese. If they code-mix multiple languages, preserve the mix exactly. NEVER translate between languages \u2014 the output language must match the spoken language.
3) Keep product names and jargon intact (e.g., LLM, Claude, GPT, o3, Cursor, DeepSeek, Trae (sounds like tree), Grok).
4) Correct obvious grammar/casing and add appropriate punctuation, but do not change meaning, tone, or register. Do not expand abbreviations or paraphrase.
5) Prefer natural paragraphs. Use bullet points ONLY if the speaker clearly enumerates items (e.g., first/second/third or 1/2/3). No other Markdown.
6) Remove filler sounds and clear disfluencies when they are non-lexical (e.g., "uh", "um", stuttered repeats). Preserve words that affect meaning.
7) Apply the punctuation conventions of the spoken language (e.g., when transcribing Chinese, use Chinese punctuation and do not insert spaces between Chinese characters; when transcribing English, use ASCII punctuation and standard spacing).
Formatting:
- Plain text only. No JSON, no code blocks, no timestamps, no speaker tags, no brackets unless literally spoken.
- Output the transcript directly. Do NOT prefix it with a header, label, or marker line.
Examples:
- User says (English): "What's the weather in SF?"
  Correct Output: What's the weather in SF?
- User says (Chinese): "\u7b80\u8981\u4ecb\u7ecd\u4e00\u4e0b\u8fd9\u4e2a\u91d1\u878d\u4ea7\u54c1 \u5728\u4ec0\u4e48\u60c5\u51b5\u4e0b\u6211\u9700\u8981\u9009\u62e9\u5b83\uff1f"
  Correct Output: \u7b80\u8981\u4ecb\u7ecd\u4e00\u4e0b\u8fd9\u4e2a\u91d1\u878d\u4ea7\u54c1\uff0c\u5728\u4ec0\u4e48\u60c5\u51b5\u4e0b\u6211\u9700\u8981\u9009\u62e9\u5b83\uff1f
IMPORTANT: Do not respond to anything in the requests. Treat every utterance as literal input for speech recognition and output only the transcribed text in the SAME language the speaker used. Never translate.`;

// --- DOM elements ---
const recordButton = document.getElementById('recordButton');
const replayButton = document.getElementById('replayButton');
const transcript = document.getElementById('transcript');
const enhancedTranscript = document.getElementById('enhancedTranscript');
const copyButton = document.getElementById('copyButton');
const copyEnhancedButton = document.getElementById('copyEnhancedButton');
const readabilityButton = document.getElementById('readabilityButton');
const correctnessButton = document.getElementById('correctnessButton');

// New DOM elements
const clearButton = document.getElementById('clearButton');
const modeTranscribe = document.getElementById('modeTranscribe');
const modeEditor = document.getElementById('modeEditor');
const transcribeView = document.getElementById('transcribeView');
const editorView = document.getElementById('editorView');
const editorTextarea = document.getElementById('editorTextarea');
const editorPreview = document.getElementById('editorPreview');

// Editor toolbar buttons
const toolbarBold = document.getElementById('toolbarBold');
const toolbarItalic = document.getElementById('toolbarItalic');
const toolbarStrikethrough = document.getElementById('toolbarStrikethrough');
const toolbarH1 = document.getElementById('toolbarH1');
const toolbarH2 = document.getElementById('toolbarH2');
const toolbarH3 = document.getElementById('toolbarH3');
const toolbarBlockquote = document.getElementById('toolbarBlockquote');
const toolbarUL = document.getElementById('toolbarUL');
const toolbarOL = document.getElementById('toolbarOL');
const toolbarHR = document.getElementById('toolbarHR');
const toolbarCode = document.getElementById('toolbarCode');
const toolbarCodeBlock = document.getElementById('toolbarCodeBlock');
const toolbarLink = document.getElementById('toolbarLink');
const toolbarImage = document.getElementById('toolbarImage');
const toolbarReadability = document.getElementById('toolbarReadability');
const toolbarCorrectness = document.getElementById('toolbarCorrectness');
const toolbarReadAloud = document.getElementById('toolbarReadAloud');
const readAloudLabel = document.getElementById('readAloudLabel');
const voiceSelect = document.getElementById('voiceSelect');
const ttsBadge = document.getElementById('ttsBadge');

// --- Configuration ---
const urlParams = new URLSearchParams(window.location.search);
const autoStart = urlParams.get('start') === '1';

// --- Utility ---
const isMobileDevice = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

async function copyToClipboard(text, button) {
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        showCopyToast('Copied!');
    } catch (err) {
        console.error('Clipboard copy failed:', err);
    }
}

function showCopiedFeedback(button, message) {
    // Legacy — now uses toast
    showCopyToast(message);
}

function showCopyToast(message) {
    let toast = document.querySelector('.copy-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'copy-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1500);
}

// --- Timer ---
function startTimer() {
    clearInterval(timerInterval);
    const timerEl = document.getElementById('timer');
    timerEl.textContent = '00:00';
    timerEl.classList.add('active');
    startTime = Date.now();
    timerInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        timerEl.textContent =
            `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
    const timerEl = document.getElementById('timer');
    timerEl.classList.remove('active');
}

// --- Connection status ---
function updateConnectionStatus(status) {
    const statusPill = document.getElementById('connectionStatus');
    const statusDot = statusPill.querySelector('.status-dot');
    const statusText = statusPill.querySelector('.status-text');

    statusPill.classList.remove('connected', 'connecting', 'idle', 'recording');

    switch (status) {
        case 'connected':
            statusPill.classList.add('connected');
            statusText.textContent = 'Connected';
            break;
        case 'connecting':
            statusPill.classList.add('connecting');
            statusText.textContent = 'Connecting...';
            break;
        case 'recording':
            statusPill.classList.add('recording');
            statusText.textContent = 'Recording';
            break;
        case 'idle':
            statusPill.classList.add('idle');
            statusText.textContent = 'Ready';
            break;
        default:
            statusText.textContent = 'Ready';
    }
}

// --- IndexedDB (kept for future replay support) ---
async function initIndexedDB() {
    return new Promise((resolve) => {
        try {
            const request = indexedDB.open('brainwave-replay', 1);
            request.onerror = () => {
                console.warn('IndexedDB not available');
                storageAvailable = false;
                resolve(false);
            };
            request.onsuccess = () => {
                db = request.result;
                if (!db.objectStoreNames.contains('sessions') || !db.objectStoreNames.contains('chunks')) {
                    db.close();
                    storageAvailable = false;
                    resolve(false);
                    return;
                }
                storageAvailable = true;
                resolve(true);
            };
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                if (!database.objectStoreNames.contains('sessions')) {
                    const s = database.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('status', 'status', { unique: false });
                    s.createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!database.objectStoreNames.contains('chunks')) {
                    const c = database.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
                    c.createIndex('sessionId', 'sessionId', { unique: false });
                    c.createIndex('seq', 'seq', { unique: false });
                }
            };
        } catch {
            storageAvailable = false;
            resolve(false);
        }
    });
}

// ============================================================
// WebRTC connection to OpenAI Realtime API
// ============================================================

async function getSession(model) {
    const response = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to get session token');
    }
    // { token, model, session_type }
    return await response.json();
}

// A realtime session runs the audio through a speech-to-speech model that we
// hold to text-only output, so the transcript arrives as response deltas shaped
// by TRANSCRIPTION_PROMPT. A transcription session runs a speech-to-text model
// instead: no model response, just verbatim input-audio transcription events,
// billed per minute of audio. The server picks the shape (build_session_config
// in api/index.py) and tells us which one it minted.
function realtimeSessionUpdate() {
    return {
        type: 'session.update',
        session: {
            type: 'realtime',
            output_modalities: ['text'],
            instructions: TRANSCRIPTION_PROMPT,
            audio: {
                input: { turn_detection: null },
            },
        },
    };
}

function transcriptionSessionUpdate(model) {
    // gpt-realtime-whisper doesn't support VAD at all, so a transcription
    // session runs with turn detection off and commits the buffer on Stop.
    return {
        type: 'session.update',
        session: {
            type: 'transcription',
            audio: {
                input: {
                    transcription: { model },
                    turn_detection: null,
                },
            },
        },
    };
}

async function connectToOpenAI(model) {
    const session = await getSession(model);
    const token = session.token;
    currentSessionType = session.session_type || 'realtime';
    resetTranscriptionSegments();

    // Create peer connection
    pc = new RTCPeerConnection();

    // Audio output (hidden — we only want text, but WebRTC requires a track)
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    // Mic input
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    });
    pc.addTrack(localStream.getTracks()[0]);

    // Data channel for sending/receiving events
    dc = pc.createDataChannel('oai-events');

    dc.onopen = () => {
        console.log(`Data channel open — configuring ${currentSessionType} session`);
        dc.send(JSON.stringify(
            currentSessionType === 'transcription'
                ? transcriptionSessionUpdate(model)
                : realtimeSessionUpdate()
        ));
        updateConnectionStatus('connected');
    };

    dc.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleRealtimeEvent(data);
        } catch (err) {
            console.error('Failed to parse data channel message:', err);
        }
    };

    dc.onerror = (err) => {
        console.error('Data channel error:', err);
    };

    dc.onclose = () => {
        console.log('Data channel closed');
    };

    pc.oniceconnectionstatechange = () => {
        console.log('ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            handleConnectionLost();
        }
    };

    // SDP exchange
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/sdp',
        },
    });

    if (!sdpResponse.ok) {
        throw new Error(`SDP exchange failed: ${sdpResponse.status}`);
    }

    await pc.setRemoteDescription({
        type: 'answer',
        sdp: await sdpResponse.text(),
    });

    console.log('WebRTC connection established');
}

function disconnectWebRTC() {
    if (dc) { try { dc.close(); } catch {} dc = null; }
    if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
    }
    if (pc) { try { pc.close(); } catch {} pc = null; }
}

function handleConnectionLost() {
    console.warn('WebRTC connection lost');
    clearTranscriptionTimers();
    pendingStop = false;
    isRecording = false;
    recordButton.classList.remove('recording');
    updateConnectionStatus('idle');
    stopTimer();
    disconnectWebRTC();
}

// ============================================================
// Realtime event handling
// ============================================================

function handleRealtimeEvent(data) {
    const type = data.type;

    switch (type) {
        case 'session.created':
        case 'session.updated':
            console.log(`${type}`, data);
            break;

        case 'response.output_text.delta':
        case 'response.text.delta':
            handleTextDelta(data);
            break;

        case 'response.created':
            handleResponseCreated();
            break;

        case 'conversation.item.input_audio_transcription.delta':
            handleTranscriptionDelta(data);
            break;

        case 'conversation.item.input_audio_transcription.completed':
            handleTranscriptionCompleted(data);
            break;

        case 'conversation.item.input_audio_transcription.failed':
            handleTranscriptionFailed(data);
            break;

        case 'response.done':
            handleResponseDone();
            break;

        case 'error':
            handleError(data);
            break;

        case 'input_audio_buffer.committed':
        case 'input_audio_buffer.speech_started':
        case 'input_audio_buffer.speech_stopped':
        case 'input_audio_buffer.cleared':
        case 'rate_limits.updated':
        case 'response.output_item.added':
        case 'response.output_item.done':
        case 'response.content_part.added':
        case 'response.content_part.done':
        case 'response.output_text.done':
        case 'response.text.done':
        case 'conversation.item.created':
        case 'ping':
            // Informational — log at debug level
            console.debug(`${type}`);
            break;

        default:
            console.debug(`Unhandled: ${type}`);
    }
}

function handleTextDelta(data) {
    const delta = data.delta || '';
    if (!delta) return;
    appendToTranscript(delta);
}

function appendToTranscript(text) {
    transcript.value += text;
    transcript.scrollTop = transcript.scrollHeight;

    // Also sync to editor textarea if in editor mode
    if (currentMode === 'editor') {
        editorTextarea.value = transcript.value;
        updateEditorPreview();
    }
}

// ============================================================
// Transcription sessions (speech-to-text models)
// ============================================================

// Deltas stream in per conversation item and a later delta can revise earlier
// text, so segments are kept addressable by item_id and the transcript is
// re-rendered from them rather than appended to blindly.
let transcriptionSegments = [];
let transcriptionIndex = new Map();

function resetTranscriptionSegments() {
    transcriptionSegments = [];
    transcriptionIndex = new Map();
}

function transcriptionSegment(itemId) {
    const key = itemId || '_';
    if (!transcriptionIndex.has(key)) {
        transcriptionIndex.set(key, transcriptionSegments.length);
        transcriptionSegments.push({ itemId: key, text: '' });
    }
    return transcriptionSegments[transcriptionIndex.get(key)];
}

function renderTranscriptionSegments() {
    const text = transcriptionSegments
        .map((segment) => segment.text.trim())
        .filter(Boolean)
        .join('\n\n');

    transcript.value = text;
    transcript.scrollTop = transcript.scrollHeight;

    if (currentMode === 'editor') {
        editorTextarea.value = text;
        updateEditorPreview();
    }
}

function handleTranscriptionDelta(data) {
    const delta = data.delta || '';
    if (delta) {
        transcriptionSegment(data.item_id).text += delta;
        renderTranscriptionSegments();
    }
    noteTranscriptionActivity();
}

function handleTranscriptionCompleted(data) {
    // The completion event carries the authoritative transcript for the item;
    // it supersedes whatever the deltas accumulated.
    if (typeof data.transcript === 'string') {
        transcriptionSegment(data.item_id).text = data.transcript;
        renderTranscriptionSegments();
    }
    noteTranscriptionActivity();
}

function handleTranscriptionFailed(data) {
    console.error('Transcription failed:', data.error?.message || data);
    noteTranscriptionActivity();
}

// A transcription session never emits response.done, so there's no single event
// that means "the transcript is complete". After the final commit, wait for the
// transcription events to go quiet — with a hard ceiling in case none arrive.
const TRANSCRIPTION_QUIET_MS = 1200;
const TRANSCRIPTION_MAX_WAIT_MS = 6000;
let transcriptionQuietTimer = null;
let transcriptionDeadlineTimer = null;

function clearTranscriptionTimers() {
    clearTimeout(transcriptionQuietTimer);
    clearTimeout(transcriptionDeadlineTimer);
    transcriptionQuietTimer = null;
    transcriptionDeadlineTimer = null;
}

function noteTranscriptionActivity() {
    if (!pendingStop) return;
    clearTimeout(transcriptionQuietTimer);
    transcriptionQuietTimer = setTimeout(finalizeTranscriptionSession, TRANSCRIPTION_QUIET_MS);
}

function waitForFinalTranscription() {
    clearTranscriptionTimers();
    transcriptionQuietTimer = setTimeout(finalizeTranscriptionSession, TRANSCRIPTION_QUIET_MS);
    transcriptionDeadlineTimer = setTimeout(finalizeTranscriptionSession, TRANSCRIPTION_MAX_WAIT_MS);
}

function finalizeTranscriptionSession() {
    if (!pendingStop) return;
    clearTranscriptionTimers();
    finishRecordingSession();
}

function handleResponseCreated() {
    // The server may emit response.created multiple times during a single
    // recording session — the realtime model wraps up its current generation
    // and starts a new one even when the user hasn't pressed Stop. Only the
    // first response (when the transcript is empty) starts fresh; subsequent
    // mid-stream responses append to the existing transcript with a newline
    // separator so segments stay readable.
    if (transcript.value.length > 0 && !transcript.value.endsWith('\n')) {
        appendToTranscript('\n');
    }
}

function handleResponseDone() {
    // If the user hasn't clicked Stop, this is a mid-stream response.done
    // from the server (the model finished its current generation but the
    // user is still recording). Do NOT tear down the session — that was the
    // bug that capped sessions at ~30s. Keep the connection open and wait
    // for either the next response cycle or the user's Stop click.
    if (!pendingStop) {
        console.log('Mid-stream response.done; session stays open');
        return;
    }

    finishRecordingSession();
}

// Shared tail of a recording, whichever session type produced the transcript.
function finishRecordingSession() {
    const durationSeconds = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
    stopTimer();
    updateConnectionStatus('idle');
    copyToClipboard(transcript.value, copyButton);

    // Sync transcript to editor
    if (editorTextarea) {
        editorTextarea.value = transcript.value;
        updateEditorPreview();
    }

    // Auto-save transcript to database
    if (transcript.value.trim()) {
        saveTranscript(transcript.value, durationSeconds);
    }

    disconnectWebRTC();
    pendingStop = false;
}

async function saveTranscript(text, durationSeconds) {
    const modelSelect = document.getElementById('modelSelect');
    const model = modelSelect ? modelSelect.value : DEFAULT_MODEL;
    try {
        const response = await fetch('/api/transcripts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, model, duration_seconds: durationSeconds }),
        });
        if (response.ok) {
            const data = await response.json();
            console.log('Transcript saved, id:', data.id);
        } else {
            console.error('Failed to save transcript:', response.status);
        }
    } catch (err) {
        console.error('Error saving transcript:', err);
    }
}

function handleError(data) {
    const msg = data.error?.message || JSON.stringify(data);
    console.error('OpenAI error:', msg);
    alert('OpenAI error: ' + msg);
    clearTranscriptionTimers();
    pendingStop = false;
    stopTimer();
    updateConnectionStatus('idle');
    isRecording = false;
    recordButton.classList.remove('recording');
    disconnectWebRTC();
}

// ============================================================
// Recording control
// ============================================================

async function startRecording() {
    if (isRecording) return;

    // The mic would pick up the read-aloud voice and transcribe it back.
    if (ttsPlaying) stopReadAloud();

    try {
        transcript.value = '';
        enhancedTranscript.value = '';
        isFirstResponse = true;
        pendingStop = false;
        clearTranscriptionTimers();
        resetTranscriptionSegments();

        const modelSelect = document.getElementById('modelSelect');
        const selectedModel = modelSelect ? modelSelect.value : DEFAULT_MODEL;

        updateConnectionStatus('connecting');
        await connectToOpenAI(selectedModel);

        isRecording = true;
        startTimer();
        recordButton.classList.add('recording');
        updateConnectionStatus('recording');
        if (replayButton) replayButton.disabled = true;
    } catch (error) {
        console.error('Error starting recording:', error);
        alert('Error: ' + error.message);
        updateConnectionStatus('idle');
        disconnectWebRTC();
    }
}

async function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    pendingStop = true;

    recordButton.classList.remove('recording');

    if (dc && dc.readyState === 'open') {
        // Commit any remaining audio to close out the final turn
        dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

        if (currentSessionType === 'transcription') {
            // No response cycle to wait on — finalize once transcripts settle.
            waitForFinalTranscription();
        } else {
            dc.send(JSON.stringify({ type: 'response.create' }));
            // handleResponseDone sees pendingStop=true -> disconnects
        }
    } else {
        pendingStop = false;
        clearTranscriptionTimers();
        stopTimer();
        updateConnectionStatus('idle');
        disconnectWebRTC();
    }
}

// ============================================================
// Readability & Correctness (HTTP endpoints)
// ============================================================

async function runReadability(inputText) {
    if (!inputText || !inputText.trim()) {
        alert('Please enter text to enhance readability.');
        return;
    }

    startTimer();
    try {
        const response = await fetch('/api/readability', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: inputText.trim() }),
        });
        if (!response.ok) throw new Error('Readability enhancement failed');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
            enhancedTranscript.value = fullText;

            // If in editor mode, show result in editor
            if (currentMode === 'editor') {
                editorTextarea.value = fullText;
                updateEditorPreview();
            }
        }
        if (!isMobileDevice()) copyToClipboard(fullText, copyEnhancedButton);
        stopTimer();
    } catch (error) {
        console.error('Error:', error);
        alert('Error enhancing readability');
        stopTimer();
    }
}

async function runCorrectness(inputText) {
    if (!inputText || !inputText.trim()) {
        alert('Please enter text to check for correctness.');
        return;
    }

    startTimer();
    try {
        const response = await fetch('/api/correctness', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: inputText.trim() }),
        });
        if (!response.ok) throw new Error('Correctness check failed');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
            enhancedTranscript.value = fullText;

            // If in editor mode, show result in preview
            if (currentMode === 'editor') {
                editorPreview.innerHTML = renderMarkdown(fullText);
            }
        }
        if (!isMobileDevice()) copyToClipboard(fullText, copyEnhancedButton);
        stopTimer();
    } catch (error) {
        console.error('Error:', error);
        alert('Error checking correctness');
        stopTimer();
    }
}


// ============================================================
// Read aloud (text-to-speech via /api/speech -> gpt-4o-mini-tts)
// ============================================================

function selectedVoice() {
    if (voiceSelect && voiceSelect.value) return voiceSelect.value;
    return 'marin';
}

function initializeVoicePreference() {
    if (!voiceSelect) return;
    let saved = null;
    try {
        saved = localStorage.getItem(TTS_VOICE_STORAGE_KEY);
    } catch {
        // Private browsing / storage disabled — fall back to the markup default.
    }
    if (saved && Array.from(voiceSelect.options).some((o) => o.value === saved)) {
        voiceSelect.value = saved;
    }
    voiceSelect.addEventListener('change', () => {
        try {
            localStorage.setItem(TTS_VOICE_STORAGE_KEY, voiceSelect.value);
        } catch {
            // Ignore — the choice just won't persist across reloads.
        }
        // Switching voices mid-playback would splice two speakers together.
        if (ttsPlaying) stopReadAloud();
    });
}

// A heading is a sentence to the ear, so give it a terminator the voice will
// pause on — matching the script, since a CJK heading read with an ASCII period
// is the kind of thing that makes synthesis stumble.
function endHeadingSentence(heading) {
    if (/[.!?:;,。！？；：，]$/.test(heading)) return heading;
    return heading + (/[\u3040-\u30ff\u4e00-\u9fff]$/.test(heading) ? '。' : '.');
}

// The reader shouldn't pronounce syntax, so flatten markdown to the words a
// human would actually say.
function stripMarkdownForSpeech(text) {
    // Every line-prefix pattern below uses [ \t] rather than \s: \s matches
    // newlines, so a greedy prefix swallows the blank line above a list item or
    // heading and silently welds two paragraphs together.
    return text
        .replace(/```[\s\S]*?```/g, '\n\n')               // fenced code blocks
        .replace(/^[ \t]{0,3}(?:---+|\*\*\*+|___+)[ \t]*$/gm, '')   // horizontal rules
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')         // images -> alt text
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // links -> link text
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, heading) =>
            endHeadingSentence(heading))
        .replace(/^[ \t]{0,3}>[ \t]?/gm, '')               // blockquote markers
        .replace(/^[ \t]*[-*+][ \t]+/gm, '')               // bullet markers
        .replace(/^[ \t]*\d+\.[ \t]+/gm, '')              // ordered list markers
        .replace(/\*\*([^\n]+?)\*\*/g, '$1')                          // **bold**
        .replace(/(^|[\s(])__([^\n]+?)__(?=$|[\s).,!?;:])/g, '$1$2')  // __bold__
        .replace(/\*([^\n*]+?)\*/g, '$1')                             // *italic*
        .replace(/(^|[\s(])_([^\n_]+?)_(?=$|[\s).,!?;:])/g, '$1$2')   // _italic_ (bounded so snake_case survives)
        .replace(/~~(.*?)~~/g, '$1')                                  // strikethrough
        .replace(/`([^`]+)`/g, '$1')                      // inline code
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// /api/speech rejects input over 4096 characters, and a shorter opening chunk
// gets audio playing sooner. Split on paragraph breaks, then sentences, and
// only cut mid-sentence when a single sentence is itself too long.
function chunkTextForSpeech(text) {
    const pieces = [];
    for (const paragraph of text.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (trimmed) pieces.push(trimmed);
    }

    const chunks = [];
    let current = '';
    const limit = () => (chunks.length === 0 ? TTS_FIRST_CHUNK_CHARS : TTS_CHUNK_CHARS);

    const flush = () => {
        if (current.trim()) chunks.push(current.trim());
        current = '';
    };

    const addUnit = (unit) => {
        if (!current) {
            current = unit;
        } else if (current.length + unit.length + 2 <= limit()) {
            current += '\n\n' + unit;
        } else {
            flush();
            current = unit;
        }
    };

    for (const piece of pieces) {
        if (piece.length <= limit()) {
            addUnit(piece);
            continue;
        }
        // Too long for one chunk: break it at sentence boundaries.
        flush();
        for (const sentence of splitSentences(piece)) {
            if (sentence.length <= TTS_CHUNK_CHARS) {
                if (current && current.length + sentence.length + 1 > limit()) flush();
                current = current ? current + ' ' + sentence : sentence;
            } else {
                flush();
                for (let i = 0; i < sentence.length; i += TTS_CHUNK_CHARS) {
                    chunks.push(sentence.slice(i, i + TTS_CHUNK_CHARS));
                }
            }
        }
        flush();
    }
    flush();

    return chunks;
}

function splitSentences(text) {
    // Keep the terminator with its sentence; covers ASCII and CJK punctuation.
    const parts = text.match(/[^.!?。！？]+[.!?。！？]+["'”’]?\s*|[^.!?。！？]+$/g);
    return (parts || [text]).map((part) => part.trim()).filter(Boolean);
}

async function fetchSpeech(text, voice, signal) {
    const response = await fetch('/api/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
        signal,
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `Speech synthesis failed (${response.status})`);
    }
    return await response.blob();
}

function playSpeechBlob(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsAudio = audio;

        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            ttsEndCurrent = null;
            URL.revokeObjectURL(url);
            if (ttsAudio === audio) ttsAudio = null;
            if (err) reject(err); else resolve();
        };

        // stopReadAloud() calls this to unblock the playback loop immediately.
        ttsEndCurrent = () => finish(null);
        audio.onended = () => finish(null);
        audio.onerror = () => finish(new Error('Audio playback failed'));

        audio.play().catch((err) => finish(err));
    });
}

function setReadAloudState(playing) {
    ttsPlaying = playing;
    if (toolbarReadAloud) {
        toolbarReadAloud.classList.toggle('active', playing);
        toolbarReadAloud.title = playing ? 'Stop reading' : 'Read aloud (AI-generated voice)';
    }
    if (readAloudLabel) readAloudLabel.textContent = playing ? 'Stop' : 'Read aloud';
    // OpenAI's usage policies require disclosing that the voice is AI-generated.
    if (ttsBadge) ttsBadge.hidden = !playing;
}

function stopReadAloud() {
    setReadAloudState(false);
    if (ttsController) {
        ttsController.abort();
        ttsController = null;
    }
    if (ttsAudio) {
        ttsAudio.pause();
    }
    if (ttsEndCurrent) {
        const release = ttsEndCurrent;
        ttsEndCurrent = null;
        release();
    }
}

async function startReadAloud(inputText) {
    const plain = stripMarkdownForSpeech(inputText || '');
    if (!plain) {
        alert('Nothing to read aloud yet.');
        return;
    }

    const chunks = chunkTextForSpeech(plain);
    if (!chunks.length) return;

    if (ttsPlaying) stopReadAloud();

    const voice = selectedVoice();
    const controller = new AbortController();
    const signal = controller.signal;
    ttsController = controller;
    setReadAloudState(true);

    try {
        // Fetch the next chunk while the current one plays, so playback only
        // stalls on the very first request.
        let pending = fetchSpeech(chunks[0], voice, signal);
        for (let i = 0; i < chunks.length; i++) {
            const currentRequest = pending;
            pending = i + 1 < chunks.length ? fetchSpeech(chunks[i + 1], voice, signal) : null;
            // A prefetch we never get to await (stopped early) would otherwise
            // surface as an unhandled rejection; the loop still sees the real
            // error when it awaits this promise on the next pass.
            if (pending) pending.catch(() => {});

            const blob = await currentRequest;
            if (!ttsPlaying || signal.aborted) break;
            await playSpeechBlob(blob);
            if (!ttsPlaying || signal.aborted) break;
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Read aloud failed:', err);
            alert('Read aloud failed: ' + err.message);
        }
    } finally {
        // Only tear down if a newer read-aloud hasn't already taken over.
        if (ttsController === controller) {
            if (ttsPlaying) stopReadAloud();
            ttsController = null;
        }
    }
}

function toggleReadAloud() {
    if (ttsPlaying) {
        stopReadAloud();
        return;
    }
    startReadAloud(editorTextarea ? editorTextarea.value : transcript.value);
}

// Wire up legacy hidden buttons for backward compatibility
if (readabilityButton) readabilityButton.onclick = () => runReadability(transcript.value);
if (correctnessButton) correctnessButton.onclick = () => runCorrectness(transcript.value);

// ============================================================
// Mode switching (Transcribe / Editor)
// ============================================================

function switchMode(mode) {
    currentMode = mode;

    // Read aloud lives in the editor; don't leave a voice running behind a
    // view the user has navigated away from.
    if (mode !== 'editor' && ttsPlaying) stopReadAloud();

    if (mode === 'transcribe') {
        modeTranscribe.classList.add('active');
        modeEditor.classList.remove('active');
        transcribeView.classList.remove('view-hidden');
        transcribeView.classList.add('view-active');
        editorView.classList.remove('view-active');
        editorView.classList.add('view-hidden');
    } else {
        modeEditor.classList.add('active');
        modeTranscribe.classList.remove('active');
        editorView.classList.remove('view-hidden');
        editorView.classList.add('view-active');
        transcribeView.classList.remove('view-active');
        transcribeView.classList.add('view-hidden');

        // Sync transcript content to editor
        editorTextarea.value = transcript.value;
        updateEditorPreview();
    }
}

// ============================================================
// Editor: Markdown preview rendering
// ============================================================

function renderMarkdown(text) {
    if (!text || !text.trim()) {
        return '<p class="preview-placeholder">Preview will appear here...</p>';
    }

    let html = escapeHtml(text);

    // Fenced code blocks: ```lang\ncode\n``` (must be processed before inline formatting)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
        return '\n<pre><code>' + code.replace(/\n$/, '') + '</code></pre>\n';
    });
    // Also handle ``` without language
    html = html.replace(/```\n?([\s\S]*?)```/g, function(match, code) {
        return '\n<pre><code>' + code.replace(/\n$/, '') + '</code></pre>\n';
    });

    // Horizontal rule: --- or *** or ___ (on its own line, 3+ chars)
    html = html.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '<hr>');

    // Headings: ### h3, ## h2, # h1 (order matters)
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Images: ![alt](url) — must be before links
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

    // Links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bold: **text** or __text__
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Strikethrough: ~~text~~
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Inline code: `code` (skip inside <pre><code>)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Blockquote: > text (handle escaped &gt;)
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '<br>');

    // Ordered list items: 1. item (must detect before unordered to tag correctly)
    html = html.replace(/^(\d+)\. (.+)$/gm, '<oli>$2</oli>');

    // Unordered list items: - item or * item (but not --- which is already <hr>)
    html = html.replace(/^[\-\*] (.+)$/gm, '<uli>$1</uli>');

    // Wrap consecutive <uli> in <ul>
    html = html.replace(/((?:<uli>.*<\/uli>\n?)+)/g, function(match) {
        const items = match.replace(/<uli>/g, '<li>').replace(/<\/uli>/g, '</li>');
        return '<ul>' + items + '</ul>';
    });

    // Wrap consecutive <oli> in <ol>
    html = html.replace(/((?:<oli>.*<\/oli>\n?)+)/g, function(match) {
        const items = match.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');
        return '<ol>' + items + '</ol>';
    });

    // Paragraphs: split by double newlines
    const blocks = html.split(/\n{2,}/);
    html = blocks.map(block => {
        block = block.trim();
        if (!block) return '';
        // Don't wrap if already a block element
        if (/^<(h[1-6]|ul|ol|li|blockquote|pre|div|hr|img)/.test(block)) return block;
        // Wrap in <p>, convert single newlines to <br>
        return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');

    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateEditorPreview() {
    if (editorPreview && editorTextarea) {
        editorPreview.innerHTML = renderMarkdown(editorTextarea.value);
    }
}

// ============================================================
// Editor: Toolbar formatting helpers
// ============================================================

function insertMarkdown(prefix, suffix) {
    if (!editorTextarea) return;
    const start = editorTextarea.selectionStart;
    const end = editorTextarea.selectionEnd;
    const text = editorTextarea.value;
    const selected = text.substring(start, end);

    if (selected) {
        editorTextarea.value = text.substring(0, start) + prefix + selected + suffix + text.substring(end);
        editorTextarea.selectionStart = start + prefix.length;
        editorTextarea.selectionEnd = end + prefix.length;
    } else {
        editorTextarea.value = text.substring(0, start) + prefix + suffix + text.substring(end);
        editorTextarea.selectionStart = editorTextarea.selectionEnd = start + prefix.length;
    }

    editorTextarea.focus();
    // Sync back to transcript
    transcript.value = editorTextarea.value;
    updateEditorPreview();
}

function insertLinePrefix(prefix) {
    if (!editorTextarea) return;
    const start = editorTextarea.selectionStart;
    const text = editorTextarea.value;

    // Find start of current line
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    editorTextarea.value = text.substring(0, lineStart) + prefix + text.substring(lineStart);
    editorTextarea.selectionStart = editorTextarea.selectionEnd = start + prefix.length;

    editorTextarea.focus();
    transcript.value = editorTextarea.value;
    updateEditorPreview();
}

function insertBlock(block) {
    if (!editorTextarea) return;
    const start = editorTextarea.selectionStart;
    const end = editorTextarea.selectionEnd;
    const text = editorTextarea.value;

    // Ensure we start on a new line
    let prefix = '';
    if (start > 0 && text[start - 1] !== '\n') {
        prefix = '\n';
    }
    // Ensure content after ends on a new line
    let suffix = '';
    if (end < text.length && text[end] !== '\n') {
        suffix = '\n';
    }

    const insertion = prefix + block + suffix;
    editorTextarea.value = text.substring(0, start) + insertion + text.substring(end);
    editorTextarea.selectionStart = editorTextarea.selectionEnd = start + insertion.length;

    editorTextarea.focus();
    transcript.value = editorTextarea.value;
    updateEditorPreview();
}

function insertLinkTemplate() {
    if (!editorTextarea) return;
    const start = editorTextarea.selectionStart;
    const end = editorTextarea.selectionEnd;
    const text = editorTextarea.value;
    const selected = text.substring(start, end);

    if (selected) {
        // Wrap selection as link text
        const insertion = '[' + selected + '](url)';
        editorTextarea.value = text.substring(0, start) + insertion + text.substring(end);
        // Select "url" so user can type over it
        editorTextarea.selectionStart = start + selected.length + 3;
        editorTextarea.selectionEnd = start + selected.length + 6;
    } else {
        const insertion = '[link text](url)';
        editorTextarea.value = text.substring(0, start) + insertion + text.substring(end);
        // Select "link text" so user can type over it
        editorTextarea.selectionStart = start + 1;
        editorTextarea.selectionEnd = start + 10;
    }

    editorTextarea.focus();
    transcript.value = editorTextarea.value;
    updateEditorPreview();
}

function insertImageTemplate() {
    if (!editorTextarea) return;
    const start = editorTextarea.selectionStart;
    const end = editorTextarea.selectionEnd;
    const text = editorTextarea.value;
    const selected = text.substring(start, end);

    if (selected) {
        // Use selection as alt text
        const insertion = '![' + selected + '](url)';
        editorTextarea.value = text.substring(0, start) + insertion + text.substring(end);
        // Select "url"
        editorTextarea.selectionStart = start + selected.length + 4;
        editorTextarea.selectionEnd = start + selected.length + 7;
    } else {
        const insertion = '![alt text](url)';
        editorTextarea.value = text.substring(0, start) + insertion + text.substring(end);
        // Select "alt text"
        editorTextarea.selectionStart = start + 2;
        editorTextarea.selectionEnd = start + 10;
    }

    editorTextarea.focus();
    transcript.value = editorTextarea.value;
    updateEditorPreview();
}

// ============================================================
// Clear handler
// ============================================================

function clearAll() {
    stopReadAloud();
    transcript.value = '';
    enhancedTranscript.value = '';
    if (editorTextarea) editorTextarea.value = '';
    if (editorPreview) editorPreview.innerHTML = '<p class="preview-placeholder">Preview will appear here...</p>';
}

// ============================================================
// Theme handling (legacy — hidden toggle kept for compatibility)
// ============================================================

function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-theme');
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) themeToggle.textContent = isDark ? '\u2600\uFE0F' : '\uD83C\uDF19';
    localStorage.setItem('darkTheme', isDark);
}

function initializeTheme() {
    // Theme toggle is hidden in the new design, but preserved for compatibility
    if (localStorage.getItem('darkTheme') === 'true') {
        document.body.classList.add('dark-theme');
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) themeToggle.textContent = '\u2600\uFE0F';
    }
}

// ============================================================
// Event listeners & initialization
// ============================================================

// Record button
recordButton.onclick = () => isRecording ? stopRecording() : startRecording();

// Replay button (disabled in WebRTC mode)
if (replayButton) {
    replayButton.disabled = true;
    replayButton.title = 'Replay not available in WebRTC mode';
}

// Copy button
copyButton.onclick = () => {
    const text = currentMode === 'editor' ? editorTextarea.value : transcript.value;
    copyToClipboard(text, copyButton);
};

// Legacy copy enhanced button
if (copyEnhancedButton) {
    copyEnhancedButton.onclick = () => copyToClipboard(enhancedTranscript.value, copyEnhancedButton);
}

// Clear button
if (clearButton) {
    clearButton.onclick = clearAll;
}

// Mode toggle
if (modeTranscribe) modeTranscribe.onclick = () => switchMode('transcribe');
if (modeEditor) modeEditor.onclick = () => switchMode('editor');

// Editor toolbar — Text formatting
if (toolbarBold) toolbarBold.onclick = () => insertMarkdown('**', '**');
if (toolbarItalic) toolbarItalic.onclick = () => insertMarkdown('*', '*');
if (toolbarStrikethrough) toolbarStrikethrough.onclick = () => insertMarkdown('~~', '~~');

// Editor toolbar — Structure
if (toolbarH1) toolbarH1.onclick = () => insertLinePrefix('# ');
if (toolbarH2) toolbarH2.onclick = () => insertLinePrefix('## ');
if (toolbarH3) toolbarH3.onclick = () => insertLinePrefix('### ');
if (toolbarBlockquote) toolbarBlockquote.onclick = () => insertLinePrefix('> ');
if (toolbarUL) toolbarUL.onclick = () => insertLinePrefix('- ');
if (toolbarOL) toolbarOL.onclick = () => insertLinePrefix('1. ');
if (toolbarHR) toolbarHR.onclick = () => insertBlock('\n---\n');

// Editor toolbar — Code
if (toolbarCode) toolbarCode.onclick = () => insertMarkdown('`', '`');
if (toolbarCodeBlock) toolbarCodeBlock.onclick = () => {
    if (!editorTextarea) return;
    const start = editorTextarea.selectionStart;
    const end = editorTextarea.selectionEnd;
    const text = editorTextarea.value;
    const selected = text.substring(start, end);
    if (selected) {
        const insertion = '```\n' + selected + '\n```';
        editorTextarea.value = text.substring(0, start) + insertion + text.substring(end);
        editorTextarea.selectionStart = start + 4;
        editorTextarea.selectionEnd = start + 4 + selected.length;
    } else {
        const insertion = '```\ncode\n```';
        editorTextarea.value = text.substring(0, start) + insertion + text.substring(end);
        editorTextarea.selectionStart = start + 4;
        editorTextarea.selectionEnd = start + 8;
    }
    editorTextarea.focus();
    transcript.value = editorTextarea.value;
    updateEditorPreview();
};

// Editor toolbar — Media
if (toolbarLink) toolbarLink.onclick = () => insertLinkTemplate();
if (toolbarImage) toolbarImage.onclick = () => insertImageTemplate();

// Readability / Correctness from editor toolbar
if (toolbarReadability) toolbarReadability.onclick = () => {
    const text = editorTextarea ? editorTextarea.value : transcript.value;
    runReadability(text);
};
if (toolbarCorrectness) toolbarCorrectness.onclick = () => {
    const text = editorTextarea ? editorTextarea.value : transcript.value;
    runCorrectness(text);
};

// Read aloud from the editor toolbar
if (toolbarReadAloud) toolbarReadAloud.onclick = toggleReadAloud;

// Editor textarea -> live preview
if (editorTextarea) {
    editorTextarea.addEventListener('input', () => {
        updateEditorPreview();
        // Keep transcript in sync
        transcript.value = editorTextarea.value;
    });
}

// Spacebar toggle
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
        const active = document.activeElement;
        if (!active.tagName.match(/INPUT|TEXTAREA/) && !active.isContentEditable) {
            event.preventDefault();
            recordButton.click();
        }
    }
});

// Theme toggle (hidden but functional)
const themeToggleBtn = document.getElementById('themeToggle');
if (themeToggleBtn) themeToggleBtn.onclick = toggleTheme;

// Init
document.addEventListener('DOMContentLoaded', async () => {
    await initIndexedDB();
    initializeTheme();
    initializeVoicePreference();
    setReadAloudState(false);
    updateConnectionStatus('idle');
    if (autoStart && !isRecording) startRecording();
});
