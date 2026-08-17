# imchat — DeepSeek Harness IM 联通插件

通过 IM 与你的 DeepSeek Harness (DSH) agent 对话:在 **Matrix、飞书 (Feishu)、微信 (WeChat)** 里收发消息,全部经 DSH 的 agent 引擎处理,回复发送回原会话。

> **架构理念**:imchat 不是一个独立服务,而是一个 **DSH profile 插件**。它直接复用 DSH 的 agent / session / LLM 基础设施——每种 IM 会话映射到一个 **专属 DSH agent**(互相隔离、可持久化),模型调用、工具、上下文压缩全部走 DSH 原生能力。这让「桥接」不需要第三方的 agent 运行时。

## 能力总览

| 平台 | 接入方式 | 状态 |
|---|---|---|
| Console | 标准输入/输出(演示 & 自测) | ✅ 可用 |
| Matrix | 账号直连 + `/sync` 长轮询(Client-Server API) | 🚧 开发中 |
| 飞书 | 官方 Bot API + 长连接推送 | 🚧 开发中 |
| 微信 | 腾讯官方 ilink 协议(扫码登录 + 长轮询,免 wechaty) | 🚧 开发中 |

## 快速开始

### 1. 安装到 DSH profile

```sh
# 从本仓库目录
dsh plugin --profile imchat add /路径/到/imchat
```

这会初始化 `~/.dsh/profiles/imchat` 并把本插件作为 bundle 接入。

### 2. 自测(全链路验证)

```sh
dsh --profile imchat --self-test "Reply with exactly: IM-BRIDGE-OK"
# 期待输出: IM-BRIDGE-OK
```

`--self-test` 走完整链路:会话 → agent 驱动 → 模型回复 → 输出,然后退出。这是安装后的冒烟测试。

### 3. 配置要启动的适配器

编辑 `~/.dsh/profiles/imchat/cordis.patch.yml`,覆盖 `imchat` 行的 `adapters` 数组。默认 `[console]`。

```yaml
# 例如:仅启用微信 + 飞书
- id: imchat
  config:
    adapters: [wechat, feishu]
```

各适配器的具体配置见下文对应章节。

### 4. 常驻运行

```sh
dsh --profile imchat
```

长驻模式需要你为部署的适配器提供凭据;进程保持存活,不需要 TTY(可用 launchd / systemd / Docker 托管)。

## 架构

```
┌─ DeepSeek Harness core ─────────────────────────────┐
│  agents · agent-loop · sessions · llm · tools       │
└─────────────────────────────────────────────────────┘
        ▲ followup / whenIdle / session.event
        │
┌─ imchat (DSH profile bundle) ───────────────────────┐
│  bridge core (src/lib/bridge.js)                    │
│    · per-conversation AgentDriver(会话隔离=S5)       │
│    · 串行队列(每会话单并发)                          │
│    · 确定性 session id + resume 持久化              │
│  adapters (src/adapters/*)                          │
│    console / matrix / feishu / wechat               │
└─────────────────────────────────────────────────────┘
```

## 会话隔离与持久化

- 每个 `(platform, account, conversationKey)` 组合映射到一个确定的 DSH session id(`sha1` 派生)。
- 有可用会话持久化(本 bundle 挂载 JSONL backend)时,新进程会 **resume** 已存在的会话,而不是重建——重启后历史保留,会话不串。
- 每个会话 driver 内部**串行**处理消息(单 LLM 并发),避免同一会话消息乱序。

## 各适配器配置

- [Matrix 接入](#)
- [飞书接入](#)
- [微信接入](#)

(各节由对应适配器文档补全)

## 开发

```sh
pnpm install
pnpm vitest run        # 单元测试
```

单元测试覆盖:桥核心工具(`splitText` 等)、各适配器的 wire 层(mock fetch/WebSocket)。

## 目录结构

```
src/
  index.js             # CLI 入口 & 适配器注册
  lib/
    bridge.js          # 桥核心(会话隔离 + agent 驱动)
    utils.js           # 共享工具(splitText/backoff/id)
  adapters/
    console.js         # 演示适配器
    matrix/            # Matrix(开发中)
    feishu/            # 飞书(开发中)
    wechat/            # 微信(开发中)
tests/                 # vitest 单测
docs/plans/            # 设计文档
```

## License

MIT
