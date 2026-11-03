# YouTube DeepL 字幕翻译（Loon）

在 Loon 中拦截 YouTube 原语言字幕，调用 DeepL 翻译并显示双语或纯译文。默认使用 **DeepL API Free**，支持自定义 API 完整地址。

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
3. 在插件参数中按下表配置 DeepL API Free。
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

## 自定义接口

`api_url` 会原样使用，包含路径和查询参数；脚本不会自动拼接 `/v2/translate` 或 `/translate`。

- `DeepL`：官方 API 或兼容官方协议的自建服务。发送 `text: string[]`，读取 `translations[].text`，使用 `Authorization: DeepL-Auth-Key …`。对于不支持 `context` 的兼容接口，关闭“附带上下文”。
- `DeepLX`：逐条发送 `text: string`，读取 `data: string`；填写 Token 时使用 `Authorization: Bearer …`。逐条请求的速度受字幕数量影响。
- `DeepLX-Batch`：仅适用于支持数组请求和响应的 DeepLX/DLX 服务；发送 `text: string[]`，读取 `data: string[]`。传统单条接口请使用 `DeepLX`。

## 行为和限制

- 支持 `youtube.com/api/timedtext` 返回的 JSON3、YouTube XML（srv3/srv1）和 WebVTT 文本字幕。保留字幕事件或字幕块的开始时间和时长；译文不保留原有逐词时间偏移或文字样式。
- 不生成原视频不存在的字幕，不处理 protobuf、画面内嵌字幕，也不保证所有 YouTube 客户端版本都使用可拦截的字幕请求。优先在 Safari 的 YouTube 网页测试。
- 收到带 `tlang` 的 YouTube 自动翻译请求时保留原文，避免把它的译文再次翻译。
- 先按字幕条目去重；DeepL 请求每批最多 50 条，并附带相邻字幕作为上下文。仍然按原字幕条目对应译文，不重新识别语音或重做字幕断句。
- 默认每次最多翻译 60000 个去重后的字幕字符、等待最多 45 秒。达到限制或发生接口错误时，已完成的译文仍会返回，其余字幕保留原文。不会自动重试失败的 POST 请求。
- YouTube 可能一次返回整段字幕，因此加载视频时可能消耗整段字幕的 API 字符额度。这里的 `max_chars` 是处理上限，不等同于 DeepL 的计费字符统计。
- 开启本地缓存后，在接口、语言、密钥和视频等配置相同的情况下复用译文。缓存会受容量和七天未使用时限限制；修改“缓存版本”可绕过已有缓存。
- 字幕及部分相邻字幕会发送到你配置的翻译接口。脚本日志不输出 API Key、带签名的 YouTube 地址或字幕正文。

## 检查问题

- **没有脚本日志**：检查插件、MitM、域名匹配及是否确实发出了 `/api/timedtext` 请求；其他字幕插件可能先匹配同一请求。
- **提示选择原语言字幕**：关闭 YouTube 的自动翻译，选择源语言字幕并重新加载。
- **HTTP 403 / 456**：查看 DeepL 账号的密钥、产品类型与额度；不要把 API Pro 密钥配到 API Free 地址。
- **HTTP 429 或超时**：降低并发、检查接口网络；旧 DeepLX 可选并发 1，长字幕优先用批量接口。
- **部分字幕没有译文**：检查日志里的字符上限、接口错误或等待时限记录。

## 本地验证

需要 Node.js 18 或更新版本，无需安装依赖：

```sh
npm test
```

目前包含 43 项模拟测试，覆盖字幕解析与转义、时间轴、接口协议、批量限制、缓存、鉴权失败、限流、并发、超时及原文回退。**尚未在真实 iPhone/Loon 和真实 DeepL 密钥下端到端验证。**

## 参考

- Loon 插件：`https://nsloon.app/docs/Plugin/`
- Loon Script：`https://nsloon.app/docs/Script/script_v2/`
- Loon Script API：`https://nsloon.app/en/docs/Script/script_api/`
- DeepL API：`https://developers.deepl.com/api-reference/translate`
