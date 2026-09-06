# 二开内容汇总

> 覆盖范围：`ab91adb73da6807453288a6fed6630de9c038502`（不含）至当前分支 `HEAD` 的全部提交。

## 变更总览

| 提交 | 分类 | 对使用者的影响 |
| --- | --- | --- |
| `3b0691e2` | 新功能 | 新增原生 Codex 子代理持久化上下文用量查询。 |
| `751fc975` | 工作流归档 | 归档对应的 Trellis task，不改变运行时或公开接口。 |
| `0089fc09` | 发布命名迁移 | CLI 与 Core npm 包从 `@mindfoldhq/*` 迁移到 `@ybfacc/*`，并同步构建、更新检查、发布校验和内部 import。 |
| `cc7b2e92` | 发布制品完善 | 为 CLI 包补充独立 README 和 AGPL-3.0 许可证文件。 |

本分支的二开可归纳为三部分：发布到新的 npm scope、使 CLI 包可独立分发，以及新增 Codex 子代理上下文用量查询。以下内容以当前代码和上述提交为准。

## 1. npm 包作用域迁移

### 变更内容

| 原名称 | 当前名称 | 适用位置 |
| --- | --- | --- |
| `@mindfoldhq/trellis` | `@ybfacc/trellis` | CLI 安装包、根目录 workspace 过滤器、发布和更新检查。 |
| `@mindfoldhq/trellis-core` | `@ybfacc/trellis-core` | Core SDK 包，以及 CLI 对 Core 的依赖和所有内部 import。 |

- 根目录的 `build`、`test`、`lint`、`typecheck`、`release*` 脚本全部改为选择新的 workspace 包名。
- Trellis 的会话上下文脚本及其生成模板会针对 `@ybfacc/trellis` 检查更新。
- 发布脚本、迁移 manifest 连续性检查和打包校验都改为查询新 scope；打包后的 CLI 会校验自己精确依赖同版本的 `@ybfacc/trellis-core`。
- channel、task 和 mem 等 CLI 模块的 import 一并切换到新 Core 包名；这部分是依赖名迁移，不改变这些命令原有的业务语义。

### 使用与迁移示例

安装 CLI 时使用新的包名；可执行文件名保持不变，仍可使用 `trellis` 或 `tl`：

```bash
npm install -g @ybfacc/trellis
trellis --help
tl --help
```

引用 Core SDK 时也应替换 import scope：

```ts
// 旧：@mindfoldhq/trellis-core/mem
import { readCodexContextUsage } from "@ybfacc/trellis-core/mem";
```

这是包名级迁移，已安装的旧 scope 不会自动切换。依赖方应更新 `package.json`、lockfile 和 CI 中的安装命令后重新安装。

### 本地构建与发布前检查

```bash
pnpm build
pnpm test
pnpm release:check
```

项目要求 Node.js `>= 18.17.0`。CLI 发布包公开分发，并包含 `dist`、`bin`、`README.md` 和 `LICENSE`；本分支新增的 `packages/cli/README.md` 与 `packages/cli/LICENSE` 让该制品具备独立的使用说明和许可证文本。

## 2. Codex 子代理上下文用量查询

### 目的

新增一个只读查询入口，用于取得原生 Codex 子代理最近一次持久化的上下文用量：

```text
trellis mem usage <agent-id> --json
```

它帮助主代理决定是否继续、交接或拆分子代理工作，但不会读取或输出对话内容。

### 功能变更

| 层级 | 变更 | 说明 |
| --- | --- | --- |
| Core | `readCodexContextUsage(agentId)` | 按 Codex 线程 UUID 查找并投影用量数据。 |
| CLI | `trellis mem usage <agent-id> [--json]` | 以机器可读 JSON（推荐）或简要文本输出 Core 结果。 |
| 数据源 | `~/.codex/sessions` 与 `~/.codex/archived_sessions` | 同时支持活跃和已归档 rollout；同一 ID 有多个匹配文件时选修改时间最新的文件。 |
| 测试 | Core adapter 与 CLI 集成测试 | 覆盖最新事件选择、归档发现、异常状态和输出字段。 |

查询只顺序扫描选中的 JSONL rollout，并只保留最近一条
`event_msg` / `token_count` 的标量字段，因此不会把完整会话加载到内存。

### 数据契约

返回的活动上下文用量来自：

```text
payload.info.last_token_usage.total_tokens
```

