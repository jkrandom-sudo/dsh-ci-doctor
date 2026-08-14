# dsh-ci-doctor

[English](./README.md) · [npm](https://www.npmjs.com/package/dsh-ci-doctor) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

**CI 失败了？诊断结果在你打开日志之前就已经就绪。** `dsh-ci-doctor` 监视 GitHub Actions 的新失败，把原始作业日志变成结构化发现 —— 归一化错误签名、失败分类、嫌疑文件、裁剪后的日志摘录 —— 并记住它见过的每一个签名，老问题复发时一眼认出。全部通过两个 agent 工具和你本机已登录的 `gh` CLI 完成。

## 使用方法

直接用自然语言向 agent 提问即可，它会自动选对工具：

- _「帮我盯着这个仓库的 CI，挂了告诉我」_ → 启动 `ci_watch` 后台监视作业。
- _「 nightly 构建为什么挂了？」_ → 对最近一次失败运行执行 `ci_diagnose`，直接给出诊断卡。
- _「诊断一下 cli/cli 的 31782742089 这次运行」_ → 针对指定运行的定向诊断。

诊断卡会以 markdown 形式直接出现在对话里：

```markdown
## CI diagnosis: cli/cli run #31782742089

**Conclusion:** failure · [run](https://github.com/cli/cli/actions/runs/31782742089)

### Job: Issue Triage (skills-driven)

**Failed steps:** triage
**Signatures:**

- `81a0edf32878` (timeout, first time seen) — server:http_server Session timeout configured…
  **Suspect files:** `script/triage.ts`

<details><summary>Log excerpt</summary>
…
</details>
```

## 功能

**1. 监视 —— `ci_watch` 工具。** 启动一个后台作业，轮询*新增*的失败运行（首次轮询建立基线，历史红色运行永远不会误报）：

```json
{ "repo": "owner/name", "branch": "main", "intervalSeconds": 30, "timeoutMinutes": 60 }
```

- 状态行随时可读，随时可取消。
- 瞬时错误指数退避，连续 5 次失败放弃，认证错误立即失败。
- 发现新失败时以现成的下一步收尾：`call ci_diagnose with repo="…" runId=…`。
- 显式指定仓库，或省略 `repo` 监视当前工作目录所在仓库。

**2. 诊断 —— `ci_diagnose` 工具。** 指定一个运行（或默认取最近一次失败运行），返回上面那张诊断卡：

```json
{ "repo": "owner/name", "runId": 31782742089 }
```

- 错误签名经过归一化（掩码时间戳、十六进制 id、数字），同一个失败在不同运行中得到同一个 id。
- 每个签名自动分类：test / build / lint / typecheck / dependency / network / permission / timeout / infra。
- 从日志中挖掘嫌疑文件，自动剔除 vendor 路径。
- 日志摘录按预算裁剪，插入诚实的 `… (skipped N lines) …` 标记 —— 绝不编造内容。

**3. 失败签名账本。** 每个诊断过的签名都会被记住 —— 见过几次、首次/最近出现时间、最近的仓库和运行链接。复发问题在报告里显示为 `seen 3×`，而不是伪装成新问题。宿主提供 storage domain 时账本持久化为 DSH 存储目录下的 `ci_doctor` 存储单元，否则为内存账本。

## 只读契约

两个工具只*读取* GitHub 状态（通过 `gh api`），绝不 push、合并、取消、重跑，也不写仓库里的任何东西。每个结果都携带 `repositoryWrites: false` 标记；包内还附带一个可选的 invariant 伴随插件（`dsh-ci-doctor/invariant`），在带 `invariants` 服务的宿主上，一旦结果丢失该标记就会立即报错。

## 安装

```bash
dsh plugin --profile web add dsh-ci-doctor
```

前置要求：已登录的 [GitHub CLI](https://cli.github.com/)（`gh auth login`）—— 插件直接复用该会话，无需任何额外配置。

## 配置项

| 选项                  | 默认值 | 含义                                    |
| --------------------- | ------ | --------------------------------------- |
| `pollIntervalSeconds` | `30`   | 监视轮询间隔秒数（最小 5）。            |
| `watchTimeoutMinutes` | `60`   | 单个监视的存活时长（分钟，最小 1）。    |
| `maxLogLines`         | `200`  | 每个作业的日志摘录行数预算（最小 20）。 |
| `ghBin`               | `gh`   | GitHub CLI 可执行文件。                 |
| `ledgerEnabled`       | `true` | 是否把签名记入账本。                    |

## 工作原理

插件只通过文档化的 Cordis 接缝与宿主交互，不 import 任何 `@deepseek-ai/*` 包：

- `tools` —— 在真实工具运行时上注册 `ci_watch` / `ci_diagnose`。
- `jobs` —— `ci_watch` 作为一等流式后台作业运行，归属发起调用的 agent。
- `shell` —— 所有 `gh` 调用都走宿主受防护、带沙箱的执行管线。
- `storageDomain` —— 签名账本持久化为 `ci_doctor` 存储单元。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build   # 类型、单元测试、打包
pnpm format:check                           # Prettier
```

## 许可证

MIT
