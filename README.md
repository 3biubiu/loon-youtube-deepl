# YouTube DeepL / Gemini 字幕翻译（Loon）

在 Loon 中拦截 YouTube 原语言字幕，调用 DeepL、DeepLX 或 Gemini 翻译，显示双语或纯译文。默认保持 **DeepL API Free**；切换为 Gemini 后使用独立密钥、大批量翻译和本地配额保护。

仓库：[3biubiu/loon-youtube-deepl](https://github.com/3biubiu/loon-youtube-deepl)

插件订阅地址：

```text
https://raw.githubusercontent.com/3biubiu/loon-youtube-deepl/main/YouTube-DeepL.lpx
```

## 文件

- `YouTube-DeepL.lpx`：Loon 插件配置。
- `YouTube-DeepL.js`：翻译脚本。
- `tests/youtube-deepl.test.cjs`：使用模拟 Loon 环境及模拟 API 的本地测试。

## 安装和使用

1. 使用 Loon **3.5.1（983）或更新版本**。本插件采用该版本起支持的 Script 配置语法。
2. 在 Loon 的插件页面添加上面的订阅地址；插件已经配置本仓库脚本的完整 Raw 地址，无需单独导入 `.js`。不要使用 GitHub 的 `blob` 网页地址。
3. 在插件参数中选择 `DeepL` 或 `Gemini`，按下方对应表格填写参数。
4. 按 Loon 自身的引导完成 MitM 证书的安装与信任，并启用 MitM 和插件。
5. 打开 YouTube 视频，启用视频的**原语言字幕**，例如 English 或 English (auto-generated)。关闭 YouTube 自带的“自动翻译”，必要时重载视频使其重新获取字幕。

| 参数 | DeepL API Free 配置 |
| --- | --- |
| 启用翻译 | 开启 |
| 接口类型 | `DeepL` |
| 翻译接口完整地址 | `https://api-free.deepl.com/v2/translate` |
| API Key 或 Token | 你自己的 DeepL API Free API Key |
| 目标语言 | `ZH`；其他语言可填其 API 语言代码 |
| 原语言 | `AUTO`，或明确填写 `EN`、`JA` 等代码 |
| 字幕显示 | `bilingual` 为原文＋译文；`translation` 仅译文 |

DeepL 免费网页版账号和 DeepL API Free 是不同的产品；需要 API Free 的密钥。**只在 Loon 的插件参数中填写密钥，不要把密钥提交到 GitHub。**

## 翻译接口策略组（v1.1.1）

在插件参数的“翻译接口策略组”（`api_policy`）中，填写 Loon 中已存在的策略组或节点的完整名称，例如 `AI-API`、`美国节点` 或 `🇺🇸 美国`。名称需与 Loon 中完全一致，包括空格和表情；脚本会去除输入首尾空白，不会自动创建策略组。需要直连时可填 `DIRECT`。

填写后，DeepL、DeepLX、DeepLX-Batch 和 Gemini 的每次翻译请求都会通过 Loon `$httpClient` 的 `node` 选项指定此出口。留空时不传 `node`，沿用 Loon 当前路由。此参数只用于翻译 API 请求；视频与字幕下载继续使用它们原有的路由设置。

切换策略组不会清空译文缓存或重置 Gemini 本地配额，已有缓存命中时不会产生请求；要观察新出口，请用未缓存的视频并查看 Loon 的请求记录。策略组不存在、节点不可用或请求失败时按现有错误处理保留原字幕，不会自动改用其他策略重新发送 POST。

依据：[Loon HTTP Client 的 node 参数](https://nsloon.app/docs/Script/script_api/)。尚未在真实 iPhone/Loon 上验证该选项的实际出口；本地测试仅验证请求选项的传递。

## Gemini 配置（v1.1）

下面的默认限额来自项目使用者在 **2026-11-04** 提供的 AI Studio 数据：`Gemini 3.5 Flash Lite`，**15 RPM、250K TPM、500 RPD**。它们不是对所有 Google 账号、项目或模型的通用配额承诺；请以自己项目的 AI Studio 页面为准。

| 参数 | 默认值 / 用途 |
| --- | --- |
| 接口类型 | 选择 `Gemini` |
| Gemini API 根路径 | `https://generativelanguage.googleapis.com/v1beta` |
| Gemini 模型 ID | `gemini-3.5-flash-lite`，可修改；已核对官方模型文档 |
| Gemini API Key | 填 Google AI Studio 的密钥；与 DeepL 的 API Key 分开 |
| Gemini 每批字幕字符数 | `24000`；单批同时最多 800 条去重后的字幕 |
| Gemini 本机每日请求上限 | `500`，可调低留出其他用途的额度；`0` 为暂停新的 Gemini 调用 |
| Gemini 每分钟请求上限 | `15` |
| Gemini 每分钟 token 上限 | `250000`；使用保守估算，不额外调用 `countTokens` |
| Gemini 配额组 | `default`；同一 Google 项目的多把密钥应保持相同组名 |
| Gemini 最长等待秒数 | `100`，含限流等待和翻译；到时返回已完成的部分 |

**模型 ID 核实说明：**2026-11-04 已核对 [Google 官方模型文档](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite)，模型 ID 为 `gemini-3.5-flash-lite`。尚未使用真实 Gemini 密钥进行连通测试。如果日志提示 HTTP 404，请核对账号的模型权限、API 根路径和实际可用的模型 ID；脚本不会自动切换到其他模型。

AI Studio 的 `usage` 链接是网页，不是 API 地址，不能填入 API 根路径。脚本实际调用：

```text
POST https://generativelanguage.googleapis.com/v1beta/models/<模型ID>:generateContent
```

密钥通过 `x-goog-api-key` 请求头发送，不放在 URL 查询参数里；不会把 DeepL 的密钥当作 Gemini 密钥使用。

### 如何减少每日调用次数

- 将一批字幕作为一个请求，要求返回带 ID 的 JSON 译文。600 条较短字幕可以合为一次请求；更长的字幕按字符数或 800 条边界分成几个大批次，而不是逐条请求。
- 先去重、读取本地缓存，再对缺少译文的条目分批。已有缓存不消耗本地请求额度。
- Gemini 始终串行；默认总字符处理上限仍是 `max_chars=60000`。每次最多处理到该上限，超出部分保留原文。
- 请求失败、输出截断、缺失或重复 ID 时不自动重试，也不拆成大量小请求“修复”；相应批次保留原文，避免额外消耗次数。输出截断后，可自行降低下一次的每批字符数。
- 输出 ID 经校验后才对应回原字幕事件。即使模型返回顺序不同，也不会靠换行猜测对应关系；不完整或重复 ID 的整个批次不会应用。

### 本地配额的边界

- 发送 POST 前，先持久化计数，因此超时或网络失败也会保守地占用一次本地名额，不在结果不明时退回计数。
- 每日计数按美国太平洋时间换日，并处理夏令时。分钟限额使用跨脚本运行的 60 秒滑动窗口。
- TPM 预算按序列化请求的 UTF-8 字节数加最大输出 token 数 `32768` 作保守估算；它不是 Google 返回的精确 token 使用量，可能比实际消耗高，从而提早等待。
- 服务端返回 429 后立即停止当前运行新增请求，保存冷却时间；明确识别出日配额错误时，保存当天暂停状态。不会同次自动重试。
- Google 项目在其他设备、其他应用的调用无法从此插件统计；多个 Loon 脚本同时启动时，本地读写也不是跨进程的原子配额服务。**这里是尽力保护，不能保证不会收到服务端 429。**
- 更换同一项目的密钥不会重置本地配额；更换模型或确实使用不同项目时才使用对应的模型和配额组。不要通过改组名绕过项目真实限额。
- 本地计数读写损坏或失败时停止发出新的 Gemini 请求。翻译缓存和配额记录互相独立，关闭翻译缓存不会关闭配额保护。

## DeepL / DeepLX 自定义接口

`api_url` 会原样使用，包含路径和查询参数；脚本不会自动拼接 `/v2/translate` 或 `/translate`。

- `DeepL`：官方 API 或兼容官方协议的自建服务。发送 `text: string[]`，读取 `translations[].text`，使用 `Authorization: DeepL-Auth-Key …`。对于不支持 `context` 的兼容接口，关闭“附带上下文”。
- `DeepLX`：逐条发送 `text: string`，读取 `data: string`；填写 Token 时使用 `Authorization: Bearer …`。逐条请求的速度受字幕数量影响。
- `DeepLX-Batch`：仅适用于支持数组请求和响应的 DeepLX/DLX 服务；发送 `text: string[]`，读取 `data: string[]`。传统单条接口请使用 `DeepLX`。

## 行为和限制

- 支持 `youtube.com/api/timedtext` 返回的 JSON3、YouTube XML（srv3/srv1）和 WebVTT 文本字幕。保留字幕事件或字幕块的开始时间和时长；译文不保留原有逐词时间偏移或文字样式。
- 不生成原视频不存在的字幕，不处理 protobuf、画面内嵌字幕，也不保证所有 YouTube 客户端版本都使用可拦截的字幕请求。优先在 Safari 的 YouTube 网页测试。
- 收到带 `tlang` 的 YouTube 自动翻译请求时保留原文，避免把它的译文再次翻译。
- 先按字幕条目去重；DeepL 请求每批最多 50 条，并附带相邻字幕作为上下文。仍然按原字幕条目对应译文，不重新识别语音或重做字幕断句。
- 默认每次最多翻译 60000 个去重后的字幕字符。DeepL / DeepLX 默认最长等待 45 秒，Gemini 默认 100 秒。达到限制或发生接口错误时，已完成的译文仍会返回，其余字幕保留原文。不会自动重试失败的 POST 请求。
- YouTube 可能一次返回整段字幕，因此加载视频时可能消耗整段字幕的 API 字符额度。这里的 `max_chars` 是处理上限，不等同于 DeepL 的计费字符统计。
- 开启本地缓存后，在接口、语言、密钥和视频等配置相同的情况下复用译文。缓存会受容量和七天未使用时限限制；修改“缓存版本”可绕过已有缓存。
- 字幕及上下文会发送到你配置的翻译接口。脚本日志不输出 API Key、带签名的 YouTube 地址或字幕正文。

## 检查问题

- **没有脚本日志**：检查插件、MitM、域名匹配及是否确实发出了 `/api/timedtext` 请求；其他字幕插件可能先匹配同一请求。
- **提示选择原语言字幕**：关闭 YouTube 的自动翻译，选择源语言字幕并重新加载。
- **HTTP 403 / 456**：查看 DeepL 账号的密钥、产品类型与额度；不要把 API Pro 密钥配到 API Free 地址。
- **HTTP 429 或超时**：降低并发、检查接口网络；旧 DeepLX 可选并发 1，长字幕优先用批量接口。
- **Gemini HTTP 404**：核对模型的实际 API ID、模型权限和 API 根路径；不要将模型的网页显示名称直接当成 ID。
- **Gemini HTTP 429**：确认 AI Studio 中该项目的剩余 RPD、RPM、TPM；不要因其他工具占用配额而提高本地上限。等待服务端冷却或日额度重置。
- **Gemini 原文回退且无新请求**：检查日志，可能是本地配额保护、分钟等待超过本次时限，或配额记录读写失败。
- **部分字幕没有译文**：检查日志里的字符上限、接口错误或等待时限记录。

## 本地验证

需要 Node.js 18 或更新版本，无需安装依赖：

```sh
npm test
```

目前包含 96 项模拟测试，覆盖字幕解析与转义、时间轴、接口协议、大批量和 ID 校验、缓存、鉴权失败、限流、并发、超时、配额持久化、太平洋换日、夏令时边界及翻译接口策略组的传递与默认行为。**尚未在真实 iPhone/Loon 和真实 DeepL / Gemini 密钥下端到端验证。**

## 参考

- Loon 插件：`https://nsloon.app/docs/Plugin/`
- Loon Script：`https://nsloon.app/docs/Script/script_v2/`
- Loon Script API：`https://nsloon.app/en/docs/Script/script_api/`
- DeepL API：`https://developers.deepl.com/api-reference/translate`
- Gemini 模型：`https://ai.google.dev/gemini-api/docs/models`
- Gemini 限额：`https://ai.google.dev/gemini-api/docs/rate-limits`
- Gemini REST：`https://ai.google.dev/api/generate-content`
- Gemini 结构化输出：`https://ai.google.dev/gemini-api/docs/structured-output`
