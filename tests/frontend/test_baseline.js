const { build } = require('./dom_harness.js');
const fails = [];
function check(label, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? `  ${extra}` : ''));
  if (!cond) fails.push(label);
}

(async () => {
  const h = build({ TextDecoder, TextEncoder });
  const { x, doc, set } = h;
  const tr = doc.getElementById('transcript');
  const ta = doc.getElementById('editorTextarea');
  const ci = doc.getElementById('chatInput');

  // --- whisper dictation composes over a workspace baseline ---
  set('currentSessionType', 'transcription');
  set('dictationSink', 'workspace');
  tr.value = '';
  x.resetTranscriptionSegments();
  x.handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'spoken part' });
  check('segments render without baseline', tr.value === 'spoken part', JSON.stringify(tr.value));

  // Workspace-mode recording: baseline (existing doc) survives the dictation.
  set('dictationBaseline', 'Existing doc.\n\n');
  x.handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' two' });
  check('whisper dictation composes over the workspace baseline',
    tr.value === 'Existing doc.\n\nspoken part two', JSON.stringify(tr.value));
  set('dictationBaseline', '');
  x.resetTranscriptionSegments();
  tr.value = '';
  x.handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'spoken part' });

  // --- paste during whisper recording persists as a segment ---
  set('isRecording', true);
  x.appendPastedText('pasted mid-recording');
  check('mid-recording paste lands in the doc',
    tr.value === 'spoken part\n\npasted mid-recording', JSON.stringify(tr.value));
  x.handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' continues' });
  check('later deltas do not destroy the pasted text',
    tr.value === 'spoken part continues\n\npasted mid-recording', JSON.stringify(tr.value));
  set('isRecording', false);

  // --- handleResponseCreated separates by the SINK content, not the doc ---
  set('currentSessionType', 'realtime');
  set('dictationSink', 'panel');
  x.resetTranscriptionSegments();
  ci.value = 'first response';
  tr.value = 'doc already ends\n';   // doc ends with newline; composer does not
  x.handleRealtimeEvent({ type: 'response.created' });
  check('mid-stream separator keys off the composer during panel dictation',
    ci.value === 'first response\n' && tr.value === 'doc already ends\n',
    JSON.stringify({ ci: ci.value, tr: tr.value }));

  console.log('');
  console.log('FAILURES:', fails.length ? fails : 'none');
  process.exit(fails.length ? 1 : 0);
})();
