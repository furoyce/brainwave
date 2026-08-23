const { build } = require('./dom_harness.js');

const fails = [];
function check(label, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? `  ${extra}` : ''));
  if (!cond) fails.push(label);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- session shapes
{
  const { x } = build();
  check('realtime session update is text-out with VAD off',
    eq(x.realtimeSessionUpdate().session.audio, { input: { turn_detection: null } })
    && eq(x.realtimeSessionUpdate().session.output_modalities, ['text'])
    && x.realtimeSessionUpdate().session.type === 'realtime');

  const t = x.transcriptionSessionUpdate('gpt-realtime-whisper').session;
  check('transcription session update names the STT model and disables VAD',
    t.type === 'transcription'
    && eq(t.audio.input.transcription, { model: 'gpt-realtime-whisper' })
    && t.audio.input.turn_detection === null
    && t.model === undefined, JSON.stringify(t));
  check('transcription session sends no instructions (verbatim, not post-processed)',
    t.instructions === undefined && t.output_modalities === undefined);
}

// ---------------------------------------------------------------- markdown stripping
{
  const { x } = build();
  const strip = x.stripMarkdownForSpeech;

  check('headings lose the hashes and gain a full stop',
    strip('## Results') === 'Results.', JSON.stringify(strip('## Results')));
  check('a heading that already ends in punctuation is left alone',
    strip('# Ready?') === 'Ready?', JSON.stringify(strip('# Ready?')));
  check('bold and italic markers are dropped',
    strip('This is **very** _quite_ *good*') === 'This is very quite good',
    JSON.stringify(strip('This is **very** _quite_ *good*')));
  check('snake_case survives italic stripping',
    strip('call input_audio_buffer.commit now') === 'call input_audio_buffer.commit now',
    JSON.stringify(strip('call input_audio_buffer.commit now')));
  check('links are read as their text, not their URL',
    strip('see [the docs](https://example.com/x) here') === 'see the docs here',
    JSON.stringify(strip('see [the docs](https://example.com/x) here')));
  check('images are read as their alt text',
    strip('![a chart](chart.png)') === 'a chart', JSON.stringify(strip('![a chart](chart.png)')));
  check('inline code loses its backticks',
    strip('run `npm test` first') === 'run npm test first');
  check('fenced code blocks are not read out',
    !strip('Before\n\n```js\nconst x = 1;\n```\n\nAfter').includes('const x'),
    JSON.stringify(strip('Before\n\n```js\nconst x = 1;\n```\n\nAfter')));
  check('list markers and blockquotes are dropped',
    strip('- one\n- two\n\n1. first\n\n> quoted') === 'one\ntwo\n\nfirst\n\nquoted',
    JSON.stringify(strip('- one\n- two\n\n1. first\n\n> quoted')));
  check('horizontal rules vanish',
    strip('A\n\n---\n\nB') === 'A\n\nB', JSON.stringify(strip('A\n\n---\n\nB')));
  check('strikethrough markers are dropped', strip('~~gone~~ here') === 'gone here');
  check('CJK text passes through unharmed',
    strip('## 中文标题\n\n这是**加粗**的内容。') === '中文标题。\n\n这是加粗的内容。',
    JSON.stringify(strip('## 中文标题\n\n这是**加粗**的内容。')));
  check('empty input yields empty output', strip('') === '' && strip('   \n\n  ') === '');
}

