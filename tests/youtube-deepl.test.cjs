const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const folder = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(folder, 'YouTube-DeepL.js'), 'utf8');
const baseURL = 'https://www.youtube.com/api/timedtext?v=example&lang=en&fmt=json3';
const captions = (texts) => JSON.stringify({wireMagic: 'pb3', events: [{tStartMs: 0, id: 1}, ...texts.map((text, i) => ({tStartMs: i * 1200, dDurationMs: 1100, wWinId: 1, segs: [{utf8: text, tOffsetMs: 0}]}))]});
function run(options = {}) {
  const calls = [], logs = [], timers = [], results = [];
  const storage = options.storage || {};
  let now = options.now;
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const ctx = {
    console: {log: x => logs.push(String(x))},
    $request: {url: options.url || baseURL},
    $response: {status: options.status || 200, body: options.body === undefined ? captions(['Hello', 'Good morning']) : options.body},
    $argument: Object.assign({api_url: 'https://translation.example/v2/translate', api_key: 'fake-test-key'}, options.args),
    $persistentStore: {read: k => storage[k] || null, write: (v, k) => {
      if (options.failQuotaWrite && k.startsWith('youtube_gemini_quota_v1_')) return false;
      storage[k] = v; return true;
    }},
    $httpClient: {post: (req, cb) => {
      calls.push(req);
      if (options.post) return options.post(req, cb, calls.length);
      const data = JSON.parse(req.body);
      queueMicrotask(() => cb(null, {status: 200}, JSON.stringify({translations: data.text.map(t => ({text: '译:' + t}))})));
    }},
    setTimeout: (fn, ms) => {timers.push({fn, ms}); return timers.length;},
    $done: value => {results.push(value); complete(value);}
  };
  if (now !== undefined) ctx.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  vm.runInNewContext(source, ctx, {timeout: 3000, filename: 'YouTube-DeepL.js'});
  return {calls, logs, timers, results, storage, finished, advance: ms => { now += ms; }};
}
function parsed(output) { return JSON.parse(output.body); }
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

