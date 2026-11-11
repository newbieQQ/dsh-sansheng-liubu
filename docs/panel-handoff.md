# 三省六部面板：换环境开发交接方案

日期：2026-11-08
当前版本：`0.5.6`
状态：侧栏化改造、残留清理、容器断点与左侧栏入口均已实现并通过 39 项本地测试；尚未在真实 DSH Host 里做最终视觉验收。

![右侧栏 440px 明亮主题](preview/panel-sidebar-440-light.png)

> 这张图由 `scripts/preview.mjs` 渲染真实组件树 + 真实 CSS，再用 headless Chrome 截图（440 CSS px × 2 DPR），不是 DSH Host 的运行截图，也不是 AI 生图。同一脚本还产出宿主实测宽度 371px、窄栏 360px、极窄单列 320px、深色主题与任务页：

![371px 实测侧栏宽度](preview/panel-sidebar-371-light.png)

![360px 窄栏](preview/panel-sidebar-360-light.png)

![320px 单列](preview/panel-sidebar-320-light.png)

![440px 深色主题](preview/panel-sidebar-440-dark.png)

![任务页](preview/panel-sidebar-tasks-440.png)

左侧栏导航行（静态标记 + 真实 CSS，不是宿主截图）：

![左侧栏入口](preview/panel-rail-entry.png)

重新生成（需要放开沙箱，Chrome 无头模式要建 mojo 命名管道）：

```bash
node scripts/preview.mjs --width=440 --view=court --theme=light --name=panel-sidebar-440-light --out=docs/preview
node scripts/preview.mjs --width=371 --view=court --theme=light --name=panel-sidebar-371-light --out=docs/preview
node scripts/preview.mjs --width=360 --view=court --theme=light --name=panel-sidebar-360-light --out=docs/preview
node scripts/preview.mjs --width=320 --view=court --theme=light --name=panel-sidebar-320-light --out=docs/preview
node scripts/preview.mjs --width=440 --view=court --theme=dark  --name=panel-sidebar-440-dark  --out=docs/preview
node scripts/preview.mjs --width=440 --view=tasks --theme=light --name=panel-sidebar-tasks-440 --out=docs/preview
```

复现「大窗口 + 窄侧栏」（真实宿主形态）：加 `--viewport=1200 --width=371`，页面按 1200px 窗口渲染、侧栏仍为 371px。

只想要中间 HTML、不调 Chrome 时加 `--html-only`。最终验收仍然必须在真实会话右侧栏里完成。

## 1. 一句话目标

不要再维护一套整页面板或第二套聊天界面。聊天全部使用 DSH 原生输入框；三省六部的朝堂编制、任务流转和部门配置只停留在会话右侧栏，并通过 `@` 直接进入部门子会话。

## 2. 已经完成的部分

