# Changelog

## 1.1.0 — 2026-11-04

- 新增 Gemini 原生 generateContent 接口、独立 API Key 和可配置模型 ID。
- 默认一次最多合并 24000 字符 / 800 条去重字幕，严格检查 JSON 译文 ID 和条数，保持原时间轴。
- 按使用者提供的项目额度，默认配置 15 RPM、250000 TPM、500 RPD；增加本地持久化计数、分钟滑动窗口、日配额暂停及冷却记录。
- Gemini 使用串行请求、缓存和 100 秒默认总等待时限；不自动重试，不额外调用 countTokens。
- 保留现有 DeepL / DeepLX 配置，测试增加至 87 项。
- 已核对 Google 官方文档，Gemini 3.5 Flash-Lite 的模型 ID 为 `gemini-3.5-flash-lite`，可在插件参数修改；尚未使用真实密钥验证连通性。

## 1.0.0 — 2026-11-03

- 发布 DeepL / DeepLX YouTube 字幕翻译插件，支持 JSON3、YouTube XML、WebVTT、双语显示和本地缓存。
