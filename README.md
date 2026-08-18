# imchat — DeepSeek Harness IM 联通插件

通过 IM 与你的 DeepSeek Harness (DSH) agent 对话:在 **Matrix、飞书 (Feishu)、微信 (WeChat)** 里收发消息,全部经 DSH 的 agent 引擎处理,回复发送回原会话。

> **架构理念**:imchat 不是一个独立服务,而是一个 **DSH profile 插件**。它直接复用 DSH 的 agent / session / LLM 基础设施——每种 IM 会话映射到一个 **专属 DSH agent**(互相隔离、可持久化),模型调用、工具、上下文压缩全部走 DSH 原生能力。这让「桥接」不需要第三方的 agent 运行时。

## 能力总览

| 平台 | 接入方式 | 状态 |
|---|---|---|
| Console | 标准输入/输出(演示 & 自测) | ✅ 可用 |
| Matrix | 账号直连 + `/sync` 长轮询(Client-Server API) | ✅ 可用 |
| 飞书 | 官方 SDK 长连接推送(免公网回调) | ✅ 可用 |
| 微信 | 腾讯官方 ilink 协议(扫码登录 + 长轮询,免 wechaty) | ✅ 可用 |

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

- `[console]` 是默认适配器:DSH 进程启动时会消费管道 stdin,因此 console 长驻模式主要用于**验证启动流程**(三平台为网络长驻,不受影响);完整的 agent 收发闭环请用 `--self-test` 或任一真实平台验证。

## 各适配器配置

配置位置:`~/.dsh/profiles/imchat/cordis.patch.yml` 里覆盖 `imchat` 行的 `config.platforms`。

### 通用结构

```yaml
- id: imchat
  config:
    adapters: [console]            # 要启用的适配器列表
    platforms:                     # 各平台凭据/配置,key = 适配器 id
      wechat: { }
      matrix: { }
      feishu: { }
```

> 启用真实平台时把 `adapters` 列表改为对应 id(如 `[wechat, matrix]`),并在 `platforms` 下填凭据。留空则微信走二维码登录提示、Matrix/飞书按无凭据容错启动(日志可见)。

### 固定工作区

所有平台的会话共享一个**固定的 agent 工作目录**,对话产生的文件、上下文都在同一区域,可配置:

```yaml
- id: imchat
  config:
    # 可选;默认 <cwd>/.imchat-workspace
    workspaceDir: /srv/imchat-workspace
```

工作区会在启动时自动创建;每个会话的 DSH agent 都在该目录下运行(而非散落的 `process.cwd()`)。

### 微信接入

微信走 **腾讯官方 ilink 机器人协议**(与 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 相同的后端接口),**不需要 wechaty、不需要服务器回调**——扫码登录后由我们后台长轮询收消息。

1. 配置账号(可不填 token,首次运行会提示扫码登录):

```yaml
- id: imchat
  config:
    adapters: [wechat]
    platforms:
      wechat:
        # 可选:预置 token;不填则首次运行打印二维码扫码登录
        # token: ""
```

2. 运行 `dsh --profile imchat`,终端打印二维码 → 手机微信「扫一扫」确认。登录后 token/baseUrl/cursor 保存在 `<仓库>/state/wechat-<账号>.json`,无需重复登录。
3. 微信用户给你这个机器人发消息 → agent 处理 → 回复相同会话。
4. 在飞的多账号:可用 `accounts` 数组(见源码 `adapter.js`),每个账号独立 cursor/上下文。

> 已知限制:仅文本消息(v1);图片/语音/文件发收为后续迭代。

### Matrix 接入

通过 **Matrix Client-Server API** 以原生账号直连,长轮询 `/sync`,无需申请 AppService。

1. 先为机器人创建一个 Matrix 账号(例如在 matrix.org)。
2. 配置:

```yaml
- id: imchat
  config:
    adapters: [matrix]
    platforms:
      matrix:
        homeserver: https://matrix.org
        userId: "@mybot:matrix.org"
        password: "..."          # 首次登录;之后 token 会持久化
        # accessToken: "..."     # 也可以直接给 token,跳过密码登录
```

3. 把你的机器人账号拉进房间(或让用户私聊机器人)。机器人收到消息后会回复。
4. token 与 `/sync` cursor 保存在 `<仓库>/state/matrix-<账号>.json`,重连时从上次断点续收。

> 说明:个人常驻使用选择「原生账号 + /sync」而非 AppService——免去注册文件的部署复杂度。若之后需要托管多用户机器人再做 AppService 升级。

### 飞书接入

使用 **飞书官方 Node SDK 的长连接(WebSocket)模式**——**不需要公网 IP/域名/webhook 回调**,适合个人常驻服务器。

1. 在[飞书开放平台](https://open.feishu.cn/)创建企业自建应用,开启权限:
   - `im:message`(获取与发送单聊、群组消息)
   - `im:message.group_at_msg`(群 @机器人 消息)
   - 事件订阅选择「长连接」方式,添加事件 `im.message.receive_v1`(接收消息)。
2. 配置:

```yaml
- id: imchat
  config:
    adapters: [feishu]
    platforms:
      feishu:
        appId: "cli_xxx"
        appSecret: "xxx"
```

3. 启动 `dsh --profile imchat`,机器人建立长连接,收到消息 → agent 处理 → 回复(走 `im/v1/message/reply` 同会话回复)。
4. 凭据会持久化到 `<仓库>/state/feishu-<账号>.json`;SDK 内置断线重连。

> 提示:飞书长连接限制「收到消息 3 秒内完成处理,否则触发超时重推」。imchat 的消息处理是异步的,不会阻塞长连接 ACK;若你的 agent 超时,平台会重推,桥会去重(见下)。

### 平台细节与去重

- 所有平台会话映射:每个 `(platform, account, conversationKey)` → 唯一 DSH session id(`sha1` 派生,会话隔离)。
- 会话**串行**处理;重启后 resume 持久会话,不丢上下文。
- 平台推送可能重试:长连接重推 / 微信 getUpdates 重启后会从 cursor 续收—天然幂等,重复消息仅当恢复时刻重叠可能出现,可在后续版本加 `message_id` 去重缓存。

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
    state-store.js     # 凭据/游标持久化
    matrix/            # Matrix(/sync 直连)
    feishu/            # 飞书(官方 SDK 长连接)
    wechat/            # 微信(ilink 官方协议)
tests/                 # vitest 单测
docs/plans/            # 设计文档
```

## License

MIT