- 十席角色：丞相、中书省、尚书省、门下省、吏部、户部、礼部、兵部、刑部、工部。
- 朝堂图为「丞相 → 三省 → 六部」，六部两排三列，同属尚书省调度。
- 部门为实体卡片：字徽、边框、状态点和中文状态；选中态有蓝边、浅底和勾选标记。
- 插件注册会话头部入口、左侧栏导航行（`sidebar.panellist`）、`main` 重定向桩与右侧栏页签；`sidebar.panellist.actions` 仍不注册。
- 右侧栏包含「朝堂 / 任务」页签、2×2 统计卡、朝堂图、部门配置和任务列表。
- DSH 原生输入框注册 `@` 来源，列出已有会话的部门；选中后进入该部门子会话。
- 进入部门子会话时自动选中对应部门；返回丞相主会话时恢复选中丞相。
- 移除 Agent 预设编辑、重复的「下旨」输入框和独立聊天摘要。
- 复用 DSH 主题变量，支持明亮、深色与窄侧栏布局。
- 0.5.6 左栏那一行改名「上朝」（`label: () => "上朝"`），`order` 从 10 改成 −100，排在「插件」之外的所有插件行之前（置顶）。
- 0.5.5 撤掉了 0.5.3 的左侧栏底部入口（`sidebar.footer.action`）：用户看到左栏里同时出现导航行和底部一行，明确要求只保留导航列那一行。左栏入口从两个收敛成一个。
- 0.5.4 把入口放进左侧栏导航列（`插件 / 定时任务 / 任务看板 / MCP 连接器` 那一列）：注册 `sidebar.panellist` 一行（细线「三」字样标 + 标签），点击后走宿主的 `selectPanel(id)`。
- 因为那一列的点击一定要 `main` 槽，所以同时注册 `main`（`key: PANEL_ID`）作为**重定向桩**：进去立刻把朝堂停靠到当前会话右侧栏并 `selectPanel(null)` 退回原会话；没有会话时只在页面中央写明原因。它不渲染面板、不承载聊天。
- ~~0.5.3 在左侧栏底部加了一个常驻入口~~：0.5.5 已撤掉，见上条。
- 0.5.3 去掉了会话头开关失败时对 `host.togglePanel()` 的回退：0.5.0 起没有 `main` 槽，那个调用只会把主区域切到一个不存在的面板上。
- 0.5.2 把响应式断点从浏览器视口改到面板容器：`.sl-root` 声明 `container-type:inline-size;container-name:slpanel`，11 处 `@media (max-width: …)` 全部改为 `@container slpanel (max-width: …)`。真实宿主窗口最大化时侧栏仍只有 371px，原来的视口断点一个都不会触发。
- 部门配置里的「最近活动」独占一行（最多两行后省略），不再和状态文字挤在同一行被裁断；单列阈值落在 330px 容器宽（360px 及以上仍两列）。
- `scripts/preview.mjs` 新增 `--viewport`，可以渲染「大窗口 + 窄侧栏」的真实宿主形态。
- 0.5.1 清掉侧栏化残留：46 个不再渲染的 `sl-*` 类、无调用点的 `SanshengPinRow`/`DockButton`/`SidebarIcon`，以及三个无规则的幽灵类名。
- 会话头部开关在拿不到会话时把原因显示在开关旁，不再静默回退；CSS 与组件的一致性由测试兜住。
- 版本更新到 `0.5.6`；`CHANGELOG.md`、`panel/README.md`、`docs/panel-design.md` 已同步。

## 3. 当前验证结果

在 `C:\Users\qyh15\三省六部` 执行：

```powershell
$node = 'C:\Users\qyh15\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$env:ELECTRON_RUN_AS_NODE = '1'
& $node --check panel/lib/client.js
& $node --test --test-isolation=none test/policy.test.js panel/test/client.test.js
& $node scripts/check-install.mjs
```

结果：

- 语法检查通过。
- **39 项测试全部通过**。
- `scripts/check-install.mjs` 通过：panel 以 link 方式安装，client bundle 已注册。
- `modeEnabled: false` 只表示「上朝」模式尚未启用，不表示面板不可用。
- 清理前后做了像素级 A/B：用同一份 `scripts/preview.mjs`、同一组参数，分别渲染 0.5.0 快照（`.scratch/preview-baseline/client.snapshot.js`）与 0.5.1 的 `panel/lib/client.js`，五组（440/400/360 明亮、440 任务页、440 深色）截图的 sha256 **逐字节相同**，证明删掉的 CSS 与组件确实不在渲染路径上。
- 体积变化：内联 CSS 40,963 → 28,346 字符（−30.8%），HTML 52,261 → 39,596 字节（−24.2%）。

尚未完成：真实 DSH Host 的视觉截图验收。当前只有 Chromium 对真实组件树的渲染图。

## 4. 代码地图

| 文件 | 作用 | 当前注意点 |
| --- | --- | --- |
| `panel/lib/client.js` | 前端全部实现：CSS、React 组件、DSH 槽位、@ 来源、宿主适配 | 约 1890 行，单文件自包含 bundle；修改后必须跑 `--check` |
| `panel/lib/model.js` | 十席定义、布局、状态、模型切换等纯逻辑 | 与 client 内自包含常量需要同步 |
| `panel/index.js` | 策略侧 formation/decree 提示词 | 与前端职责保持一致 |
| `index.js` | Agent Preset 策略、角色工具权限 | 不得随意放宽写入/命令权限 |
| `panel/test/client.test.js` | 面板结构与行为测试 | 使用最小 React 替身，`useState` 不自动更新 |
| `test/policy.test.js` | 策略与权限测试 | 与客户端测试合计 39 项 |
| `scripts/check-install.mjs` | 安装一致性检查 | 已改为校验右侧栏注册、拒绝旧的 main/panellist |
| `scripts/preview.mjs` | 零依赖预览生成器：vm 加载真实 bundle → 渲染真实组件树 → HTML → headless Chrome 截图 | 需放开沙箱跑 Chrome；`--html-only` 只出 HTML |
| `docs/panel-design.md` | 设计依据与验收标准 | 已更新到侧栏结构 |
| `CHANGELOG.md` | 版本变更 | 顶部已切到 `0.5.x` 线 |

