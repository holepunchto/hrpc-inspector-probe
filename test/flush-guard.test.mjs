// Proves the never-throw boundary holds AT THE FLUSH TIMER — the one place it did not.
//
// flushNow() called onFlush unguarded from setInterval, and the redactor walked app-owned objects
// with no cycle guard, so `trace({ ctx: this })` crashed the HOST app with an uncatchable
// RangeError. The trap this suite polices: a catch that let a redaction failure fall through to
// exporter.export() would turn that crash into an UNREDACTED EXPORT.

import { BatchFlusher } from '../core/flush.ts';
import { Redactor } from '../core/redactor.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('flush-guard.test.mjs — the flush timer is a never-throw boundary\n');

// --- 1. a throwing onFlush must not escape, and must not deliver ---
{
  let delivered = 0;
  const f = new BatchFlusher({
    intervalMs: 200,
    onFlush: () => { delivered++; throw new Error('redaction blew up'); },
  });
  f.add({ a: 1 });
  f.add({ a: 2 });

  let threw = null;
  try { f.flushNow(); } catch (err) { threw = err; }

  check('flushNow does NOT rethrow into the caller', threw === null, threw && threw.message);
  check('the failing batch is DROPPED, not retried', f.pending === 0);
  check('the loss is COUNTED (droppedBatches)', f.droppedBatches === 1, String(f.droppedBatches));
  check('the rows are counted too (droppedRows)', f.droppedRows === 2, String(f.droppedRows));
  check('the reason is retained for the developer', typeof f.lastError === 'string'
    && f.lastError.includes('redaction blew up'), String(f.lastError));
  check('onFlush was attempted exactly once (no retry loop)', delivered === 1, String(delivered));
}

// --- 2. THE trap: a redaction failure must never fall through to the exporter ---
{
  const exported = [];
  const redactor = new Redactor();
  const f = new BatchFlusher({
    intervalMs: 200,
    onFlush: (batch) => {
      const safe = redactor.redactBatch(batch); // if this throws, nothing may be exported
      exported.push(...safe);
    },
  });

  // A getter that throws is the general case of "redaction can fail on app-owned data".
  const hostile = { type: 'request.start', method: 'x' };
  Object.defineProperty(hostile, 'body', { enumerable: true, get() { throw new Error('boom'); } });
  f.add(hostile);
  let threw = null;
  try { f.flushNow(); } catch (err) { threw = err; }

  check('a redaction failure does not escape the flusher', threw === null, threw && threw.message);
  check('NOTHING was exported when redaction failed (no unredacted fallthrough)',
    exported.length === 0, JSON.stringify(exported).slice(0, 160));
  check('the drop was counted', f.droppedBatches === 1, String(f.droppedBatches));
}

// --- 3. the timer path itself: a throwing onFlush must not escape the tick ---
// Injected timer rather than wall-clock sleeps: the tick is the thing under test, so it must be
// driven deterministically. A sleep here would make the suite flaky on a loaded runner and could
// pass for the wrong reason.
{
  let tick = null;
  const timer = {
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
    clearInterval: () => { tick = null; },
  };
  const f = new BatchFlusher({
    intervalMs: 200,
    onFlush: () => { throw new Error('timer boom'); },
    timer,
  });
  f.start();
  f.add({ n: 1 });

  let escaped = null;
  try { tick(); tick(); tick(); } catch (err) { escaped = err; }

  check('a throwing onFlush does not escape the interval tick', escaped === null,
    escaped && escaped.message);
  check('survived repeated failures on the interval', f.droppedBatches >= 1, String(f.droppedBatches));
  check('nothing is left staged after the failures', f.pending === 0);
  f.stop();
}

// --- 4. the actual reported crash: a self-referencing object through the redactor ---
{
  const redactor = new Redactor();
  class Routine { constructor() { this.name = 'dial'; this.self = this; } }
  const cyclic = { type: 'trace', method: 'hypertrace', data: new Routine() };

  let threw = null;
  let out = null;
  try { out = redactor.redact(cyclic); } catch (err) { threw = err; }
  check('a CYCLIC payload no longer throws (was RangeError)', threw === null, threw && threw.name);
  check('the cyclic body is still summarised', out && out.data && typeof out.data === 'object'
    && 'byteLength' in out.data, JSON.stringify(out && out.data));

  // BigInt is the other JSON.stringify landmine on the same path.
  let bigThrew = null;
  try { redactor.redact({ type: 'trace', data: { n: 10n } }); } catch (err) { bigThrew = err; }
  check('a BigInt payload no longer throws (was TypeError)', bigThrew === null, bigThrew && bigThrew.name);

  // Deep nesting must terminate rather than blow the stack.
  let deep = { end: true };
  for (let i = 0; i < 5000; i++) deep = { nested: deep };
  let deepThrew = null;
  try { redactor.redact({ type: 'trace', data: deep }); } catch (err) { deepThrew = err; }
  check('a 5000-deep payload no longer throws', deepThrew === null, deepThrew && deepThrew.name);

  // Identical content must still hash identically — the content summary depends on it.
  const a = redactor.redact({ type: 't', data: { x: 1, y: [1, 2] } });
  const b = redactor.redact({ type: 't', data: { y: [1, 2], x: 1 } });
  check('key order still does not change the hash', a.data.hash === b.data.hash,
    `${a.data.hash} vs ${b.data.hash}`);

  // A value repeated in SIBLING positions is not a cycle and must still be walked.
  const shared = { k: 'v' };
  const sib = redactor.redact({ type: 't', data: { a: shared, b: shared } });
  check('a value repeated in sibling positions is not mislabelled circular',
    !JSON.stringify(sib.data).includes('Circular'), JSON.stringify(sib.data));
}

// --- 5. CONTROL: the guard must not swallow a SUCCESSFUL flush ---
{
  const seen = [];
  const f = new BatchFlusher({ intervalMs: 200, onFlush: (b) => seen.push(...b) });
  f.add({ ok: 1 });
  f.add({ ok: 2 });
  const n = f.flushNow();
  check('CONTROL: a healthy flush still delivers every row', seen.length === 2 && n === 2,
    `${seen.length} rows, returned ${n}`);
  check('CONTROL: a healthy flush counts no drops', f.droppedBatches === 0 && f.droppedRows === 0);
  check('CONTROL: lastError stays null when nothing failed', f.lastError === null);
}

console.log(failures === 0 ? '\nAll flush-guard claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
