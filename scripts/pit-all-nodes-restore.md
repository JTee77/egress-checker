# Pit smoke — 测全部（会切换节点）restore

在已连上 Mihomo 兼容客户端的 Mac 上：

1. **Confirm dialog**
   - 选「测全部节点」→ 应先看到中文提示（会临时切换、出口会变、测完切回）。
   - 点「开始测全部（会切换节点）」→ 出现确认面板，确认按钮文案含「会切换节点」。
   - 点「取消」不应开始；再点主按钮重新打开确认。

2. **Switches during**
   - 确认后开始：进度先「淘汰不通节点 x/y」，再「深测存活节点 x/y（节点名）」。
   - 代理软件里当前选中节点应随进度变化。

3. **Restores original**
   - 跑完后界面提示「已切回原先节点：…」，客户端选中应与开始前一致。
   - 中途点「停止并切回」：应中止深测并切回原节点。

4. **Restore-fail path（可模拟）**
   - 深测进行中，在客户端里关掉 external-controller / 改掉 secret / 退出代理软件，使 PUT select 失败。
   - 结束后应出现红色「没能切回原先节点」报错（中文），不得静默停在其它节点上不提示。

本地逻辑自检（无 GUI）：

```bash
node scripts/simulate-restore-fail.mjs
```