### 前端关键位置

- `SanshengPanel`：右侧栏主组件，状态含 `sidebarView`、`selectedRole`、`activeChildId`。
- `SeatCard`：部门实体卡片。
- `courtStats`：四张统计卡的数据投影。
- `seatMentionOptions` / `createSeatMentionSource` / `registerSeatMentions`：原生 `@` 来源。
- `childRoleOf`：由子会话 id 反查部门角色，用于自动选中。
- `openSeatConversation` / `returnToLead`：进入部门会话与返回丞相。
- `apply`：注册五个原生槽位：
  - `conversation.session.header.actions`（会话头开关）
  - `sidebar.panellist`（左侧栏导航列的一行，标签「上朝」、`order: -100` 置顶；图标是插件提供的细线「三」字样标）
  - `main`（只作重定向桩：停靠右侧栏后退回原会话，不渲染面板）
  - `sidebar.right.pane.tab`
  - `sidebar.right.pane.tab.title`
- `dockToSidebarTab(host)`：导航行点击后的实际动作（成功清提示并 `selectPanel(null)`，失败只写提示），导出在 `__test` 里供测试直接驱动。

## 5. 不可破坏的决策

1. **不恢复整页面板**。左栏只保留**一个**入口——导航列那一行；不要再加底部入口、页脚按钮或第二处重复入口（0.5.5 就是撤掉这类重复）。`sidebar.panellist` 只用于「左侧栏导航列的一行」，`main` 只用于「点进去立刻退回会话」的重定向桩：两者都不得渲染朝堂内容、不得承载聊天、不得出现第二套输入框。用户 0.5.4 明确要求入口出现在导航列，这是对 0.5.0「两个槽一律不注册」的收敛式修订——范围限定在「纯跳转」，不是把整页面板请回来。
2. **不造第二套聊天存储**。消息只在 DSH 原生会话里发送与保存。
3. **不静默改投消息**。普通 `@` 文本不能自动把当前会话消息转发给别的 Agent；进入哪个会话，消息就发给谁。
4. **@ 只列已有会话的部门**。未设官、无子会话的部门不能伪造入口。
5. **权限不因界面变化而放宽**。这只是客户端面板调整，不修改 `index.js` 的工具边界。
6. **版本历史只用 Git**。不要创建 `backup/`、时间戳副本或“最终版”目录。

## 6. 换环境后的推进顺序

### 第 1 步：带走代码，而不是复制一堆副本

当前工作树有未提交改动。换环境前先在原环境提交一次，或生成 Git bundle：

```powershell
cd C:\Users\qyh15\三省六部
git add -A
git commit -m "feat(panel): move court into sidebar and use native chat mentions"
```

如果目标环境不能直接访问原磁盘：

```powershell
git bundle create sansheng-liubu-0.5.0.bundle --all
```

到新环境：

```powershell
git clone sansheng-liubu-0.5.0.bundle 三省六部
```

不要手工拷贝整个工作区，也不要把 `node_modules`、`.chrome-preview` 或临时 HTML 带过去。

### 第 2 步：确认宿主与安装方式

新环境先确认：

- DSH 版本支持 `sidebar.right.pane.tab` 与 `inputTriggers.registerSource`。
- profile 的 `dsh.profile.bundles` 含 `dsh-sansheng-liubu-panel`。
- panel 以 `link:` 或可编辑的开发方式安装，避免每次改代码都重新打包。
- 如需「上朝」模式，再执行 `node scripts/mode.mjs on`；面板本身不需要先开模式。

### 第 3 步：真实宿主验收

重启 **DSH Host**，不是只刷新浏览器。然后：

1. 打开一个会话，确认右侧栏出现「三省六部」页签。
2. 检查「朝堂 / 任务」切换；点击「在朝成员」「在办任务」统计卡。
3. 在原生输入框输入 `@`，确认只出现已有会话的部门。
4. 选择 `@工部`，确认进入工部子会话，右侧栏自动选中工部。
5. 在工部会话发送一句话，确认消息进入工部而不是丞相会话。
6. 点击「返回丞相」，确认回到父会话且选中恢复丞相。
7. 在 360、400、440、480px 侧栏宽度下检查：无横向滚动、卡片名称和状态不被裁切。
8. 切换 DSH 明亮/深色主题，确认没有刺眼白卡或不可读状态。

