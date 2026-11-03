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
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const ctx = {
    console: {log: x => logs.push(String(x))},
    $request: {url: options.url || baseURL},
    $response: {status: options.status || 200, body: options.body === undefined ? captions(['Hello', 'Good morning']) : options.body},
    $argument: Object.assign({api_url: 'https://translation.example/v2/translate', api_key: 'fake-test-key'}, options.args),
    $persistentStore: {read: k => storage[k] || null, write: (v, k) => {storage[k] = v; return true;}},
    $httpClient: {post: (req, cb) => {
      calls.push(req);
      if (options.post) return options.post(req, cb, calls.length);
      const data = JSON.parse(req.body);
      queueMicrotask(() => cb(null, {status: 200}, JSON.stringify({translations: data.text.map(t => ({text: '译:' + t}))})));
    }},
    setTimeout: (fn, ms) => {timers.push({fn, ms}); return timers.length;},
    $done: value => {results.push(value); complete(value);}
  };
  vm.runInNewContext(source, ctx, {timeout: 3000, filename: 'YouTube-DeepL.js'});
  return {calls, logs, timers, results, storage, finished};
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
