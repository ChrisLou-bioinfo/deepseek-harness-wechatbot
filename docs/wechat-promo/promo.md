# 把 DeepSeek Harness 装进你的微信：开源 IM 联通插件上手

> 让你的 agent 在微信、飞书、Matrix 里随叫随到。**无需 wechaty、无服务器回调、纯官方协议**。

---

## 先给你看效果

把插件装进 DeepSeek Harness 之后，你在**微信里直接给机器人发消息**，消息会进入你的 DSH agent 处理，回复发回同一个对话。

就这么简单——不用打开网页、不用切窗口，你在哪，agent 就在哪。

## 为什么值得装

最近做了一点「偷懒但正经」的事：给 DeepSeek Harness 开发了一个 IM 联通插件，把 **微信、飞书、Matrix** 三种 IM 和 DSH agent 桥接起来。选型上有三个坚持：

1. **微信走腾讯官方 ilink 协议**，不是 wechaty——稳定、不依赖第三方 puppet、扫码即登录；
2. **飞书走官方 SDK 长连接**，**不需要公网 IP / 域名 / webhook 回调**，个人常驻服务器即可；
3. **Matrix 走标准 Client-Server API 长轮询**，免 AppService 注册文件的部署复杂度。

说白了：**接入每种 IM，都用它家最「正经」的方式来**。

## 核心能力

- **在 IM 里与 agent 对话**：微信 / 飞书 / Matrix 收消息 → DSH agent 处理 → 回复原对话
- **按会话隔离**：每个会话映射独立 DSH agent，互不串扰
- **会话持久化**：重启后恢复上下文，对话不丢
- **固定工作区**：对话全程在一个可配置的工作目录里进行，产出的文件都在同一处
- **常驻轻量**：单进程托管，不需要额外服务

## 30 秒跑起来

```bash
# 1. 装进 DSH profile
dsh plugin --profile imchat add /你的路径/imchat

# 2. 冒烟测试（走完整 agent 链路）
dsh --profile imchat --self-test "Reply with exactly: IM-BRIDGE-OK"

# 3. 启用来跑长驻(例如微信)
dsh --profile imchat
```

微信首次运行会在终端打印二维码，扫一下确认，token 自动保存，之后无需重复登录。

再配合我们做的**浏览器二维码页**（`http://127.0.0.1:9000/qr`），扫码过程也能在浏览器里完成，不依赖终端。

## 开源

项目已开源（MIT）：

> 仓库含完整源码、单元测试、部署文档。也欢迎直接 `git clone` 后改造成你自己的机器人。

## 说点实在的

目前**文本消息**通路已经完全可用（微信我们真跑通了：收到消息 → agent 处理 → 回复发回）。富媒体（图片 / 文件 / 语音）是下一步。

如果你也在用 DeepSeek Harness，或者想给 IM 接个「真·agent 助手」，这个项目可以当个起点。欢迎 star、提 issue、一起加功能。

**项目地址：** `https://github.com/ChrisLou-bioinfo/deepseek-harness-wechatbot`

本文提到的都是真跑过的流程——扫码登录、收发消息、会话恢复，不是 PPT。
