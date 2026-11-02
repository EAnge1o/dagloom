<div align="center">

[![CI](https://github.com/EAnge1o/dagloom/actions/workflows/ci.yml/badge.svg)](https://github.com/EAnge1o/dagloom/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dagloom)](https://www.npmjs.com/package/dagloom)
[![Node](https://img.shields.io/node/v/dagloom)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/runtime%20deps-0-orange)](package.json)

# 🧵 dagloom — 编码 agent 的工作流织机

**把 shell 命令和 agent 任务织成一张 DAG：能并行的并行 · 失败指数退避重试 · 断了随时续跑 · 跑完交一份报告。**

*零运行时依赖 · Node ≥ 20 · Windows / macOS / Linux*

[English](README.en.md) | 中文

</div>

---

## 为什么

让 agent 或脚本干正经活，真正的瓶颈从来不是单个命令，而是**命令之间的编排**：

- `&&` 链串行执行，快任务永远在等慢任务；
- Make 写依赖没问题，但任务里混 agent prompt 就拧巴，断点续跑、重试、并发上限统统没有；
- cron / bash 循环不知道"哪一步成功过"，半夜崩了早上只能从头再来；
- 专业编排平台（Temporal / Airflow / n8n）很强大，但要起服务、写 YAML、装一堆依赖——跑一个本地流水线不值得。

**dagloom 是这条谱系的最小补丁**：一个 markdown 文件声明任务和依赖，一条命令织起来，状态落在本地 `.loom/`，Ctrl+C 杀了都能从断点续跑。它是 [argus-night](https://github.com/EAnge1o/argus-night)（守夜人：单个 agent 线性清单跑一晚）的进化位——**argus 管"一个人加班"，dagloom 管"一个团队协作"**，两者可以叠着用：

```bash
argus-night run --until 07:00 --wrap-up "dagloom run"
```

## 30 秒上手

```bash
npx dagloom init        # 生成 loom.md 模板
# …把模板里的命令换成你的
npx dagloom validate    # 语法、依赖、环，一次性查完
npx dagloom graph       # 先看一眼 DAG 长什么样
npx dagloom run         # 织！
```

运行起来是这样：

```
02:01:32 ▶ install
02:01:33 ✓ install 190ms
02:01:33 ▶ build
02:01:33 ▶ lint
02:01:34 ✓ lint 817ms
02:01:34 ✓ build 1.2s
02:01:34 ▶ test
✗ test exit 1 — retrying in 1s
02:01:36 ▶ test (attempt 2)
02:01:36 ✓ test 390ms

🧵 dagloom · run 0fb8c96d
  ✓ install     1.7s  ok
  ✓ build       1.2s  ok
  ✓ lint       817ms  ok
  ✓ test       390ms  ×2 · ok
  ✓ report     198ms  ok

5 tasks · 5 done · task time 4.3s
```

## 工作流格式：一个 markdown 文件

`loom.md` 就是普通 markdown——人能读，**LLM 能直接读写**（这是选 markdown 而不是 YAML 的核心理由：agent 原生会写 markdown，不需要先学一套 schema）。

````markdown
## loom

concurrency: 4
fail_fast: false

## install

装依赖。这段散文是任务说明，会被存进报告。

cmd: npm ci

## build

depends: install
retry: 2
timeout: 300
cmd: npm run build

## smoke-test

用 ```sh 围栏块写多行脚本：

depends: build
```sh
set -e
node scripts/smoke.js
node scripts/probe.js
```

## refactor-utils

任务也可以是一句 agent prompt（自动探测 claude / codex / gemini）：

depends: build
timeout: 1800
agent: 把 src/utils.ts 拆成三个模块，跑通测试后提交
````

### 任务字段（全部可选，除命令本身）

| 字段 | 默认 | 说明 |
|---|---|---|
| `cmd:` | — | shell 命令；```` ```sh ```` 围栏块等价于多行 `cmd` |
| `agent:` | — | agent prompt，总是作为最后一个参数传给 CLI |
| `agent_cmd:` | 自动探测 | 覆盖 agent CLI 及其参数（如 `claude --model sonnet`） |
| `depends:` | 无 | 依赖任务（id、标题原文都行），逗号分隔 |
| `retry:` | 0 | 额外重试次数 |
| `backoff:` | 2 | 退避基数（秒），第 n 次失败等 `backoff × 2^(n-1)`，上限 10 分钟 |
| `timeout:` | 无 | 超时秒数，到点杀整棵进程树 |
| `allow_fail:` | false | 失败照记，但下游照常跑（报告里标 ⚠） |
| `outputs:` | 无 | 成功后必须存在的文件，缺了算失败（outputs 门禁） |
| `env:` | — | 任务级环境变量，`K=V, K2=V2` |
| `cwd:` | 工作流目录 | 任务工作目录（相对路径） |
| `id:` | 标题 slug | 覆盖任务 id |

`## loom` 保留段放全局设置：`concurrency`（默认 4）、`fail_fast`、`agent_cmd`、`env`、`task_timeout`。

### 命令

| 命令 | 作用 |
|---|---|
| `init [file]` | 生成模板（`--force` 覆盖） |
| `validate [file]` | 语法 + 依赖 + 环检测，带行号报错（别名 `lint`） |
| `list [file]` | 任务清单：依赖、重试/超时/allow_fail 标记 |
| `graph [file]` | ASCII 画 DAG，有运行状态时带状态点 |
| `run [file]` | 执行；**默认续跑上次**，`--fresh` 从头来 |
| `status [file]` | 当前/上次运行状态（`--json` 可机读） |
| `clean [file]` | 删掉 `.loom/` 状态与日志 |

### run 的旗标

```bash
dagloom run --fresh                  # 忽略历史，全部重跑
dagloom run --only deploy            # 只跑 deploy 及其依赖
dagloom run --skip lint              # 这轮跳过 lint（下游级联跳过）
dagloom run --concurrency 8          # 并发上限
dagloom run --fail-fast              # 第一个硬失败就全线取消
dagloom run --dry-run                # 只打印波次计划，不执行
dagloom run --env CI=1 --quiet       # 注入环境变量 / 静默模式
dagloom run --json                   # 机器可读结果
dagloom run --verbose                # 实时透传任务输出
```

## 断点续跑是怎么工作的

状态落在 `.loom/state/<工作流名>.json`（每次任务状态变化原子写盘）+ `.loom/logs/<工作流名>/<任务>.log`（每次尝试的完整输出）：

- **done 的任务不再跑**——续跑只补没完成的；
- **failed 的任务重试**——重试预算重新计；
- **你改了某个任务的命令**——按内容哈希检测到编辑，只重跑改过的那个，其他结果保留；
- **删了 / 加了任务**——报告里注明 removed / added；
- **级联跳过的任务**——依赖恢复成功后自动复活；`--skip` 的用户选择则保持粘性；
- **Ctrl+C / 断电 / 终端被关**——running 的任务标记 cancelled，下次 `run` 从断点继续。

## 与 argus-night、tape 三件套的关系

这套工具合起来是一台完整的"飞行记录仪 + 驾驶舱"：

| 项目 | 管什么 |
|---|---|
| [argus-night](https://github.com/EAnge1o/argus-night) | 单 agent 整夜值守：配额续跑、心跳看门狗、晨报 |
| **dagloom**（本项目） | 多任务 DAG 编排：并行、重试、断点、报告 |
| [tapedeck](https://github.com/EAnge1o/tapedeck) | LLM agent 的录制回放与回归 diff |
| [mcptape](https://github.com/EAnge1o/mcptape) | MCP server 的录制回放 |
| [mocktape](https://github.com/EAnge1o/mocktape) | HTTP API 的录制回放 |

dagloom 的 agent 任务调用的是真实 CLI，所以 tapedeck 录制的东西、argus-night 的配额策略都能在 dagloom 的工作流里直接用。

## 设计原则

1. **零运行时依赖**——`node_modules` 里除了 typescript 编译器什么都没有；npm 包安装即用，没有 supply chain 面积。
2. **文件优先**——工作流是 markdown，状态是 JSON，日志是纯文本。没有数据库，没有 daemon，`rm -rf .loom` 就是完全重置。
3. **agent 原生**——LLM 会写 markdown，所以 agent 能维护自己的工作流；prompt 总是作为最后一个参数传入，任何 CLI 都接得上。
4. **无聊的技术**——`child_process.spawn`、`fs.rename`、`node:test`。没有巧妙的抽象，只有能凌晨三点跑对的代码。

## FAQ

**Q: 为什么不用 YAML？**
YAML 需要解析器（零依赖原则下得自己写，YAML 的边角陷阱够写一本书），而且 agent 写 YAML 的准确率不如 markdown。dagloom 的语法只有三条规则：`## 标题`是任务、`key: value`是字段、围栏块是脚本。

**Q: 跟 make 有什么区别？**
make 管文件时间戳，dagloom 管任务成败与断点。make 不重试、不并发控制、不存日志、不支持 agent prompt、没有 `--fresh`/`--only`/`--skip`，也不能告诉你"上次跑哪步挂了"。

**Q: 状态文件要提交进 git 吗？**
不要。`init` 之后把 `.loom/` 加进 `.gitignore`（模板注释里也提醒了）。

**Q: 同一个目录能放多个工作流吗？**
能。状态和日志按工作流文件名分桶：`loom.md` 和 `release.md` 互不干扰。

**Q: agent 任务的 prompt 里有引号/换行怎么办？**
POSIX 下原样透传（argv 直传，不经 shell）。Windows 的 `.cmd` shim 需要经过 cmd.exe，prompt 会被压成单行、双引号转义——复杂 prompt 建议写进文件让 agent 自己读。

**Q: 能在 CI 里用吗？**
能，`--json` + 退出码就是为这个准备的：0 全绿，1 有硬失败，2 用法/校验错误。

## 路线图

- [ ] `dagloom watch` — 文件变更自动重跑受影响的任务
- [ ] HTML 运行报告（单文件，零依赖生成）
- [ ] 任务级 `attempts` 保留历史（跨 run 的尝试记录）
- [ ] 远程 agent（HTTP 调用而非本地 CLI）

## 开发

```bash
npm install
npm test        # tsc + node --test，64 个用例
```

CI 覆盖 Linux / macOS / Windows × Node 20 / 22 / 24。

## License

[MIT](LICENSE) © EAnge1o
