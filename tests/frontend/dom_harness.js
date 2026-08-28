// Minimal DOM stub so public/main.js can be evaluated in Node for testing.
const fs = require('fs');
const vm = require('vm');

function makeEl(id) {
  const listeners = {};
  return {
    id, value: '', innerHTML: '', textContent: '', title: '', disabled: false, hidden: false,
    scrollTop: 0, scrollHeight: 0, selectionStart: 0, selectionEnd: 0, options: [], style: {},
    appendChild(child) { (this._children = this._children || []).push(child); return child; },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    querySelector: () => makeEl('inner'),
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    dispatch(ev, arg) { (listeners[ev] || []).forEach((fn) => fn(arg)); },
    focus() {},
  };
}

function build(overrides = {}) {
  const els = {};
  const doc = {
    getElementById: (id) => (els[id] = els[id] || makeEl(id)),
    querySelector: () => null,
    createElement: (tag) => {
      const el = makeEl(tag);
      if (tag === 'div') {
        Object.defineProperty(el, 'textContent', {
          set(v) { this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
          get() { return this.innerHTML; },
        });
      }
      return el;
    },
    execCommand: () => false, // force the .value fallback path in tests
    addEventListener() {},
    body: { appendChild() {}, classList: makeEl('body').classList },
    activeElement: { tagName: 'BODY', isContentEditable: false },
  };

  const sandbox = {
    document: doc,
    window: { location: { search: '' }, addEventListener() {} },
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} }, mediaDevices: {} },
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    URLSearchParams, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Map, Set,
    TextDecoder, TextEncoder,
    RTCPeerConnection: function () {}, indexedDB: { open: () => ({}) },
    AbortController, fetch: async () => { throw new Error('fetch not stubbed'); },
    Audio: function () { return makeEl('audio'); },
    alert() {}, Blob,
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // `let`/`const` bindings stay lexical in a vm script, so re-export the ones
  // the tests poke at onto a global object.
  const EXPORTS = ['DEFAULT_MODEL', 'TTS_CHUNK_CHARS', 'TTS_FIRST_CHUNK_CHARS',
    'stripMarkdownForSpeech', 'chunkTextForSpeech', 'splitSentences',
    'realtimeSessionUpdate', 'transcriptionSessionUpdate',
    'handleRealtimeEvent', 'resetTranscriptionSegments', 'startReadAloud',
    'stopReadAloud', 'toggleReadAloud', 'setReadAloudState',
    'pauseReadAloud', 'resumeReadAloud', 'togglePauseReadAloud',
    'stopRecording', 'finishRecordingSession', 'waitForFinalTranscription',
    'clearTranscriptionTimers', 'initializeVoicePreference',
    'TRANSCRIPTION_QUIET_MS', 'TRANSCRIPTION_MAX_WAIT_MS',
    'appendPastedText', 'pasteFromClipboard',
    'openChatPanel', 'closeChatPanel', 'sendChatMessage', 'applyToWorkspace', 'CHAT_MODES',
    'applyTextToWorkspace', 'undoApply', 'lastAssistantText', 'chatPanelOpen',
    'setWorkspaceText', 'workspaceText', 'stopChatReadAloud', 'setChatMicState',
    'switchMode'];
  const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'main.js'), 'utf8')
    + '\n;__x = {' + EXPORTS.map((n) => `${n}`).join(', ') + '};'
    + '\n;__state = () => ({ ttsPlaying, ttsPaused, currentSessionType, pendingStop, isRecording, dictationSink, chatMode, chatHistory: JSON.parse(JSON.stringify(chatHistory)), chatStreaming });'
    + '\n;__set = (k, v) => { if (k === "pendingStop") pendingStop = v; if (k === "currentSessionType") currentSessionType = v; if (k === "isRecording") isRecording = v; if (k === "dc") dc = v; if (k === "pc") pc = v; if (k === "startTime") startTime = v; if (k === "dictationSink") dictationSink = v; if (k === "dictationBaseline") dictationBaseline = v; };';
  vm.runInContext(src, sandbox, { filename: 'main.js' });
  return { sandbox, els, doc, x: sandbox.__x, state: sandbox.__state, set: sandbox.__set };
}

module.exports = { build, makeEl };