test('json3 bilingual output keeps all event timings and non-text events', async () => {
  const r = run();
  const out = parsed(await r.finished);
  assert.equal(out.events[1].segs[0].utf8, 'Hello\n译:Hello');
  assert.equal(out.events[2].tStartMs, 1200);
  assert.equal(out.events[2].dDurationMs, 1100);
  assert.equal(out.events[2].wWinId, 1);
  assert.deepEqual(out.events[0], {tStartMs: 0, id: 1});
  const req = r.calls[0], p = JSON.parse(req.body);
  assert.deepEqual(p.text, ['Hello', 'Good morning']);
  assert.equal(req.headers.Authorization, 'DeepL-Auth-Key fake-test-key');
  assert.equal(req['auto-redirect'], false);
  assert.equal(req.insecure, false);
  assert.ok(p.context.includes('Good morning'));
  assert.equal('source_lang' in p, false);
});
test('translation-only mode and explicit source/target language', async () => {
  const r = run({args: {display: 'translation', source_lang: 'en', target_lang: 'ja', context: false}});
  assert.equal(parsed(await r.finished).events[1].segs[0].utf8, '译:Hello');
  const p = JSON.parse(r.calls[0].body);
  assert.equal(p.source_lang, 'EN'); assert.equal(p.target_lang, 'JA'); assert.equal('context' in p, false);
});
test('identical translation is not duplicated', async () => {
  const r = run({post: (req, cb) => cb(null, {status: 200}, JSON.stringify({translations: JSON.parse(req.body).text.map(text => ({text}))}))});
  assert.equal(parsed(await r.finished).events[1].segs[0].utf8, 'Hello');
});
test('XML srv3 decodes entities, escapes output and preserves timing/header', async () => {
  const body = '<?xml version="1.0"?><timedtext format="3"><head><wp id="1"/></head><body><p t="100" d="200" w="1"><s t="0">A &amp; B &#x1F600;</s><s t="20"> &lt;b&gt;</s></p></body></timedtext>';
  const r = run({body, post: (req, cb) => {
    assert.deepEqual(JSON.parse(req.body).text, ['A & B 😀 <b>']);
    cb(null, {status: 200}, JSON.stringify({translations: [{text: '甲 & 乙 <人>'}]}));
  }});
  const out = (await r.finished).body;
  assert.ok(out.includes('<head><wp id="1"/></head>'));
  assert.ok(out.includes('<p t="100" d="200" w="1">'));
  assert.ok(out.includes('A &amp; B 😀 &lt;b&gt;\n甲 &amp; 乙 &lt;人&gt;</p>'));
});
test('XML srv1 CDATA and breaks are handled', async () => {
  const r = run({body: '<transcript><text start="1.2" dur="2.3"><![CDATA[x & <y>]]><br/>next</text></transcript>'});
  const out = (await r.finished).body;
  assert.deepEqual(JSON.parse(r.calls[0].body).text, ['x & <y> next']);
  assert.ok(out.includes('start="1.2" dur="2.3"'));
  assert.ok(out.includes('x &amp; &lt;y&gt;\nnext\n译:x &amp; &lt;y&gt; next'));
});
test('WebVTT preserves identifiers, timestamps, cue settings, NOTE and STYLE', async () => {
  const body = 'WEBVTT\r\n\r\nNOTE memo\r\nkeep\r\n\r\nSTYLE\r\n::cue { color: white; }\r\n\r\nid-1\r\n00:01.000 --> 00:03.000 align:start\r\n<c>Hello &amp; world</c>\r\n\r\n00:00:04.000 --> 00:00:05.000\r\nSecond\r\n';
  const r = run({body});
  const out = (await r.finished).body;
  assert.ok(out.includes('id-1\n00:01.000 --> 00:03.000 align:start\nHello &amp; world\n译:Hello &amp; world'));
  assert.ok(out.includes('NOTE memo\nkeep'));
  assert.ok(out.includes('STYLE\n::cue { color: white; }'));
  assert.equal(JSON.parse(r.calls[0].body).text.length, 2);
});
test('duplicate and whitespace-only cues do not cause extra billed texts', async () => {
  const r = run({body: captions(['Hello', '\n', 'Hello', '  Hello  '])});
  await r.finished;
  assert.deepEqual(JSON.parse(r.calls[0].body).text, ['Hello']);
});
test('DeepLX uses single string, Bearer token and string data', async () => {
  const r = run({args: {provider: 'DeepLX', api_url: 'http://192.0.2.1:1188/custom/translate?token=example'}, post: (req, cb) => {
    const p = JSON.parse(req.body);
    assert.equal(typeof p.text, 'string'); assert.equal(p.source_lang, 'auto');
    assert.equal(req.headers.Authorization, 'Bearer fake-test-key');
    assert.equal('context' in p, false);
    cb(null, {status: 200}, JSON.stringify({code: 200, data: '译:' + p.text}));
  }});
  assert.equal(parsed(await r.finished).events[2].segs[0].utf8, 'Good morning\n译:Good morning');
  assert.equal(r.calls.length, 2);
});
test('DeepLX-Batch respects 1500 character budget and positional array replies', async () => {
  const texts = Array.from({length: 10}, (_, i) => String(i) + '英'.repeat(500));
  const r = run({body: captions(texts), args: {provider: 'DeepLX-Batch', api_key: ''}, post: (req, cb) => {
    const p = JSON.parse(req.body);
    assert.ok(p.text.reduce((sum, text) => sum + text.length, 0) <= 1500);
    assert.equal('Authorization' in req.headers, false);
    cb(null, {status: 200}, JSON.stringify({code: 200, data: p.text.map((_, i) => '中' + i)}));
  }});
  assert.ok((await r.finished).body); assert.equal(r.calls.length, 5);
});
test('official batches contain at most 50 texts and a bounded request body', async () => {
  const r = run({body: captions(Array.from({length: 123}, (_, i) => 'Cue ' + i))});
  await r.finished;
  assert.equal(r.calls.length, 3);
  for (const req of r.calls) {
    assert.ok(JSON.parse(req.body).text.length <= 50);
    assert.ok(Buffer.byteLength(req.body, 'utf8') < 128 * 1024);
  }
});
test('cache avoids additional API requests and isolates target/endpoint/key/namespace/video', async () => {
  const storage = {};
  const first = run({storage}); await first.finished;
  const again = run({storage}); await again.finished; assert.equal(again.calls.length, 0);
  for (const option of [
    {args: {target_lang: 'JA'}}, {args: {api_url: 'https://other.example/translate'}},
    {args: {api_key: 'other-key'}}, {args: {cache_namespace: 'v2'}},
    {url: baseURL.replace('v=example', 'v=other')}
  ]) {
    const r = run(Object.assign({storage}, option)); await r.finished; assert.equal(r.calls.length, 1);
  }
  assert.equal(JSON.stringify(storage).includes('fake-test-key'), false);
  assert.equal(JSON.stringify(storage).includes('https://translation.example'), false);
});
test('corrupt and expired cache entries are ignored', async () => {
  const storage = {youtube_deepl_cache_v1: '{broken'};
  const first = run({storage}); await first.finished; assert.equal(first.calls.length, 1);
  const data = JSON.parse(storage.youtube_deepl_cache_v1);
  for (const value of Object.values(data)) value.at = Date.now() - 8 * 86400000;
  storage.youtube_deepl_cache_v1 = JSON.stringify(data);
  const r = run({storage}); await r.finished; assert.equal(r.calls.length, 1);
});
test('disabled cache neither reads nor writes translation cache', async () => {
  const storage = {};
  const r = run({storage, args: {cache: 'false'}}); await r.finished;
  assert.deepEqual(storage, {});
});
test('character cap returns translated prefix and untouched remainder', async () => {
  const r = run({args: {max_chars: 5}});
  const out = parsed(await r.finished);
  assert.equal(out.events[1].segs[0].utf8, 'Hello\n译:Hello');
  assert.equal(out.events[2].segs[0].utf8, 'Good morning');
  assert.deepEqual(JSON.parse(r.calls[0].body).text, ['Hello']);
});
for (const [name, option] of Object.entries({
  disabled: {args: {enabled: 'false'}},
  'YouTube built-in translation': {url: baseURL + '&tlang=zh-Hans'},
  'already Chinese': {url: baseURL.replace('lang=en', 'lang=zh-Hans')},
  'foreign host': {url: baseURL.replace('www.youtube.com', 'youtube.com.evil.example')},
  'unrelated path': {url: baseURL.replace('/api/timedtext', '/other')},
  'non-200': {status: 206},
  empty: {body: ''},
  protobuf: {body: '\x00\x02unrecognized'},
  'unrelated JSON': {body: '{"translations":[]}'},
  'invalid JSON': {body: '{broken'},
  'entity declarations': {body: '<!DOCTYPE transcript [<!ENTITY x "text">]><transcript><text start="0">&x;</text></transcript>'},
  'missing official key': {args: {api_url: 'https://api-free.deepl.com/v2/translate', api_key: ''}},
  'invalid endpoint': {args: {api_url: 'https://user:password@example.com/translate'}},
  'invalid language': {args: {target_lang: 'not a language'}},
  'header injection': {args: {api_key: 'fake\r\nHeader: value'}}
})) test(name + ' passes original through without API request', async () => {
  const r = run(option); assert.deepEqual(JSON.parse(JSON.stringify(await r.finished)), {}); assert.equal(r.calls.length, 0);
});
for (const [name, post] of Object.entries({
  unauthorized: (req, cb) => cb(null, {status: 403}, '{"message":"secret must not be logged"}'),
  'rate limited': (req, cb) => cb(null, {status: 429}, '{}'),
  'quota exhausted': (req, cb) => cb(null, {status: 456}, '{}'),
  redirect: (req, cb) => cb(null, {status: 302}, ''),
  'invalid JSON': (req, cb) => cb(null, {status: 200}, '<html>secret</html>'),
  'wrong cardinality': (req, cb) => cb(null, {status: 200}, '{"translations":[{"text":"only one"}]}'),
  'empty translation': (req, cb) => cb(null, {status: 200}, '{"translations":[{"text":""},{"text":"valid"}]}'),
  'network error': (req, cb) => cb('sensitive URL or token', null, null),
  'invalid XML characters': (req, cb) => cb(null, {status: 200}, JSON.stringify({translations: [{text: '\u0001'},{text:'ok'}]}))
})) test(name + ' fails open and does not log API secrets or bodies', async () => {
  const r = run({post, args: {concurrency: 1}});
  assert.deepEqual(JSON.parse(JSON.stringify(await r.finished)), {});
  assert.equal(r.calls.length, 1);
  assert.ok(!r.logs.join('\n').match(/secret|sensitive|fake-test-key|translation\.example/));
});
test('request timeout and late callback invoke $done exactly once', async () => {
  let callback;
  const r = run({post: (req, cb) => {callback = cb;}, args: {concurrency: 1}});
  assert.equal(r.timers.length, 2);
  r.timers[1].fn();
  await r.finished;
  callback(null, {status: 200}, '{"translations":[{"text":"late"},{"text":"late"}]}');
  r.timers[0].fn();
  await flush(); assert.equal(r.results.length, 1); assert.equal(r.results[0].body, undefined);
});
test('global deadline returns completed portion and guards all later callbacks', async () => {
  let late;
  const r = run({args: {provider: 'DeepLX', concurrency: 1}, post: (req, cb, n) => {
    if (n === 1) cb(null, {status: 200}, '{"code":200,"data":"你好"}'); else late = cb;
  }});
  await flush(); assert.equal(r.calls.length, 2);
  r.timers[0].fn();
  const out = parsed(await r.finished);
  assert.equal(out.events[1].segs[0].utf8, 'Hello\n你好');
  assert.equal(out.events[2].segs[0].utf8, 'Good morning');
  late(null, {status: 200}, '{"code":200,"data":"too late"}');
  await flush(); assert.equal(r.results.length, 1);
});
test('concurrency never exceeds configured bound', async () => {
  const callbacks = [], r = run({args: {provider: 'DeepLX', concurrency: 2}, body: captions(['one','two','three','four','five']), post: (req, cb) => callbacks.push(cb)});
  assert.equal(r.calls.length, 2);
  callbacks.shift()(null, {status: 200}, '{"code":200,"data":"译文"}');
  await flush(); assert.equal(r.calls.length, 3);
  while (callbacks.length) {
    callbacks.shift()(null, {status: 200}, '{"code":200,"data":"译文"}'); await flush();
  }
  await r.finished; assert.equal(r.calls.length, 5);
});
test('a failed request stops queued work without retrying billed POSTs', async () => {
  const r = run({args: {provider: 'DeepLX', concurrency: 1}, body: captions(['one','two','three']), post: (req, cb) => cb(null, {status: 429}, '{}')});
  await r.finished; assert.equal(r.calls.length, 1);
});
test('plugin parameter references match declarations and use the published raw script', () => {
  const plugin = fs.readFileSync(path.join(folder, 'YouTube-DeepL.lpx'), 'utf8');
  const declarations = [...plugin.matchAll(/^([a-z_]+) = (?:switch|select|input),/gm)].map(x => x[1]);
  const script = plugin.split('[Script]')[1].split('[Mitm]')[0];
  const bindings = [...script.matchAll(/\$\{([a-z_]+)\}/g)].map(x => x[1]);
  for (const key of bindings) assert.ok(key === 'url' || declarations.includes(key), key);
  for (const key of declarations) assert.ok(bindings.includes(key), key);
  assert.ok(script.includes('script("https://raw.githubusercontent.com/3biubiu/loon-youtube-deepl/main/YouTube-DeepL.js"'));
  assert.ok(plugin.includes('#!loon_version = 3.5.1(983)'));
});