// ---------------------------------------------------------------- chunking
{
  const { x } = build();
  const chunk = x.chunkTextForSpeech;
  const FIRST = x.TTS_FIRST_CHUNK_CHARS, REST = x.TTS_CHUNK_CHARS;

  check('short text is a single chunk', eq(chunk('Hello there.'), ['Hello there.']));
  check('empty text yields no chunks', eq(chunk(''), []));

  const long = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some filler words to take up room.`).join('\n\n');
  const chunks = chunk(long);
  check('long text is split into several chunks', chunks.length > 1, `${chunks.length} chunks`);
  check('every chunk stays under the 4096-char API limit',
    chunks.every((c) => c.length <= 4096), `max=${Math.max(...chunks.map((c) => c.length))}`);
  check('the first chunk is kept short so audio starts fast',
    chunks[0].length <= FIRST, `${chunks[0].length} <= ${FIRST}`);
  check('later chunks respect the standard budget',
    chunks.slice(1).every((c) => c.length <= REST), `max=${Math.max(...chunks.slice(1).map((c) => c.length))}`);
  check('no text is lost while chunking',
    chunks.join(' ').replace(/\s+/g, ' ') === long.replace(/\s+/g, ' '));

  // A single paragraph far bigger than one chunk must split on sentences.
  const bigPara = Array.from({ length: 200 }, (_, i) => `Sentence ${i} goes here.`).join(' ');
  const sc = chunk(bigPara);
  check('an oversized paragraph splits on sentence boundaries',
    sc.length > 1 && sc.every((c) => c.length <= REST) && sc.every((c) => /\.$/.test(c.trim())),
    `${sc.length} chunks, max=${Math.max(...sc.map((c) => c.length))}`);

  // A single sentence longer than a chunk has to be cut mid-sentence.
  const monster = 'x'.repeat(REST * 2 + 100);
  const mc = chunk(monster);
  check('a single sentence longer than a chunk is hard-split',
    mc.length === 3 && mc.every((c) => c.length <= REST) && mc.join('') === monster,
    `${mc.length} chunks`);

  check('CJK sentences split on their own punctuation',
    chunk('第一句话。第二句话。').length >= 1
    && eq(x.splitSentences('第一句话。第二句话。'), ['第一句话。', '第二句话。']),
    JSON.stringify(x.splitSentences('第一句话。第二句话。')));
}

// ---------------------------------------------------------------- transcription events
{
  const { x, doc, set } = build();
  const transcript = doc.getElementById('transcript');
  set('currentSessionType', 'transcription');
  x.resetTranscriptionSegments();

  const ev = (type, extra) => x.handleRealtimeEvent({ type, ...extra });
  const D = 'conversation.item.input_audio_transcription.delta';
  const C = 'conversation.item.input_audio_transcription.completed';

  ev(D, { item_id: 'a', delta: 'Hello' });
  ev(D, { item_id: 'a', delta: ' there' });
  check('deltas accumulate into the transcript', transcript.value === 'Hello there', JSON.stringify(transcript.value));

  ev(C, { item_id: 'a', transcript: 'Hello there, friend.' });
  check('the completed transcript supersedes the accumulated deltas',
    transcript.value === 'Hello there, friend.', JSON.stringify(transcript.value));

  ev(D, { item_id: 'b', delta: 'Second turn' });
  check('a new item becomes a new paragraph',
    transcript.value === 'Hello there, friend.\n\nSecond turn', JSON.stringify(transcript.value));

  // Out-of-order completion must land on its own item, not the newest one.
  ev(D, { item_id: 'c', delta: 'Third' });
  ev(C, { item_id: 'b', transcript: 'Second turn done.' });
  check('an out-of-order completion updates its own item and keeps arrival order',
    transcript.value === 'Hello there, friend.\n\nSecond turn done.\n\nThird', JSON.stringify(transcript.value));

  ev(D, { item_id: 'd', delta: '' });
  check('an empty delta does not add a blank paragraph',
    transcript.value === 'Hello there, friend.\n\nSecond turn done.\n\nThird', JSON.stringify(transcript.value));

  x.resetTranscriptionSegments();
  ev(D, { item_id: 'z', delta: 'Fresh' });
  check('reset clears prior segments', transcript.value === 'Fresh', JSON.stringify(transcript.value));

  // Realtime-session deltas must not be routed through the segment renderer.
  x.resetTranscriptionSegments();
  transcript.value = '';
  ev('response.output_text.delta', { delta: 'realtime text' });
  check('realtime response deltas still append directly',
    transcript.value === 'realtime text', JSON.stringify(transcript.value));

  let failed = false;
  const origErr = console.error;
  ev('conversation.item.input_audio_transcription.failed', { error: { message: 'nope' } });
  check('a transcription failure is handled, not thrown', true);
}

console.log('');
console.log('FAILURES:', fails.length ? fails : 'none');
process.exit(fails.length ? 1 : 0);
