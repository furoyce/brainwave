const { build } = require('./dom_harness.js');
const fails = [];
function check(label, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? `  ${extra}` : ''));
  if (!cond) fails.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Audio stub with controllable clips: play() starts a timer to 'ended';
// pause() freezes it; play() again restarts the remaining wait (approximation
// of resuming mid-clip — good enough for sequencing assertions).
function audioStub(log, clipMs) {
  return function Audio() {
    const el = {
      _timer: null,
      play() {
        log.push('play');
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.onended && el.onended(), clipMs);
        return Promise.resolve();
      },
      pause() { log.push('pause'); clearTimeout(el._timer); },
    };
    return el;
  };
}

function fetchStub(log) {
  return async (url, opts) => {
    log.push('fetch');
    await sleep(5);
    if (opts.signal && opts.signal.aborted) { const e = new Error('x'); e.name = 'AbortError'; throw e; }
    return { ok: true, blob: async () => ({ size: 1 }), json: async () => ({}) };
  };
}

(async () => {
  const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ` + 'w'.repeat(400)).join('\n\n');

  // ---------------------------------------------- pause between chunks parks the loop
  {
    const log = [];
    const { x, state, doc } = build({ fetch: fetchStub(log), Audio: audioStub(log, 30) });
    const run = x.startReadAloud(text);
    await sleep(20);
    check('playing before pause', state().ttsPlaying && !state().ttsPaused);

    x.pauseReadAloud();
    check('pause flips state and pauses the clip', state().ttsPaused && log.includes('pause'));
    const playsAtPause = log.filter((l) => l === 'play').length;
    await sleep(120);
    check('no new clip starts while paused',
      log.filter((l) => l === 'play').length === playsAtPause, `plays=${log.filter((l)=>l==='play').length}`);
    check('pause button shows Resume', doc.getElementById('pauseResumeLabel').textContent === 'Resume');

    x.resumeReadAloud();
    await sleep(150);
    check('resume continues playback', log.filter((l) => l === 'play').length > playsAtPause);
    check('pause button back to Pause', doc.getElementById('pauseResumeLabel').textContent === 'Pause');
    x.stopReadAloud();
    await run;
  }

  // ---------------------------------------------- stop while paused exits cleanly
  {
    const log = [];
    const { x, state } = build({ fetch: fetchStub(log), Audio: audioStub(log, 30) });
    const run = x.startReadAloud(text);
    await sleep(20);
    x.pauseReadAloud();
    x.stopReadAloud();
    check('stop while paused clears both flags', !state().ttsPlaying && !state().ttsPaused);
    let done = false;
    await Promise.race([run.then(() => { done = true; }), sleep(300)]);
    check('the playback loop exits instead of hanging on the pause gate', done);
    const count = log.length;
    await sleep(100);
    check('nothing runs after stop', log.length === count);
  }

  // ---------------------------------------------- toggle + no-op guards
  {
    const log = [];
    const { x, state, doc } = build({ fetch: fetchStub(log), Audio: audioStub(log, 40) });
    x.togglePauseReadAloud();
    check('toggle is a no-op when idle', !state().ttsPaused);
    const run = x.startReadAloud(text);
    await sleep(20);
    check('pause button visible while playing', doc.getElementById('toolbarPauseResume').hidden === false);
    x.togglePauseReadAloud();
    check('toggle pauses', state().ttsPaused);
    x.togglePauseReadAloud();
    check('toggle resumes', !state().ttsPaused);
    x.stopReadAloud();
    await run;
    check('pause button hidden when stopped', doc.getElementById('toolbarPauseResume').hidden === true);
  }

  // ---------------------------------------------- copy button routing
  {
    const writes = [];
    const { x, doc } = build({
      navigator: { userAgent: 'node', clipboard: { writeText: async (t) => { writes.push(t); } }, mediaDevices: {} },
    });
    doc.getElementById('editorTextarea').value = 'Workspace doc text.';
    doc.getElementById('transcript').value = 'Workspace doc text.';
    doc.getElementById('toolbarCopy').onclick();
    await sleep(10);
    check('toolbar copy copies the workspace text', writes[0] === 'Workspace doc text.', JSON.stringify(writes));

    x.switchMode('editor');
    check('footer copy hidden in Workspace', doc.getElementById('copyButton').hidden === true);
    x.switchMode('transcribe');
    check('footer copy visible in Transcribe', doc.getElementById('copyButton').hidden === false);
  }

  console.log('');
  console.log('FAILURES:', fails.length ? fails : 'none');
  process.exit(fails.length ? 1 : 0);
})();
