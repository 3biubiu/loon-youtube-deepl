/* YouTube DeepL subtitles v1.0.0 — Loon >= 3.5.1 (983).
 * No dependencies. No request to a translation server until a supported
 * original-language caption body has been parsed. No URL rewriting.
 * API secrets, signed YouTube URLs and subtitle text are never logged.
 */
(function () {
  "use strict";
  var CACHE_KEY = "youtube_deepl_cache_v1";
  var TTL = 7 * 86400000;
  var done = false, doc = null, cfg = null, store = {}, pending = {};
  var translations = Object.create(null), scope = "", deadline = 0;
  var changed = 0, hits = 0, halted = false;

  function log(message) { console.log("[YouTube DeepL] " + message); }
  function bool(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return value === true || value === "true" || value === "1" || value === 1;
  }
  function number(value, fallback, min, max) {
    var n = Number(value);
    return isFinite(n) && value !== "" && value != null ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
  }
  function readConfig() {
    var a = typeof $argument === "undefined" ? {} : ($argument || {});
    if (typeof a === "string") a = JSON.parse(a);
    var c = {
      enabled: bool(a.enabled, true), provider: String(a.provider || "DeepL"),
      url: String(a.api_url || "https://api-free.deepl.com/v2/translate").trim(),
      key: String(a.api_key || "").trim(), target: String(a.target_lang || "ZH").trim().toUpperCase(),
      source: String(a.source_lang || "AUTO").trim().toUpperCase(),
      bilingual: a.display !== "translation", context: bool(a.context, true), cache: bool(a.cache, true),
      namespace: String(a.cache_namespace || "default"), concurrency: number(a.concurrency, 2, 1, 3),
      maxChars: number(a.max_chars, 60000, 1, 300000), budget: number(a.budget_seconds, 45, 5, 50) * 1000
    };
    if (["DeepL", "DeepLX", "DeepLX-Batch"].indexOf(c.provider) < 0) throw new Error("接口类型无效");
    // Exact endpoint, including query string. No guessing or appending paths.
    if (!/^https?:\/\/[^\s\/#?@]+(?:[/?][^\s#]*)?$/i.test(c.url)) throw new Error("请填写不含用户密码或片段的完整 HTTP(S) 接口地址");
    if (!/^[A-Z]{2,3}(?:-[A-Z]{2,4})?$/.test(c.target) || !/^(?:AUTO|[A-Z]{2,3}(?:-[A-Z]{2,4})?)$/.test(c.source)) throw new Error("语言代码无效");
    if (/^https?:\/\/(?:api(?:-free)?\.deepl\.com)(?:\/|$)/i.test(c.url) && !c.key) throw new Error("DeepL 官方接口需要 API Key");
    if (/[\r\n]/.test(c.key)) throw new Error("API Key 含有换行");
    return c;
  }
  function query(url, key) {
    var m = new RegExp("[?&]" + key + "=([^&#]*)").exec(url);
    if (!m) return "";
    try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (_) { return ""; }
  }
  function fingerprint(text) {
    var a = 2166136261, b = 5381;
    for (var i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return (a >>> 0).toString(16) + ":" + (b >>> 0).toString(16);
  }
  function decodeXML(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (all, entity) {
      var names = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'"};
      if (entity.charAt(0) !== "#") return names[entity.toLowerCase()] || all;
      var n = entity.charAt(1).toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
    });
  }
  function escapeXML(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function xmlText(text) {
    // Decode once, after removing markup; encoded literal <tags> are preserved.
    var chunks = [], re = /<!\[CDATA\[([\s\S]*?)\]\]>|<br\s*\/?\s*>|<[^>]*>|([^<]+)/gi, m;
    while ((m = re.exec(text))) {
      if (m[1] !== undefined) chunks.push(m[1]);
      else if (/^<br/i.test(m[0])) chunks.push("\n");
      else if (m[2] !== undefined) chunks.push(decodeXML(m[2]));
    }
    return chunks.join("");
  }
  function normalize(text) { return text.replace(/[ \t\r\n]+/g, " ").trim(); }
  function show(original, translated) {
    if (!translated || normalize(original) === normalize(translated)) return original;
    return cfg.bilingual ? original.trim() + "\n" + translated.trim() : translated.trim();
  }
  function parseBody(body) {
    var trimmed = body.replace(/^\uFEFF/, "").trim();
    if (trimmed.charAt(0) === "{") {
      var json = JSON.parse(trimmed);
      if (!Array.isArray(json.events)) return null;
      var cues = [];
      json.events.forEach(function (event) {
        if (!event || !Array.isArray(event.segs)) return;
        var original = event.segs.map(function (s) { return s && typeof s.utf8 === "string" ? s.utf8 : ""; }).join("");
        if (normalize(original)) cues.push({text: normalize(original), original: original, event: event});
      });
      return {cues: cues, render: function () {
        cues.forEach(function (cue) {
          var tr = translations[cue.text];
          if (tr) cue.event.segs = [{utf8: show(cue.original, tr)}];
        });
        return JSON.stringify(json);
      }};
    }
    if (/^WEBVTT(?:[\t \r\n]|$)/.test(trimmed)) {
      var blocks = body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
      var vtt = [];
      blocks.forEach(function (block, index) {
        if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block)) return;
        var lines = block.split("\n"), timing = -1;
        for (var i = 0; i < Math.min(lines.length, 2); i++) {
          if (/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}/.test(lines[i])) { timing = i; break; }
        }
        if (timing < 0) return;
        var original = xmlText(lines.slice(timing + 1).join("\n"));
        if (normalize(original)) vtt.push({text: normalize(original), original: original, lines: lines, timing: timing, index: index});
      });
      return {cues: vtt, render: function () {
        vtt.forEach(function (cue) {
          if (translations[cue.text]) blocks[cue.index] = cue.lines.slice(0, cue.timing + 1).join("\n") + "\n" + escapeXML(show(cue.original, translations[cue.text])).replace(/\n{2,}/g, "\n");
        });
        return blocks.join("\n\n");
      }};
    }
    if (/<(?:timedtext|transcript)\b/i.test(trimmed) && !/<!DOCTYPE|<!ENTITY/i.test(trimmed)) {
      var xml = [], re = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, match;
      while ((match = re.exec(body))) {
        var original = xmlText(match[3]);
        if (normalize(original)) xml.push({text: normalize(original), original: original,
          start: match.index, end: re.lastIndex, tag: match[1], attrs: match[2]});
      }
      return {cues: xml, render: function () {
        var result = "", at = 0;
        xml.forEach(function (cue) {
          result += body.slice(at, cue.start);
          var tr = translations[cue.text];
          result += tr ? "<" + cue.tag + cue.attrs + ">" + escapeXML(show(cue.original, tr)) + "</" + cue.tag + ">" : body.slice(cue.start, cue.end);
          at = cue.end;
        });
        return result + body.slice(at);
      }};
    }
    return null;
  }
  function readStore() {
    try {
      var value = JSON.parse($persistentStore.read(CACHE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }
  function cacheId(text) { return fingerprint(scope + "|" + text); }
  function cached(text) {
    if (!cfg.cache) return null;
    var id = cacheId(text), e = store[id];
    if (!e || e.s !== scope || e.o !== text || typeof e.t !== "string" || !e.t.trim() || Date.now() - e.at >= TTL) return null;
    pending[id] = {s: scope, o: text, t: e.t, at: Date.now()};
    hits++;
    return e.t;
  }
  function remember(text, translated) {
    translations[text] = translated;
    changed++;
    if (cfg.cache) pending[cacheId(text)] = {s: scope, o: text, t: translated, at: Date.now()};
  }
  function saveCache() {
    if (!cfg || !cfg.cache || !Object.keys(pending).length) return;
    // Re-read to retain completed entries from other concurrent invocations.
    var merged = readStore(), now = Date.now();
    Object.keys(pending).forEach(function (id) { merged[id] = pending[id]; });
    var keys = Object.keys(merged).filter(function (id) {
      var e = merged[id]; return e && typeof e.at === "number" && now - e.at < TTL;
    }).sort(function (a, b) { return merged[b].at - merged[a].at; });
    var bounded = {}, bytes = 2;
    keys.slice(0, 800).forEach(function (id) {
      var cost = JSON.stringify(merged[id]).length + id.length + 5;
      if (bytes + cost <= 180000) { bounded[id] = merged[id]; bytes += cost; }
    });
    try {
      if (!$persistentStore.write(JSON.stringify(bounded), CACHE_KEY)) log("本地缓存写入失败；不影响本次译文");
    } catch (_) { log("本地缓存写入失败；不影响本次译文"); }
  }
  function finish(reason) {
    if (done) return;
    done = true;
    var output = {};
    try {
      if (doc && Object.keys(translations).length) output.body = doc.render();
      saveCache();
    } catch (_) { output = {}; log("输出处理失败，保留原字幕"); }
    if (reason) log(reason);
    if (doc) log("字幕 " + doc.cues.length + " 条；新译 " + changed + " 条；缓存 " + hits + " 条");
    $done(output);
  }
  function requestTranslation(texts, context) {
    return new Promise(function (resolve, reject) {
      if (done || halted || Date.now() >= deadline) return reject(new Error("已达到等待时限"));
      var official = cfg.provider === "DeepL";
      var payload = {text: cfg.provider === "DeepLX" ? texts[0] : texts, target_lang: cfg.target};
      if (cfg.source !== "AUTO") payload.source_lang = cfg.source;
      else if (!official) payload.source_lang = "auto";
      if (official) {
        payload.split_sentences = "0";
        payload.preserve_formatting = true;
        if (cfg.context && context) payload.context = context;
      }
      var headers = {"Content-Type": "application/json", Accept: "application/json"};
      if (cfg.key) headers.Authorization = (official ? "DeepL-Auth-Key " : "Bearer ") + cfg.key;
      var settled = false;
      function fail(message) { if (!settled) { settled = true; reject(new Error(message)); } }
      // Loon has no dependable clearTimeout. settled + done guard late callbacks.
      var timeout = Math.max(1, Math.min(12000, deadline - Date.now()));
      setTimeout(function () { fail("翻译请求超时"); }, timeout);
      try {
        $httpClient.post({url: cfg.url, headers: headers, body: JSON.stringify(payload), timeout: timeout,
          "auto-redirect": false, "auto-cookie": false, insecure: false}, function (error, response, data) {
          if (done || settled) return;
          if (error) return fail("翻译接口网络错误");
          var status = response && Number(response.status || response.statusCode);
          if (!(status >= 200 && status < 300)) return fail("翻译接口 HTTP " + (status || "未知"));
          try {
            var json = typeof data === "string" ? JSON.parse(data) : data;
            var result;
            if (official) {
              result = json && Array.isArray(json.translations) ? json.translations.map(function (t) { return t && t.text; }) : null;
            } else {
              if (json && json.code != null && Number(json.code) !== 200) return fail("DeepLX 返回失败状态");
              result = json && (Array.isArray(json.data) ? json.data : (typeof json.data === "string" ? [json.data] : null));
            }
            // Never infer correspondence by splitting translated paragraphs.
            if (!result || result.length !== texts.length || result.some(function (t) { return typeof t !== "string" || !t.trim() || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(t); })) return fail("译文数量或格式不符；保留该批原文");
            settled = true;
            resolve(result);
          } catch (_) { fail("翻译接口返回的 JSON 无效"); }
        });
      } catch (_) { fail("翻译接口调用失败"); }
    });
  }
  function makeJobs(items) {
    var jobs = [], batch = [], size = 0;
    // DLX's anonymous batch limit is 1500 UTF-16 code units.
    var limit = cfg.provider === "DeepL" ? 20000 : 1400;
    var count = cfg.provider === "DeepLX" ? 1 : 50;
    items.forEach(function (item) {
      // JSON-escaped ASCII/UTF-8 bytes are bounded by six times JS length.
      var cost = cfg.provider === "DeepL" ? JSON.stringify(item.text).length * 3 : item.text.length;
      if (cost > limit) { log("跳过过长的单条字幕"); return; }
      if (batch.length && (batch.length >= count || size + cost > limit)) { jobs.push(batch); batch = []; size = 0; }
      batch.push(item); size += cost;
    });
    if (batch.length) jobs.push(batch);
    return jobs;
  }
  async function worker(jobs, cursor) {
    while (!done && !halted && Date.now() < deadline) {
      var i = cursor.next++;
      if (i >= jobs.length) break;
      var batch = jobs[i], position = batch[0].position;
      var context = doc.cues.slice(Math.max(0, position - 12), position + batch.length + 12).map(function (c) { return c.text; }).join(" ").slice(0, 5000);
      try {
        var result = await requestTranslation(batch.map(function (item) { return item.text; }), context);
        if (done) return;
        batch.forEach(function (item, n) { remember(item.text, result[n].trim()); });
      } catch (error) {
        if (done) return;
        // No retry after ambiguous POST failures, quota errors or rate limits.
        // Other already-in-flight requests may still complete successfully.
        halted = true;
        log(error.message + "；停止新增请求");
      }
    }
  }
  async function main() {
    try {
      cfg = readConfig();
      if (!cfg.enabled) return finish();
      var url = typeof $request === "undefined" ? "" : String($request.url || "");
      if (!/^https:\/\/(?:[\w-]+\.)*youtube\.com\/api\/timedtext(?:\?|$)/i.test(url)) return finish();
      var response = typeof $response === "undefined" ? null : $response;
      if (!response || (response.status && Number(response.status) !== 200) || typeof response.body !== "string" || !response.body || response.body.length > 2000000) return finish("空字幕、非文本或过大响应，保留原文");
      if (query(url, "tlang")) return finish("请选择原语言字幕，关闭 YouTube 自带自动翻译");
      var language = query(url, "lang").toUpperCase().replace(/_/g, "-");
      if (language === cfg.target || (cfg.target === "ZH" && /^ZH(?:-|$)/.test(language))) return finish("字幕已为目标语言");
      doc = parseBody(response.body);
      if (!doc || !doc.cues.length) return finish("未识别到可翻译的 json3 / XML / WebVTT 字幕");
      scope = fingerprint(["v1", cfg.provider, cfg.url, fingerprint(cfg.key), cfg.target, cfg.source, language,
        query(url, "v"), cfg.context, cfg.namespace].join("|"));
      if (cfg.cache) store = readStore();
      var seen = Object.create(null), items = [], chars = 0, limited = false;
      doc.cues.forEach(function (cue, position) {
        if (seen[cue.text]) return;
        seen[cue.text] = true;
        var tr = cached(cue.text);
        if (tr) { translations[cue.text] = tr; return; }
        if (chars + cue.text.length > cfg.maxChars) { limited = true; return; }
        chars += cue.text.length;
        items.push({text: cue.text, position: position});
      });
      if (limited) log("超过字符上限的字幕保留原文；可在插件参数调大上限");
      var jobs = makeJobs(items);
      if (!jobs.length) return finish();
      deadline = Date.now() + cfg.budget;
      setTimeout(function () { finish("达到等待时限，返回已完成译文"); }, cfg.budget);
      var workers = [], cursor = {next: 0};
      for (var n = 0; n < Math.min(cfg.concurrency, jobs.length); n++) workers.push(worker(jobs, cursor));
      await Promise.all(workers);
      finish();
    } catch (error) {
      // Do not print unknown Error objects; they may contain endpoint secrets.
      log("配置或字幕处理失败；检查参数、字幕格式及脚本版本");
      finish();
    }
  }
  main();
})();
