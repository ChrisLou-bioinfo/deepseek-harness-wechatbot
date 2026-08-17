# 续传备忘 (暂停于 2026-08-17)

## 已完成 (git 已提交)
- DSH profile 插件机制验证 + 自测通过 (dsh --profile imchat --self-test)
- 桥核心 src/lib/bridge.js + utils + 单元测试 (25/25 通过)
- 三个平台适配器均已实现并通过各自单测:
  - wechat/ (ilink 官方协议,免 wechaty;协议已对照腾讯 openclaw-weixin 修正: endpoint 加 ilink/bot/ 前缀 + base_info + iLink-App-Id 头;真实网关返回 -14 属预期)
  - matrix/ (Client-Server API + /sync 长轮询;真实 homeserver 返回 401 预期)
  - feishu/ (官方 @larksuiteoapi/node-sdk 长连接 createLarkChannel;真实端点 200/code:10003 预期)
- README 三平台接入说明 + 架构文档

## 待办 (下一回合继续)
1. 【进行中】修 长驻模式进程立即退出 bug —
   根因:apply 里 program.action 对 startLongRunning 是 fire-and-forget(未 await),
   keepAlive timer 在其异步内部才创建,时机太晚;DSH 进程在 action 返回后无事件循环
   活跃源即退出。所以 `dsh --profile imchat`(无 --self-test)立即退出、0 输出。
   修法:在 action 的同步段立即创建 keepAlive timer(或先 await startLongRunning),
   再启动异步适配器;验证 `dsh --profile imchat`(空参数)可持续存活。
2. 若 #1 修好后,重测 console 长驻(piped stdin)通断;若仍收不到行,再用 raw
   process.stdin 'data' 已作为 console 适配器回退(已实现)。
3. 端到端真实凭据验证(可选):给 wechat/matrix/feishu 配真实凭据跑长驻。
4. 最终 review: 删掉 e2e-bridge-check.mjs 占位,README 补"console 演示在 DSH 内 stdin 限制说明"。
