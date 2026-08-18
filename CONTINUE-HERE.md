# imchat — 完成标记 (2026-08-17)

核心目标已达成并验证。剩余均为「如需要」的可选迭代,核心交付稳定可用。

## 已达成(全部 git 已提交,工作树干净)
- 三种 IM 接入全部实现并通过单测:
  - 微信(ilink 官方协议,免 wechaty;真实网关 -14 预期验证,无 token 打真实 QR)
  - Matrix(/sync 直连;真实 homeserver 401 预期验证)
  - 飞书(官方 @larksuiteoapi/node-sdk 长连接;真实端点 200/code:10003 预期验证)
- 核心链路:桥 core(src/lib/bridge.js)+ 自测全链路
  `dsh --profile imchat --self-test "..."`(多次通过)
- 按会话隔离 + 持久化 resume:确定性 sessionId + create/resume 语义;单测覆盖;
  IMCHAT_DETERMINISTIC=1 真实 resume 路径两次运行验证通过
- 长驻模式 keepAlive 修复(action 同步段注册);三平台同启进程存活验证
- 单测 25/25 通过;README 完整部署/接入/架构/验证文档

## 已关闭 / 备注
- console 在 DSH 长驻中收不到 stdin(DSH 启动即消费管道 stdin);定位为演示/启动验证。
- 删除了 e2e-bridge-check.mjs 占位。

## 后续可选迭代(非阻塞)
1. 真实凭据端到端:配真凭据跑长驻(微信已能打 QR)。
2. 富媒体(图片/文件/语音)。
3. 消息去重缓存(message_id)。
4. AppService 多用户托管。