### 第 4 步：处理剩余技术债

这些不阻塞功能，但建议在下一个环境完成：

- ~~删除已不再渲染的旧 CSS~~：0.5.1 已删除 46 个死类、约 117 行规则（CSS 374 → 257 行）。
- ~~删除未引用的 `SanshengPinRow`、`DockButton` 包装~~：两者与 `SidebarIcon` 导出均已删除（确认外部无消费方）。
- ~~检查会话头部开关在“当前没有会话”时的反馈~~：0.5.1 已把失败原因显示在开关旁（`role="status"`），并有回归测试。
- 视真实宿主表现，决定是否保留 `remote.agentPresets` 注入；高级信息仍读取只读预设，不要贸然删除底层能力。
- 为真实右侧栏补一张宿主截图，替换/补充 `panel-preview-sidebar.png` 作为验收证据。

## 7. 可直接粘贴给新环境 Agent 的交接提示

```text
你在 C:\Users\qyh15\三省六部 继续一个 DSH Web 客户端插件项目（dsh-sansheng-liubu-panel，当前 0.5.6）。

用户目标：三省六部面板只存在于会话右侧栏；聊天必须复用 DSH 原生输入框；在原生输入框用 @ 选择部门后进入该部门子会话，并自动选中右侧对应部门；不要再恢复整页面板或第二套聊天。

先读：
- docs/panel-handoff.md
- docs/panel-design.md
- panel/lib/client.js 中 SanshengPanel、createSeatMentionSource、apply
- panel/test/client.test.js
- scripts/check-install.mjs

当前状态：侧栏化、残留清理、容器断点与左侧栏入口（含导航行）都已实现，39 项测试通过，check-install 通过，工作树可能尚未提交。不要创建备份目录。

请先：
1. 运行现有测试和 check-install，确认基线；
2. 在真实 DSH Host 重启后验收右侧栏、@ 导航、自动选中、返回丞相；
3. 修复真实宿主暴露的问题，并补回归测试；
4. ~~清理不再渲染的旧 CSS/组件~~（0.5.1 已完成，后续只需保持）；
5. 更新 CHANGELOG、README 和设计文档，保持 0.5.x；
6. 用 Git 提交，不要建时间戳副本。

硬约束：
- 不注册 sidebar.panellist.actions；main 与 sidebar.panellist 只允许作「导航行 + 重定向桩」；
- 不新增聊天存储，不静默把消息转发给其他 Agent；
- @ 候选只含已有会话的部门；
- 不改变 index.js 的角色工具权限边界；
- 每个设计调整附一张新的实际预览图。
```

## 8. 验收标准

- [ ] 右侧栏可打开，朝堂与任务可切换。
- [ ] 十席完整，六部同属尚书省，无错误上下级连线。
- [ ] 部门卡片在窄栏仍清晰，名称与状态不裁切。
- [ ] `@` 只列已有会话的部门，选择后进入正确子会话。
- [ ] 进入子会话自动选中对应部门，返回后恢复丞相。
- [ ] 原生输入框发送的消息不会误投给其他 Agent。
- [ ] 明亮/深色主题都可读，焦点与选中状态可见。
- [ ] 39 项测试、`node --check`、`git diff --check`、`check-install` 全部通过。
- [ ] 有真实 DSH Host 截图作为最终视觉证据。

## 9. 已知风险

- 静态预览能按任意容器宽度渲染，但**不能**证明宿主实际给出的侧栏宽度、滚动容器和槽位渲染完全一致；必须实机验收。宿主实测侧栏宽度为 371px，已作为预览图之一（`panel-sidebar-371-light.png`）。
- 断点已改为容器查询，但容器是 `.sl-root`：若宿主把面板塞进更窄的固定宽外壳，实际生效宽度以内层容器为准。修改布局时先用 `--viewport=1200 --width=371` 复现真实形态，不要只看预览页宽度。
- `better-sidebar` 与宿主自带 `sidebarRight` 两条注册路径都要验证；只测其中一条不够。
- 测试用的最小 React 替身不会执行真实点击，交互问题需要宿主手测或补更真实的组件测试。
- 若新环境 DSH 版本没有 `inputTriggers`，`@` 入口应静默不可用，但其余侧栏功能不能因此崩溃。