const geminiArgs = {provider: 'Gemini', gemini_api_key: 'fake-google-key'};
function geminiReply(req, cb, map = rows => rows) {
  const data = JSON.parse(req.body);
  const input = JSON.parse(data.contents[0].parts[0].text);
  const rows = map(input.segments.map(segment => ({id: segment.id, text: '译:' + segment.text})));
  cb(null, {status: 200}, JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({translations: rows})}]}}]}));
}
function geminiRun(options = {}) {
  return run({...options, args: {...geminiArgs, ...options.args}, post: options.post || ((req, cb) => geminiReply(req, cb))});
}
function quota(r) {
  const key = Object.keys(r.storage).find(key => key.startsWith('youtube_gemini_quota_v1_'));
  return key ? JSON.parse(r.storage[key]) : null;
}

test('Gemini translates hundreds of cues in one call, using isolated Google credentials and a schema', async () => {
  const texts = Array.from({length: 600}, (_, n) => 'Line ' + n);
  const r = geminiRun({body: captions(texts)});
  const out = parsed(await r.finished);
  assert.equal(r.calls.length, 1);
  assert.equal(out.events[600].segs[0].utf8, 'Line 599\n译:Line 599');
  const req = r.calls[0], p = JSON.parse(req.body);
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(req.headers['x-goog-api-key'], 'fake-google-key');
  assert.equal('Authorization' in req.headers, false);
  assert.ok(!req.url.includes('fake-google-key'));
  assert.ok(!req.body.includes('fake-test-key'));
  assert.equal(p.generationConfig.responseMimeType, 'application/json');
  assert.equal(p.generationConfig.responseSchema.type, 'OBJECT');
  assert.equal(p.generationConfig.maxOutputTokens, 32768);
  assert.ok(p.systemInstruction.parts[0].text.includes('untrusted'));
  assert.equal(quota(r).used, 1);
});
test('Gemini accepts a custom native API base and configurable model ID', async () => {
  const r = geminiRun({args: {gemini_base_url: 'https://proxy.example/google/v1beta/', gemini_model: 'models/custom-flash-lite'}});
  await r.finished;
  assert.equal(r.calls[0].url, 'https://proxy.example/google/v1beta/models/custom-flash-lite:generateContent');
});
test('Gemini maps reordered ID rows back onto the correct original timings', async () => {
  const r = geminiRun({post: (req, cb) => geminiReply(req, cb, rows => rows.reverse())});
  const out = parsed(await r.finished);
  assert.equal(out.events[1].segs[0].utf8, 'Hello\n译:Hello');
  assert.equal(out.events[2].segs[0].utf8, 'Good morning\n译:Good morning');
  assert.equal(out.events[2].tStartMs, 1200);
});
test('Gemini removes duplicate cues before building the large batch', async () => {
  const r = geminiRun({body: captions(['same', 'same', 'different', '\n'])});
  await r.finished;
  const input = JSON.parse(JSON.parse(r.calls[0].body).contents[0].parts[0].text);
  assert.equal(input.segments.length, 2);
});
test('Gemini batches honor both configurable character limits and an 800-cue output bound', async () => {
  const limited = geminiRun({body: captions(Array.from({length: 10}, (_, n) => n + 'x'.repeat(499))), args: {gemini_batch_chars: 1000}});
  await limited.finished; assert.equal(limited.calls.length, 5);
  const many = geminiRun({body: captions(Array.from({length: 1001}, (_, n) => 'x' + n))});
  await many.finished; assert.equal(many.calls.length, 2);
  for (const req of many.calls) {
    const segments = JSON.parse(JSON.parse(req.body).contents[0].parts[0].text).segments;
    assert.ok(segments.length <= 800);
  }
});
test('Gemini stays serial even when the legacy concurrency option is 3', async () => {
  const callbacks = [];
  const r = geminiRun({body: captions(['a'.repeat(700), 'b'.repeat(700), 'c'.repeat(700)]), args: {concurrency: 3, gemini_batch_chars: 1000}, post: (req, cb) => callbacks.push(() => geminiReply(req, cb))});
  await flush(); assert.equal(r.calls.length, 1);
  callbacks.shift()(); await flush(); assert.equal(r.calls.length, 2);
  callbacks.shift()(); await flush(); assert.equal(r.calls.length, 3);
  callbacks.shift()(); await r.finished;
  assert.equal(quota(r).used, 3);
});
test('Gemini cache hits spend neither daily nor minute quota', async () => {
  const storage = {};
  const first = geminiRun({storage, args: {gemini_rpd: 1}}); await first.finished;
  const second = geminiRun({storage, args: {gemini_rpd: 1}});
  assert.ok((await second.finished).body);
  assert.equal(second.calls.length, 0); assert.equal(quota(second).used, 1);
});
test('Gemini translation cache isolates model IDs', async () => {
  const storage = {};
  const first = geminiRun({storage}); await first.finished;
  const second = geminiRun({storage, args: {gemini_model: 'other-model'}}); await second.finished;
  assert.equal(second.calls.length, 1);
});
test('local RPD blocks subsequent requests but does not remove completed translations', async () => {
  const r = geminiRun({body: captions(['a'.repeat(700), 'b'.repeat(700)]), args: {gemini_rpd: 1, gemini_batch_chars: 1000}});
  const out = parsed(await r.finished);
  assert.equal(r.calls.length, 1); assert.equal(quota(r).used, 1);
  assert.equal(out.events[1].segs[0].utf8, 'a'.repeat(700) + '\n译:' + 'a'.repeat(700));
  assert.equal(out.events[2].segs[0].utf8, 'b'.repeat(700));
});
test('RPD zero explicitly pauses Gemini API use', async () => {
  const r = geminiRun({args: {gemini_rpd: 0}});
  assert.equal((await r.finished).body, undefined); assert.equal(r.calls.length, 0);
});
test('changing Google keys or translation target does not reset the shared local project quota', async () => {
  const storage = {};
  const first = geminiRun({storage, args: {cache: false, gemini_rpd: 1}}); await first.finished;
  for (const args of [{gemini_api_key: 'other-google-key'}, {target_lang: 'JA'}]) {
    const next = geminiRun({storage, args: {...args, cache: false, gemini_rpd: 1}});
    await next.finished; assert.equal(next.calls.length, 0);
  }
});
test('separate quota groups can represent genuinely separate projects', async () => {
  const storage = {};
  const first = geminiRun({storage, args: {cache: false, gemini_rpd: 1}}); await first.finished;
  const second = geminiRun({storage, args: {cache: false, gemini_rpd: 1, gemini_quota_group: 'another-project'}});
  await second.finished; assert.equal(second.calls.length, 1);
});
for (const boundary of [
  '2026-11-04T07:59:50Z', // winter midnight at 08:00 UTC
  '2026-07-04T06:59:50Z', // summer midnight at 07:00 UTC
  '2026-03-08T07:59:50Z', // day of spring transition: midnight is still standard time
  '2026-03-09T06:59:50Z', // midnight after spring transition
  '2026-11-01T06:59:50Z', // day of fall transition: midnight is still daylight time
  '2026-11-02T07:59:50Z'  // midnight after fall transition
]) test('Pacific daily quota rolls over correctly at ' + boundary, async () => {
  const storage = {}, now = Date.parse(boundary);
  const first = geminiRun({storage, now, args: {cache: false, gemini_rpd: 1}}); await first.finished;
  const previous = quota(first).day;
  const second = geminiRun({storage, now: now + 20000, args: {cache: false, gemini_rpd: 1}});
  await second.finished; assert.equal(second.calls.length, 1);
  assert.notEqual(quota(second).day, previous); assert.equal(quota(second).used, 1);
});
test('China or UTC midnight does not reset the Pacific daily quota', async () => {
  const storage = {}, now = Date.parse('2026-11-04T23:59:50Z');
  const first = geminiRun({storage, now, args: {cache: false, gemini_rpd: 1}}); await first.finished;
  const second = geminiRun({storage, now: now + 20000, args: {cache: false, gemini_rpd: 1}});
  await second.finished; assert.equal(second.calls.length, 0);
});
test('rolling RPM is shared across invocations and reserves no call until the wait completes', async () => {
  const storage = {}, now = Date.parse('2026-11-04T12:00:00Z'), args = {cache: false, gemini_rpm: 1};
  const first = geminiRun({storage, now, args}); await first.finished;
  const second = geminiRun({storage, now, args});
  await flush(); assert.equal(second.calls.length, 0); assert.equal(quota(second).used, 1);
  assert.equal(second.timers[1].ms, 60050);
  second.advance(60050); second.timers[1].fn();
  await second.finished; assert.equal(second.calls.length, 1); assert.equal(quota(second).used, 2);
});
test('conservative TPM reservation also waits without adding a countTokens API call', async () => {
  const storage = {}, now = Date.parse('2026-11-04T12:00:00Z'), args = {cache: false, gemini_tpm: 50000};
  const first = geminiRun({storage, now, args}); await first.finished;
  assert.ok(quota(first).recent[0].tokens > 32768);
  const second = geminiRun({storage, now, args});
  await flush(); assert.equal(second.calls.length, 0);
  second.advance(60050); second.timers[1].fn();
  await second.finished; assert.equal(second.calls.length, 1);
  assert.ok(second.calls[0].url.endsWith(':generateContent'));
});
test('TPM below the single-request budget prevents POST rather than silently overspending', async () => {
  const r = geminiRun({args: {gemini_tpm: 1000}});
  await r.finished; assert.equal(r.calls.length, 0);
});
test('minute wait beyond the script deadline returns original subtitles immediately', async () => {
  const storage = {}, now = Date.parse('2026-11-04T12:00:00Z');
  const first = geminiRun({storage, now, args: {cache: false, gemini_rpm: 1}}); await first.finished;
  const second = geminiRun({storage, now, args: {cache: false, gemini_rpm: 1, gemini_budget_seconds: 10}});
  assert.equal((await second.finished).body, undefined); assert.equal(second.calls.length, 0);
});
test('daily-quota 429 persists a block for the Pacific day and never retries', async () => {
  const storage = {}, now = Date.parse('2026-11-04T12:00:00Z');
  const first = geminiRun({storage, now, args: {cache: false}, post: (req, cb) => cb(null, {status: 429}, JSON.stringify({error: {details: [
    {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'}]},
    {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s'}
  ]}}))});
  await first.finished; assert.equal(first.calls.length, 1); assert.equal(quota(first).used, 1);
  assert.equal(quota(first).blockedDay, quota(first).day);
  assert.equal(quota(first).blockedUntil, now + 120000);
  const second = geminiRun({storage, now: now + 180000, args: {cache: false}});
  await second.finished; assert.equal(second.calls.length, 0);
});
test('minute 429 preserves RetryInfo cooldown across invocations without same-call retries', async () => {
  const storage = {}, now = Date.parse('2026-11-04T12:00:00Z');
  const first = geminiRun({storage, now, args: {cache: false}, post: (req, cb) => cb(null, {status: 429}, JSON.stringify({error: {details: [
    {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s'}
  ]}}))});
  await first.finished; assert.equal(first.calls.length, 1);
  assert.equal(quota(first).blockedDay, undefined);
  const second = geminiRun({storage, now, args: {cache: false}});
  await second.finished; assert.equal(second.calls.length, 0);
});
for (const [name, transform] of Object.entries({
  'missing ID': rows => [rows[0]],
  'duplicate ID': rows => [rows[0], rows[0]],
  'out of range ID': rows => [{...rows[0], id: 99}, rows[1]],
  'string ID': rows => [{...rows[0], id: '0'}, rows[1]],
  'empty text': rows => [{...rows[0], text: ''}, rows[1]],
  'invalid XML text': rows => [{...rows[0], text: '\u0001'}, rows[1]]
})) test('Gemini ' + name + ' fails open without spending a repair request', async () => {
  const r = geminiRun({post: (req, cb) => geminiReply(req, cb, transform)});
  assert.equal((await r.finished).body, undefined); assert.equal(r.calls.length, 1); assert.equal(quota(r).used, 1);
});
for (const reason of ['MAX_TOKENS', 'SAFETY', 'RECITATION']) test('Gemini finishReason ' + reason + ' does not apply partial JSON or retry', async () => {
  const r = geminiRun({post: (req, cb) => cb(null, {status: 200}, JSON.stringify({candidates: [{finishReason: reason, content: {parts: [{text: '{partial'}]}}]}))});
  assert.equal((await r.finished).body, undefined); assert.equal(r.calls.length, 1);
});
test('Gemini does not interpret a thought part as translation JSON', async () => {
  const r = geminiRun({post: (req, cb) => cb(null, {status: 200}, JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [
    {thought: true, text: 'internal reasoning must be ignored'},
    {text: JSON.stringify({translations: [{id: 0, text: '你好'}, {id: 1, text: '早上好'}]})}
  ]}}]}))});
  assert.equal(parsed(await r.finished).events[1].segs[0].utf8, 'Hello\n你好');
});
test('Gemini request timeout retains the reserved count and ignores late callback', async () => {
  let late;
  const r = geminiRun({post: (req, cb) => { late = () => geminiReply(req, cb); }});
  await flush(); assert.equal(r.calls.length, 1); assert.equal(quota(r).used, 1);
  r.timers[1].fn(); await r.finished;
  late(); r.timers[0].fn(); await flush();
  assert.equal(r.results.length, 1); assert.equal(quota(r).used, 1); assert.equal(r.results[0].body, undefined);
});
test('Gemini quota storage failure prevents a request', async () => {
  const r = geminiRun({failQuotaWrite: true});
  await r.finished; assert.equal(r.calls.length, 0);
});
test('Gemini rejects corrupted persisted counters instead of resetting and overspending', async () => {
  const storage = {};
  const first = geminiRun({storage, args: {cache: false}}); await first.finished;
  const key = Object.keys(storage).find(key => key.startsWith('youtube_gemini_quota_v1_'));
  storage[key] = '{broken';
  const second = geminiRun({storage, args: {cache: false}}); await second.finished;
  assert.equal(second.calls.length, 0); assert.equal(storage[key], '{broken');
});
for (const [name, args] of Object.entries({
  'missing Google key': {gemini_api_key: ''},
  'injected Google key': {gemini_api_key: 'key\r\nInjected: secret'},
  'AI Studio webpage as API URL': {gemini_base_url: 'https://aistudio.google.com/usage?timeRange=last-28-days'},
  'insecure Google endpoint': {gemini_base_url: 'http://proxy.example/v1beta'},
  'path injection model': {gemini_model: '../other/model'}
})) test('Gemini ' + name + ' is rejected without an API request', async () => {
  const r = geminiRun({args}); await r.finished; assert.equal(r.calls.length, 0);
});
test('Gemini keys and model responses do not enter logs or quota records', async () => {
  const r = geminiRun({post: (req, cb) => cb(null, {status: 403}, '{"error":{"message":"sensitive model response"}}')});
  await r.finished;
  assert.ok(!r.logs.join('\n').match(/sensitive|fake-google-key|fake-test-key/));
  assert.ok(!JSON.stringify(r.storage).includes('fake-google-key'));
});