`payload.info.total_token_usage.total_tokens` 是会话累计消耗，不能替代上面的活动上下文值。上下文百分比按下面的 Trellis 规则计算，而不是声称复刻 Codex 界面的显示规则：

```text
used_percentage = clamp(round(last_token_usage.total_tokens / model_context_window * 100, 2), 0, 100)
remaining_percentage = round(100 - used_percentage, 2)
```

分母为同一条事件中的 `model_context_window`；JSON 通过
`percentage` 字段公开分母、计算模式和两位小数精度。

### CLI 使用示例

`agent-id` 必须是原生 Codex 子代理的线程 UUID，不是 Trellis task 名或 rollout 文件路径：

```bash
trellis mem usage 01900000-0000-7000-8000-000000000001 --json
```

成功时的输出示例：

```json
{
  "status": "available",
  "agent_id": "01900000-0000-7000-8000-000000000001",
  "used_tokens": 250,
  "model_context_window": 1000,
  "used_percentage": 25,
  "remaining_percentage": 75,
  "percentage": {
    "mode": "model_context_window_ratio",
    "baseline_tokens": 1000,
    "decimal_places": 2
  }
}
```

在主代理的自动化逻辑中，可只在 `status` 为 `available` 时使用百分比：

```ts
import { readCodexContextUsage } from "@ybfacc/trellis-core/mem";

const usage = readCodexContextUsage(agentId);

const shouldHandoff =
  usage.status === "available" && usage.remainingPercentage < 20;

// 调用方可据此决定：交接、拆分任务，或要求子代理做阶段性总结。
```

该 Core API 使用 camelCase 字段；CLI JSON 使用 snake_case 字段。二开时应复用
Core API，不应在调用端自行解析 rollout 或读取转录内容。

### 状态处理

所有无法建立用量的情形都返回结构化状态，未知数值为 `null`，绝不会伪造为 `0`：

| `status` | 含义 | 调用方建议 |
| --- | --- | --- |
| `available` | 取得活动用量和上下文窗口。 | 可按百分比执行自身策略。 |
| `invalid_agent_id` | 标识符不是合法 Codex UUID。 | 修正输入；此时 `agent_id` 为 `null`。 |
| `rollout_not_found` | 活跃与归档目录中均没有匹配 rollout。 | 不应推断为零用量，可稍后重试。 |
| `token_count_not_found` | rollout 没有 `token_count` 事件。 | 视为当前版本无法测量。 |
| `last_token_usage_unavailable` | 最近事件缺少有效活动 token 数。 | 不使用百分比。 |
| `model_context_window_unavailable` | 最近事件缺少有效上下文窗口。 | 可保留 `used_tokens`，但不计算百分比。 |

例如，rollout 尚未写入时：

```json
{
  "status": "rollout_not_found",
  "agent_id": "01900000-0000-7000-8000-000000000001",
  "used_tokens": null,
  "model_context_window": null,
  "used_percentage": null,
  "remaining_percentage": null,
  "percentage": {
    "mode": "model_context_window_ratio",
    "baseline_tokens": null,
    "decimal_places": 2
  }
}
```

### 二开边界

- 查询没有副作用：不会修改 rollout、写入 `.trellis/.runtime/`、注册 hook、轮询子代理，或把结果注入父代理上下文。
- 输出不会包含 rollout 路径、提示词、对话、工具输入/输出或其他原始事件负载。
- 命令仅接受一个 `agent-id` 与可选的 `--json`；不支持 `--cwd`、`--global`、`--platform`、日期或 `--limit` 等 `mem` 过滤条件。
- 当前仅支持原生 Codex。若接入其他平台，应先验证其持久化用量字段，再在 Core 中新增独立 adapter 和对应测试；不要复用 Codex 的 JSONL 假设。

### 相关实现与验证

- `packages/core/src/mem/adapters/codex.ts`：rollout 发现、最新事件选择、标量投影与百分比计算。
- `packages/core/src/mem/types.ts`：公开状态及结果类型。
- `packages/cli/src/commands/mem.ts`：命令解析和 Core camelCase 到 JSON snake_case 的映射。
- `packages/core/test/mem/adapters.test.ts`：Core 的 rollout 发现、最新事件和异常状态测试。
- `packages/cli/test/commands/mem-integration.test.ts`：CLI JSON、参数限制和无副作用行为测试。
