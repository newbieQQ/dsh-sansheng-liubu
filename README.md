# 三省六部工作台

给 DeepSeek Harness（DSH）用的多角色工作台：丞相、三省、六部共十席，
每一席都是一个**独立会话**（不是谁的子 agent），身份由程序按
「项目 + 席位」的绑定注入，项目之间互不串扰。

## 它怎么运转

- **账本**：项目、任务、派工、成果都记在一本账本里
  （`~/.dsh/sansheng-liubu/workbench.json`），聊天原文不复制，
  留在各席位自己的会话里。
- **派工**：在工作台里选项目、选席位、写任务单，程序把材料直接
  投递到那个席位的会话；投递以请求号防重复，结果回来自动对账。
- **模型**：每个席位可以单独选模型，存在账本与会话绑定里，
  不借别的会话、不靠猜。
- **记忆**：三层 Markdown 记忆，派工时自动带上相关片段——
  部门记忆（每个部门一份、跨项目，`memory/departments/<部门>.md`）、
  项目记忆（按项目隔离，`memory/projects/<项目>.md`）与长期记忆
  （跨项目，`memory/long-term.md`），都是纯文本，可以直接打开改。
  设计说明见 `docs/记忆设计.md`。

## 安装与启用

前提：DSH 桌面版已把本包登记为 bundle。工作台面板单独开关：

```sh
node scripts/workbench-install.mjs on     # 装上面板
node scripts/workbench-install.mjs off    # 卸下面板
node scripts/workbench-install.mjs status # 看状态
```

改完之后要**彻底退出并重启 DSH** 才生效。

## 验证

```sh
npm test                                   # 工作台全量单测
node scripts/workbench-preflight.mjs       # 装配与安装状态预检
```

真机验收矩阵在 `docs/v0.1-验收记录.md`，标「待真机」的条目
只能在装了 DSH 的机器上验。

## 0.11.0 退役说明

老预设线已整体退役：不再有「上朝」模式、基于 Team 成员身份的
政策插件（工具守卫、按部门改模型）、朝堂侧栏与组建朝班流程。
根目录 `index.js` 现在只负责在应用根上启动工作台宿主。

升级注意：如果你的 DSH 配置文件 `cordis.patch.yml` 里还留着
以前写入的上朝预设段，请把它删掉再重启；工作台面板的安装方式
不变。本包的包名保持 `dsh-sansheng-liubu-mode` 不变，只是为了
让既有 bundle 登记继续有效，它不再提供任何模式。
