# imchat — 状态备忘 (更新于续做轮)

## 已达成(全部 git 已提交)
- 三平台适配器全部实现且通过各自单测(桥核心/微信/Matrix/飞书/utils 共 25+)。
- 真实 profile 三平台启动已验证:
  - 微信无 token → 打印真实二维码(MIT 协议正确),
  - Matrix 无凭据 → 401 retry 容错,
  - 飞书 → SDK client ready + 长连接连上真实飞书(仅 fake creds 导致 bot identity 解析失败)。
  - 进程长驻存活(keepAlive 修复在 action 同步段,已验证)。
- 自测 `dsh --profile imchat --self-test "<task>"` 全链路通过。
- README 三平台接入 + 部署 + 验证 + 架构文档。

## 已关闭 / 备注
- console 在 DSH 长驻中收不到 stdin 事件(DSH 启动即消费管道 stdin);console 定位为
  「演示/启动验证」,README 已说明;完整闭环请用 `--self-test` 或真实平台。
- 删除了 tests/e2e-bridge-check.mjs 占位。

## 剩余(如需要)
- 真实凭据端到端:给三平台配真凭据跑长驻(FYI: 微信已能打 QR)。
- 未来迭代:富媒体(图片/文件)、消息去重缓存、AppService 多用户。
