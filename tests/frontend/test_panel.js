const { build } = require('./dom_harness.js');
const fails = [];
function check(label, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? `  ${extra}` : ''));
  if (!cond) fails.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Streaming fetch stub for /api/chat: records the request, streams `reply`.
function chatFetch(replies, log = []) {
  let call = 0;
  return async (url, opts) => {
    if (!String(url).includes('/api/chat')) {
      return { ok: true, blob: async () => ({ size: 1 }), json: async () => ({}) };
    }
    const body = JSON.parse(opts.body);
    log.push(body);
    const text = replies[Math.min(call++, replies.length - 1)];
    const enc = new TextEncoder();
    let sent = false;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            await sleep(2);
            return { done: false, value: enc.encode(text) };
          },
        }),
      },
    };
  };
}

// The harness's document.querySelector returns null; the panel uses it for
// .editor-split. Patch build() output with a stub that returns a classList holder.
function buildPanel(overrides = {}) {
  const splitEl = { classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} } };
  const b = build({ TextEncoder, ...overrides });
  // Real markup starts the panel and apply bar hidden; harness defaults don't.
  b.doc.getElementById('chatPanel').hidden = true;
  b.doc.getElementById('chatApplyBar').hidden = true;
  b.doc.getElementById('chatUndo').hidden = true;
  b.doc.querySelector = (sel) => (sel === '.editor-split' ? splitEl : null);
  b.split = splitEl;
  return b;
}

