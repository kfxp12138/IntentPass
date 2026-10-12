# Legacy acceptance-table test input

These 49 original rows are preserved only for the acceptance-index parser regression tests. They do not define the current product scope or claim completed acceptance. See the root README for current scope.

| D1-01 | 新目录安装并启动 | Web /health 正常，缺秘密显示配置错误不伪造 ready | 命令输出、部署 URL |
| D1-02 | 运行 schema/hash 样例 | TS 与合约一致；Full 时与原 PACT 编码映射一致 | 固定测试向量和测试输出 |
| D1-03 | 实际调用 JEV、planner | 有真实响应、实际模型标识、结构校验；不泄露凭据 | 脱敏响应和耗时 |
| D1-04 | Privy 正反调用 | 合法调用成功；另一可模拟成功的越权调用被实际策略拒绝 | 成功 tx、policy 错误、policy ID |
| D1-05 | 同 Passkey 设备 A/B 解密文本 | B 未复制明文 key 仍得到相同文本；rpId/namespace 一致 | 实机记录 |
| D1-06 | 官方 CVI/CVA 及托管路径测试 | 真实身份绑定与资产转移可核对；不合格路径拒绝；托管资格明确 | ABI 来源、地址、tx/错误、资格说明 |
| D1-07 | 原 PACT 运行或降级决策 | 完整双 opening/恢复测试通过，或负责人签字确认降级 | commit、原测试输出或明确确认 |
| D2-01 | 真 planner 生成订单 | 候选结构有效；金额和必要条件保持用户原值；不存在的证据引用被拒 |
| D2-02 | 输入“代码开源但报告许可未知” | 真实 JEV 流程 ABSTAIN；没有可执行 PASS 回执 |
| D2-03 | 输入明确允许用途的完整报价 | 真实 JEV PASS；用户可以看到具体条件并签 Grant |
| D2-04 | 输入明确禁止用途、超预算或错误报价签名 | 分别由语义或确定性规则 REJECT，拒绝来源可辨认 |
| D2-05 | 模拟 JEV 超时/缺字段/异常 | ABSTAIN，不签可执行回执，不自动换模型反复碰通过 |
| D2-06 | 修改已签 Grant 的收款方/金额/chainId | 本地签名验证失败；一单一 nonce 的消费逻辑有单元测试 |
| D2-07 | 运行确定性聚合单测 | 所有组合分支与规定一致；没有把少数通过当全体必要条件通过 |
| D3-01 | 完整走一笔本地订单 | buyer 减 P+B；卖方最终增 P；买方返 B；托管余额与应收一致 |
| D3-02 | 缺用户签名、缺 PASS 回执或调用旧入口 | 都不能创建可花费订单；资产无错误变化 |
| D3-03 | 改收款方、资产、金额、委员会或证据 | 对应已签订单不能复用 |
| D3-04 | 双提交/重放/两个并发相同 nonce | 最多一次消费和一次资金分配 |
| D3-05 | 交付验收未达门限就 settle | 合约拒绝且原订单状态不被错误终结 |
| D3-06 | 超时/退款/提现失败 | 三种终态分配正确；失败不丢应收；终态不能重新分配 |
| D3-07 | Full：只有一个 opening、错 share、重复索引、混合证据、setup 缺人 | 均拒绝；全部 setup 后任意合法 2 人恢复同一原签名 |
| D3-08 | 降级路线：scope、重复成员、错误证据 vote | 均拒绝；UI/README 明示非 IMAS/CDAS；D3-07 不冒报通过 |
| D4-01 | 好证据、有效身份、用户授权、正常交付 | 真实 CVA 入金、结算和卖方实际到账 | 订单 ID、成功 tx receipts、余额前后 |
| D4-02 | 同类业务使用不满足规则的钱包 | 在链上资产/结算路径被真实规则拒绝，资金不错误移动 | 链上可复核错误或测试 tx；不能仅给后端 toast |
| D4-03 | 绕过 UI，直接调用真实合约 | 仍不能绕过 CVI、用户授权或回执约束 | 调用参数摘要及拒绝结果 |
| D4-04 | Privy 提交一次可模拟成功但不在 policy 内的调用 | 明确 policy denial，不用余额不足/revert 冒充 | Privy policy 响应与配置摘要 |
| D4-05 | 拒绝结算/退款/提现的资产条件 | 无错误扣减或清空应收；显示阻塞而非已到账 | 本地故障测试＋真实可控制环境的验证 |
| D4-06 | 查看页面与浏览器链记录 | SUBMITTED/CONFIRMED/CREDITED/WITHDRAWN 不混淆 | 页面及 tx 对照 |
| D5-01 | 设备 A 创建两个 namespace 的加密对象 | 仅持久化密文/元数据；同明文多次加密使用不同 IV |
| D5-02 | 同 Passkey 在设备 B/新配置打开相同 rpId | 没有复制明文 key、PRF 或本地 session，恢复相同原始内容 |
| D5-03 | 换 namespace / Passkey / 篡改密文或 AAD | 解密失败，不回退到明文读取 |
| D5-04 | 恢复已入金或已支付订单并点击继续 | 引用原 orderId；查链后继续或显示终态；不再次扣款 |
| D5-05 | 把旧 Capsule 中收款方或原始上下文替换 | 签名/链上 commitment 对比失败，不能生成新有效付款 |
| D5-06 | 检查网络、持久化存储、日志和导出文件 | 不存在 PRF、派生 key 或未授权私人明文；服务端持久化仅最小必要数据 |
| D5-07 | 完成四页人工走查 | 正常、暂停、拒绝、阻塞、取消与恢复均可操作 |
| D6-01 | 跑全部确定性单测/合约/安全回归 | 必需项全通过；失败、BLOCKED、SKIP 不被聚合成 PASS |
| D6-02 | 运行 24 条独立 JEV 样例 | 结果完整且分母/错误/失败明确；没有删除不利样本；规则-only 对照边界相同 |
| D6-03 | 关键 3 个样例各 3 次 | 正常能通过，缺证不产生 PASS，矛盾不获授权；记录每次真实输出 |
| D6-04 | 独立运行 example-client | 不依赖主站 UI 成功审查并读取真实订单；授权提交仍经过正确签名 |
| D6-05 | 第二环境按 README 复现 | 有明确启动、配置、部署/接入步骤，不靠作者未记录的手动改库 |
| D6-06 | 扫描源码、构建产物、日志、媒体 | 没有 API Key、用户私钥、PRF 输出或未授权私人资料 |
| D6-07 | 重启 worker、刷新页面、重复按钮 | 订单和资金状态不重复、不倒退；链上状态为最终依据 |
| D7-01 | 用评委身份访问最终产品 | 能进入实际流程；没有作者专用 localhost 或失效账号依赖 |
| D7-02 | 核对技术 Demo | ≤180 秒，是真实产品，含 Monad 交易与关键赞助方功能 |
| D7-03 | 核对 Pitch 与 Cleanverse 视频 | Pitch ≤120 秒；Cleanverse ≤300 秒，真实展示 CVI 在 CVA 动作前检查 |
| D7-04 | 核对 Mera/Privy 功能证据 | 非钱包 namespace 及跨设备解密真实；Privy 超越登录且有策略效果 |
| D7-05 | 核对仓库与文档 | 可访问、许可证、归因、AI 披露、构建期 commits、地址/ABI、访问说明齐备 |
| D7-06 | 核对提交清单与平台保存结果 | 真实 URLs/提交回执可验证；不存在“待上传”却标为已完成 |
| D7-07 | 按 release profile 打最终状态 | Full PACT、PACT-inspired、各 bounty 的实际完成情况分别报告，不互相替代 |
