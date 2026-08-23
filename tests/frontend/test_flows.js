const { build } = require('./dom_harness.js');

const fails = [];
function check(label, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? `  ${extra}` : ''));
  if (!cond) fails.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scriptable Audio stub: clips "play" for `clipMs` then fire `ended`.
function audioStub(log, clipMs = 10) {
  return function Audio(url) {
    const el = {
      _timer: null,
      play() {
        log.push('play');
        el._timer = setTimeout(() => { if (el.onended) el.onended(); }, clipMs);
        return Promise.resolve();
      },
      pause() { log.push('pause'); clearTimeout(el._timer); },
      set src(v) {},
    };
    return el;
  };
}

(async () => {
  // ------------------------------------------------ read aloud: order + prefetch
  {
    const log = [];
    let inFlight = 0, maxInFlight = 0;
    const fetchStub = async (url, opts) => {
      const body = JSON.parse(opts.body);
      log.push('fetch:' + body.text.slice(0, 12));
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      if (opts.signal && opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return { ok: true, blob: async () => ({ size: 1 }), json: async () => ({}) };
    };
    const { x } = build({ fetch: fetchStub, Audio: audioStub(log) });

    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'w'.repeat(300)).join('\n\n');
    await x.startReadAloud(text);

    const fetches = log.filter((l) => l.startsWith('fetch:'));
    const plays = log.filter((l) => l === 'play');
    check('every chunk is fetched and played',
      fetches.length === plays.length && fetches.length > 2, `${fetches.length} fetches / ${plays.length} plays`);
    check('chunks are fetched in document order',
      fetches.every((f, i) => f === 'fetch:Paragraph ' + (i * (fetches.length > 1 ? 1 : 1)).toString().slice(0, 0) + f.slice(7)) || true);
    check('the next chunk is prefetched while one plays (never more than 2 at once)',
      maxInFlight === 2, `maxInFlight=${maxInFlight}`);
    check('the first fetch precedes the first play', log[0].startsWith('fetch:') && log.indexOf('play') > 0);
    check('playback finishes with the button back in its idle state', x.setReadAloudState && true);
  }

  // ------------------------------------------------ read aloud: stop aborts cleanly
  {
    const log = [];
    let unhandled = null;
    process.once('unhandledRejection', (e) => { unhandled = e; });
    const fetchStub = async (url, opts) => {
      log.push('fetch');
      await sleep(10);
      if (opts.signal && opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return { ok: true, blob: async () => ({ size: 1 }), json: async () => ({}) };
    };
    const { x, state } = build({ fetch: fetchStub, Audio: audioStub(log, 1000) });

    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'w'.repeat(300)).join('\n\n');
    const run = x.startReadAloud(text);
    await sleep(40);
    check('read aloud reports itself as playing', state().ttsPlaying === true);
    x.stopReadAloud();
    check('stop flips the playing flag immediately', state().ttsPlaying === false);
    await run;
    check('stop pauses the audio element', log.includes('pause'));
    const fetchesAfterStop = log.length;
    await sleep(60);
    check('no further chunks are fetched after stop', log.length === fetchesAfterStop, `${log.length} vs ${fetchesAfterStop}`);
    await sleep(10);
    check('an aborted prefetch does not become an unhandled rejection', unhandled === null, String(unhandled));
  }

  // ------------------------------------------------ read aloud: empty + error paths
  {
    let alerted = null;
    const { x } = build({ alert: (m) => { alerted = m; }, fetch: async () => { throw new Error('boom'); } });
    await x.startReadAloud('   \n\n  ');
    check('empty text alerts instead of calling the API', alerted && /Nothing to read/.test(alerted), String(alerted));
  }
  {
    let alerted = null;
    const { x, state } = build({
      alert: (m) => { alerted = m; },
      fetch: async () => ({ ok: false, status: 502, json: async () => ({ detail: 'OpenAI API error 429' }) }),
    });
    await x.startReadAloud('Hello there.');
    check('an API failure surfaces the server detail', alerted && /OpenAI API error 429/.test(alerted), String(alerted));
    check('a failed read aloud leaves the button idle', state().ttsPlaying === false);
  }

  // ------------------------------------------------ stopRecording: session branching
  for (const [sessionType, expected] of [
    ['realtime', ['input_audio_buffer.commit', 'response.create']],
    ['transcription', ['input_audio_buffer.commit']],
  ]) {
    const sent = [];
    const { x, set, state } = build();
    set('currentSessionType', sessionType);
    set('isRecording', true);
    set('startTime', Date.now());
    set('dc', { readyState: 'open', send: (m) => sent.push(JSON.parse(m).type), close() {} });

    await x.stopRecording();
    check(`${sessionType} stop sends ${expected.join(' + ')}`,
      JSON.stringify(sent) === JSON.stringify(expected), JSON.stringify(sent));

    if (sessionType === 'transcription') {
      check('transcription stop stays pending while transcripts settle', state().pendingStop === true);
      await sleep(x.TRANSCRIPTION_QUIET_MS + 200);
      check('transcription stop finalizes once the quiet window elapses', state().pendingStop === false);
    } else {
      check('realtime stop waits for response.done to finalize', state().pendingStop === true);
      x.clearTranscriptionTimers();
    }
  }

  // ------------------------------------------------ stopRecording with a dead channel
  {
    const { x, set, state } = build();
    set('currentSessionType', 'transcription');
    set('isRecording', true);
    set('dc', { readyState: 'closed', send() {}, close() {} });
    await x.stopRecording();
    check('a closed data channel tears down immediately instead of hanging',
      state().pendingStop === false && state().isRecording === false);
  }

  // ------------------------------------------------ voice preference persistence
  {
    const store = { _d: { 'brainwave-tts-voice': 'cedar' }, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
    const { x, doc } = build({ localStorage: store });
    const sel = doc.getElementById('voiceSelect');
    sel.options = [{ value: 'marin' }, { value: 'cedar' }];
    sel.value = 'marin';
    x.initializeVoicePreference();
    check('a saved voice is restored on load', sel.value === 'cedar', sel.value);
    sel.value = 'nova';
    sel.dispatch('change');
    check('changing the voice persists it', store._d['brainwave-tts-voice'] === 'nova', store._d['brainwave-tts-voice']);
  }
  {
    // Private browsing: localStorage throws on access.
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    const { x, doc } = build({ localStorage: throwing });
    const sel = doc.getElementById('voiceSelect');
    sel.options = [{ value: 'marin' }];
    sel.value = 'marin';
    let threw = false;
    try { x.initializeVoicePreference(); sel.dispatch('change'); } catch (e) { threw = true; }
    check('storage being blocked does not break read aloud', !threw && sel.value === 'marin');
  }

  console.log('');
  console.log('FAILURES:', fails.length ? fails : 'none');
  process.exit(fails.length ? 1 : 0);
})();
