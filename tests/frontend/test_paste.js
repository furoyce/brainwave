const { build } = require('./dom_harness.js');
const fails = [];
function check(label, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? `  ${extra}` : ''));
  if (!cond) fails.push(label);
}

(async () => {
  // readText available and permitted
  {
    const { x, doc } = build({
      navigator: { userAgent: 'node', clipboard: { readText: async () => 'from another app', writeText: async () => {} }, mediaDevices: {} },
    });
    const ta = doc.getElementById('editorTextarea');
    const tr = doc.getElementById('transcript');
    ta.value = tr.value = 'existing doc';
    await x.pasteFromClipboard();
    check('paste appends with a blank-line separator',
      ta.value === 'existing doc\n\nfrom another app', JSON.stringify(ta.value));
    check('transcript mirror stays in sync', tr.value === ta.value);
    await x.pasteFromClipboard();
    check('second paste accumulates',
      ta.value === 'existing doc\n\nfrom another app\n\nfrom another app', JSON.stringify(ta.value));
  }
  // empty workspace
  {
    const { x, doc } = build({
      navigator: { userAgent: 'node', clipboard: { readText: async () => 'first content', writeText: async () => {} }, mediaDevices: {} },
    });
    await x.pasteFromClipboard();
    check('paste into empty workspace has no leading separator',
      doc.getElementById('editorTextarea').value === 'first content',
      JSON.stringify(doc.getElementById('editorTextarea').value));
  }
  // CRLF normalisation + trailing whitespace
  {
    const { x, doc } = build({
      navigator: { userAgent: 'node', clipboard: { readText: async () => 'line1\r\nline2\r\n\r\n', writeText: async () => {} }, mediaDevices: {} },
    });
    await x.pasteFromClipboard();
    check('CRLF is normalised and trailing whitespace stripped',
      doc.getElementById('editorTextarea').value === 'line1\nline2', JSON.stringify(doc.getElementById('editorTextarea').value));
  }
  // empty clipboard
  {
    const { x, doc } = build({
      navigator: { userAgent: 'node', clipboard: { readText: async () => '   ', writeText: async () => {} }, mediaDevices: {} },
    });
    const ta = doc.getElementById('editorTextarea');
    ta.value = 'untouched';
    await x.pasteFromClipboard();
    check('empty clipboard leaves the doc untouched', ta.value === 'untouched');
  }
  // readText throws (permission denied)
  {
    const { x, doc } = build({
      navigator: { userAgent: 'node', clipboard: { readText: async () => { throw new Error('denied'); }, writeText: async () => {} }, mediaDevices: {} },
    });
    const ta = doc.getElementById('editorTextarea');
    ta.value = 'safe';
    let threw = false;
    try { await x.pasteFromClipboard(); } catch { threw = true; }
    check('permission denial is handled, not thrown', !threw && ta.value === 'safe');
  }
  // no clipboard API at all (Firefox)
  {
    const { x, doc } = build({ navigator: { userAgent: 'node', mediaDevices: {} } });
    let threw = false;
    try { await x.pasteFromClipboard(); } catch { threw = true; }
    check('missing clipboard API falls back without throwing', !threw);
  }
  console.log('');
  console.log('FAILURES:', fails.length ? fails : 'none');
  process.exit(fails.length ? 1 : 0);
})();