for (const provider of ['DeepL', 'DeepLX', 'DeepLX-Batch', 'Gemini']) {
  test(provider + ' forwards the selected translation policy to every HTTP request', async () => {
    const policy = '🇺🇸 美国 AI';
    const r = run({args: {provider, api_policy: '  ' + policy + '  ', gemini_api_key: 'fake-google-key'}, post: (req, cb) => {
      assert.equal(req.node, policy);
      assert.ok(!req.body.includes(policy));
      assert.ok(!JSON.stringify(req.headers).includes(policy));
      if (provider === 'Gemini') return geminiReply(req, cb);
      const data = JSON.parse(req.body);
      const reply = provider === 'DeepL' ? {translations: data.text.map(text => ({text: '译:' + text}))}
        : {data: Array.isArray(data.text) ? data.text.map(text => '译:' + text) : '译:' + data.text};
      cb(null, {status: 200}, JSON.stringify(reply));
    }});
    const output = parsed(await r.finished);
    assert.equal(output.events[1].segs[0].utf8, 'Hello\n译:Hello');
    assert.equal(output.events[2].tStartMs, 1200);
    assert.equal(r.calls.length, provider === 'DeepLX' ? 2 : 1);
  });
}

test('missing or blank translation policy omits node for legacy and Gemini requests', async () => {
  for (const api_policy of [undefined, '', ' \t ']) {
    for (const provider of ['DeepL', 'Gemini']) {
      const r = provider === 'Gemini' ? geminiRun({args: {api_policy}}) : run({args: {api_policy}});
      await r.finished;
      assert.equal(r.calls.length, 1);
      assert.equal(Object.hasOwn(r.calls[0], 'node'), false);
    }
  }
});