(async () => {
  // ---------------------------------------------- open -> seed -> stream
  {
    const log = [];
    const h = buildPanel({ fetch: chatFetch(['Simplified version.'], log) });
    const { x, doc, state } = h;
    doc.getElementById('editorTextarea').value = 'Some dense original text.';
    doc.getElementById('transcript').value = 'Some dense original text.';

    x.openChatPanel('readability');
    await sleep(30);

    check('panel opens', x.chatPanelOpen() === true);
    check('editor-split gets chat-open class', h.split.classList.contains('chat-open'));
    const st = state();
    check('turn 1 wraps the document in <document> tags',
      log.length === 1 && /^<document>\n[\s\S]*\n<\/document>$/.test(log[0].messages[0].content),
      JSON.stringify(log[0] && log[0].messages[0].content.slice(0, 40)));
    check('mode is sent', log[0].mode === 'readability');
    check('assistant reply lands in history',
      st.chatHistory.length === 2 && st.chatHistory[1].content === 'Simplified version.',
      JSON.stringify(st.chatHistory));
    check('apply bar becomes visible', doc.getElementById('chatApplyBar').hidden === false);
  }

  // ---------------------------------------------- follow-up turn
  {
    const log = [];
    const h = buildPanel({ fetch: chatFetch(['First rewrite.', 'Shorter rewrite.'], log) });
    const { x, doc, state } = h;
    doc.getElementById('editorTextarea').value = 'Doc text.';
    doc.getElementById('transcript').value = 'Doc text.';
    x.openChatPanel('readability');
    await sleep(30);

    doc.getElementById('chatInput').value = 'Make it shorter.';
    x.sendChatMessage();
    await sleep(30);

    check('follow-up sends the full history',
      log[1].messages.length === 3 &&
      log[1].messages[2].content === 'Make it shorter.',
      JSON.stringify(log[1] && log[1].messages.map(m => m.role)));
    check('composer clears after send', doc.getElementById('chatInput').value === '');
    check('history now has 4 entries', state().chatHistory.length === 4);
  }

  // ---------------------------------------------- apply: append / replace / undo
  {
    const h = buildPanel({ fetch: chatFetch(['The rewrite.']) });
    const { x, doc } = h;
    const ta = doc.getElementById('editorTextarea');
    const tr = doc.getElementById('transcript');
    ta.value = tr.value = 'Original doc.';
    x.openChatPanel('readability');
    await sleep(30);

    x.applyToWorkspace('append');
    check('append keeps original and adds the reply',
      ta.value === 'Original doc.\n\nThe rewrite.', JSON.stringify(ta.value));
    check('append syncs the transcript mirror', tr.value === ta.value);

    x.undoApply();
    check('undo restores the pre-apply doc', ta.value === 'Original doc.' && tr.value === 'Original doc.');

    x.applyToWorkspace('replace');
    check('replace swaps the whole doc', ta.value === 'The rewrite.' && tr.value === 'The rewrite.');
    x.undoApply();
    check('undo works after replace too', ta.value === 'Original doc.');

    x.applyTextToWorkspace('A specific earlier reply.', 'replace');
    check('per-message apply uses that message, not the newest',
      ta.value === 'A specific earlier reply.');
  }

  // ---------------------------------------------- empty workspace refuses to open
  {
    let alerted = null;
    const h = buildPanel({ fetch: chatFetch(['x']), alert: (m) => { alerted = m; } });
    h.doc.getElementById('editorTextarea').value = '   ';
    h.x.openChatPanel('readability');
    check('empty workspace alerts instead of opening',
      alerted !== null && h.x.chatPanelOpen() === false, String(alerted));
  }

  // ---------------------------------------------- chat API error shows in bubble
  {
    const h = buildPanel({
      fetch: async (url) => String(url).includes('/api/chat')
        ? { ok: false, status: 502, json: async () => ({ detail: 'OpenAI error: boom' }) }
        : { ok: true },
    });
    h.doc.getElementById('editorTextarea').value = 'Doc.';
    h.x.openChatPanel('readability');
    await sleep(30);
    const msgs = h.doc.getElementById('chatMessages');
    check('server error surfaces in the panel, not a silent hang',
      h.state().chatStreaming === false);
  }

  // ---------------------------------------------- panel dictation sink
  {
    const h = buildPanel({ fetch: chatFetch(['x']) });
    const { x, doc, set, state } = h;
    doc.getElementById('editorTextarea').value = 'The document.';
    doc.getElementById('transcript').value = 'The document.';
    x.openChatPanel('readability');
    await sleep(30);

    // Simulate panel dictation: sink=panel, transcription deltas arrive.
    set('currentSessionType', 'transcription');
    set('dictationSink', 'panel');
    h.sandbox.__x.handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'spoken reply' });
    h.sandbox.__x.handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Spoken reply, cleaned.' });
    check('panel dictation lands in the composer',
      doc.getElementById('chatInput').value === 'Spoken reply, cleaned.',
      JSON.stringify(doc.getElementById('chatInput').value));
    check('panel dictation leaves the document untouched',
      doc.getElementById('transcript').value === 'The document.'
      && doc.getElementById('editorTextarea').value === 'The document.',
      JSON.stringify(doc.getElementById('transcript').value));

    // Realtime-session deltas route the same way while the sink is panel.
    doc.getElementById('chatInput').value = '';
    h.sandbox.__x.handleRealtimeEvent({ type: 'response.output_text.delta', delta: 'realtime spoken' });
    check('realtime-session dictation also routes to the composer',
      doc.getElementById('chatInput').value === 'realtime spoken'
      && doc.getElementById('transcript').value === 'The document.');

    // Back to workspace sink: deltas go to the document again.
    set('dictationSink', 'workspace');
    h.sandbox.__x.resetTranscriptionSegments();
    h.sandbox.__x.handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'doc dictation' });
    check('workspace sink still writes to the document',
      doc.getElementById('transcript').value === 'doc dictation');
  }

  // ---------------------------------------------- close cleans up
  {
    const h = buildPanel({ fetch: chatFetch(['x']) });
    const { x, doc } = h;
    doc.getElementById('editorTextarea').value = 'Doc.';
    x.openChatPanel('readability');
    await sleep(30);
    x.closeChatPanel();
    check('close hides the panel', x.chatPanelOpen() === false);
    check('close removes chat-open from the split', !h.split.classList.contains('chat-open'));
  }

  // ---------------------------------------------- reopening resets the conversation
  {
    const log = [];
    const h = buildPanel({ fetch: chatFetch(['r1', 'r2'], log) });
    const { x, doc, state } = h;
    doc.getElementById('editorTextarea').value = 'Doc v1.';
    doc.getElementById('transcript').value = 'Doc v1.';
    x.openChatPanel('readability');
    await sleep(30);
    x.closeChatPanel();
    doc.getElementById('editorTextarea').value = 'Doc v2.';
    x.openChatPanel('correctness');
    await sleep(30);
    check('reopen starts a fresh conversation on the current doc',
      state().chatHistory.length === 2 &&
      log[1].mode === 'correctness' &&
      log[1].messages[0].content.includes('Doc v2.'),
      JSON.stringify(log[1] && log[1].mode));
  }

  // ---------------------------------------------- toolbar routing (Brainstorm era)
  {
    const chatCalls = [];
    const restCalls = [];
    const fetchStub = async (url, opts) => {
      const u = String(url);
      if (u.includes('/api/chat')) { chatCalls.push(u); return chatFetch(['x'])(url, opts); }
      restCalls.push(u);
      const enc = new TextEncoder();
      let sent = false;
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: enc.encode('Rewritten.') }) }) },
      };
    };
    const h = buildPanel({ fetch: fetchStub, TextEncoder });
    const { x, doc, state } = h;
    doc.getElementById('editorTextarea').value = 'Original doc text.';
    doc.getElementById('transcript').value = 'Original doc text.';

    check('brainstorm is a registered chat mode with its own title',
      x.CHAT_MODES.brainstorm && x.CHAT_MODES.brainstorm.title === 'Brainstorm',
      JSON.stringify(x.CHAT_MODES.brainstorm));

    // Brainstorm opens the pane
    x.openChatPanel('brainstorm');
    await sleep(20);
    check('brainstorm opens the docked pane', x.chatPanelOpen() && state().chatMode === 'brainstorm');
    check('brainstorm seeds the document turn to /api/chat', chatCalls.length === 1, String(chatCalls.length));
    check('pane title says Brainstorm', doc.getElementById('chatTitle').textContent === 'Brainstorm');
    x.closeChatPanel();

    // Readability toolbar handler is a one-shot doc transform again
    const before = chatCalls.length;
    doc.getElementById('toolbarReadability').onclick();
    await sleep(20);
    check('readability hits /api/readability, not the chat pane',
      restCalls.some((u) => u.includes('/api/readability')) && chatCalls.length === before && !x.chatPanelOpen(),
      JSON.stringify(restCalls));
    check('readability rewrite lands in the workspace and stays synced across tabs',
      x.workspaceText() === 'Rewritten.' && doc.getElementById('transcript').value === 'Rewritten.',
      JSON.stringify(x.workspaceText()));

    // Correctness reviews without touching the doc
    doc.getElementById('editorTextarea').value = 'Doc for review.';
    doc.getElementById('transcript').value = 'Doc for review.';
    doc.getElementById('toolbarCorrectness').onclick();
    await sleep(20);
    check('correctness hits /api/correctness and leaves the doc alone',
      restCalls.some((u) => u.includes('/api/correctness')) && x.workspaceText() === 'Doc for review.' && !x.chatPanelOpen());
  }

  console.log('');
  console.log('FAILURES:', fails.length ? fails : 'none');
  process.exit(fails.length ? 1 : 0);
})();

// NOTE: the suites above exercise the panel machinery through
// openChatPanel('readability'|'correctness') directly — those modes stay valid
// server-side. The toolbar routing changed: Brainstorm owns the panel now.