test('translation policy can explicitly select DIRECT', async () => {
  const r = run({args: {api_policy: 'DIRECT'}});
  await r.finished;
  assert.equal(r.calls[0].node, 'DIRECT');
});

test('changing translation policy reuses Gemini cache and preserves project quota', async () => {
  const storage = {};
  const first = geminiRun({storage, args: {api_policy: 'AI-A'}});
  const firstOutput = await first.finished;
  assert.equal(first.calls[0].node, 'AI-A');
  const cached = geminiRun({storage, args: {api_policy: 'AI-B'}});
  assert.equal((await cached.finished).body, firstOutput.body);
  assert.equal(cached.calls.length, 0);
  assert.equal(quota(cached).used, 1);
  const fresh = geminiRun({storage, body: captions(['A new cue']), args: {api_policy: 'AI-B'}});
  await fresh.finished;
  assert.equal(fresh.calls[0].node, 'AI-B');
  assert.equal(quota(fresh).used, 2);
});

test('a selected-policy connection failure does not retry on another route', async () => {
  const r = geminiRun({args: {api_policy: 'AI-API'}, post: (req, cb) => {
    assert.equal(req.node, 'AI-API');
    cb('selected node unavailable', null, null);
  }});
  assert.equal((await r.finished).body, undefined);
  assert.equal(r.calls.length, 1);
  assert.equal(quota(r).used, 1);
});

test('a policy with embedded control characters is rejected before spending Gemini quota', async () => {
  const r = geminiRun({args: {api_policy: 'AI\nProxy'}});
  assert.equal((await r.finished).body, undefined);
  assert.equal(r.calls.length, 0);
  assert.equal(quota(r), null);
});
