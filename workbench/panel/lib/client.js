window.__ModuleLoader__.load({
  id: "dsh-sansheng-liubu-mode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    // ---------------------------------------------------------------------
    // 常量与纯函数（不依赖宿主、不依赖 DOM，供单测直接调用）
    // ---------------------------------------------------------------------

    const API_BASE = "/sansheng/workbench";
    const TAB_ID = "sansheng-liubu-workbench";
    const TAB_KIND = "sansheng-liubu-workbench";
    const CSS_ID = "dsh-sansheng-liubu-mode/workbench.css";
    const RAIL_WIDTH_KEY = "sansheng.workbench.railWidth";
    const MAIN_SWITCH_KEY = "sansheng.workbench.main";
    const RAIL_MIN = 340;
    const RAIL_MAX = 600;
    const RAIL_DEFAULT = 400;

    const ROLE_ORDER = [
      "lead",
      "zhongshu",
      "shangshu",
      "menxia",
      "libu",
      "hubu",
      "lipu",
      "bingbu",
      "xingbu",
      "gongbu",
    ];

    const ROLE_META = {
      lead: { name: "丞相", mark: "丞", kicker: "主代理", tier: "leaders", group: "lead", column: "span", row: 0, duty: "接需求、分流、协调、汇报" },
      zhongshu: { name: "中书", mark: "中", kicker: "省", tier: "sansheng", group: "sansheng", column: "left", row: 1, duty: "起草方案、拆解路径" },
      shangshu: { name: "尚书", mark: "尚", kicker: "省", tier: "sansheng", group: "sansheng", column: "center", row: 1, duty: "总揽执行、调度六部" },
      menxia: { name: "门下", mark: "门", kicker: "省", tier: "sansheng", group: "sansheng", column: "right", row: 1, duty: "审核把关、封驳纠偏" },
      libu: { name: "吏部", mark: "吏", kicker: "部", tier: "ministries", group: "ministries", column: "left", row: 2, duty: "人事、配置、席位" },
      hubu: { name: "户部", mark: "户", kicker: "部", tier: "ministries", group: "ministries", column: "center", row: 2, duty: "资源、预算、账目" },
      lipu: { name: "礼部", mark: "礼", kicker: "部", tier: "ministries", group: "ministries", column: "right", row: 2, duty: "文档、规范、对外表达" },
      bingbu: { name: "兵部", mark: "兵", kicker: "部", tier: "ministries", group: "ministries", column: "left", row: 3, duty: "执行、工具、攻坚" },
      xingbu: { name: "刑部", mark: "刑", kicker: "部", tier: "ministries", group: "ministries", column: "center", row: 3, duty: "测试、审查、问责" },
      gongbu: { name: "工部", mark: "工", kicker: "部", tier: "ministries", group: "ministries", column: "right", row: 3, duty: "工程、构建、基础设施" },
    };

    const STATUS_LABELS = {
      uninitialized: "未接通",
      idle: "空闲",
      queued: "排队",
      running: "正在运行",
      unavailable: "不可用",
      needs_attention: "需人处理",
    };

    const EFFORT_LABELS = {
      minimal: "极低",
      low: "低",
      medium: "中",
      high: "高",
      none: "无",
    };

    const TASK_STATUS_LABELS = {
      draft: "草稿",
      queued: "排队",
      running: "执行中",
      waiting_input: "待输入",
      needs_attention: "需人处理",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
    };

    function assign(target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        if (!source) continue;
        for (var key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
        }
      }
      return target;
    }

    function clamp(value, low, high) {
      var number = Number(value);
      if (!isFinite(number)) return low;
      return Math.min(high, Math.max(low, number));
    }

    function round(value) {
      return Math.round(Number(value) * 10) / 10;
    }

    function statusOf(status) {
      if (typeof status !== "string" || status === "") return "未接通";
      return STATUS_LABELS[status] || "未知";
    }

    function seatDisplayName(seat) {
      if (!seat) return "";
      var meta = ROLE_META[seat.roleId] || {};
      // short 是单字简称（丞/中/尚…），只能在最后兜底；完整名优先。
      return seat.name || meta.name || seat.short || seat.roleId || "";
    }

    function formatModelLine(config) {
      if (!config || typeof config !== "object") return "跟随宿主";
      var provider = typeof config.provider === "string" ? config.provider.trim() : "";
      var model = typeof config.model === "string" ? config.model.trim() : "";
      var effort = typeof config.reasoningEffort === "string" ? config.reasoningEffort.trim() : "";
      if (!provider || !model) return "跟随宿主";
      var effortText = effort ? " · " + (EFFORT_LABELS[effort] || effort) : "";
      // model 自带 provider 前缀（如 magpie/workbuddy/deepseek-v4）时只留最后一段，
      // 避免一行放不下、也避免 provider 重复；完整路径留在卡片 title 里。
      if (model.indexOf("/") >= 0) return model.slice(model.lastIndexOf("/") + 1) + effortText;
      return provider + "/" + model + effortText;
    }

    function modelTitle(config) {
      if (!config || typeof config !== "object") return "跟随宿主（未单独配置模型）";
      var provider = typeof config.provider === "string" ? config.provider.trim() : "";
      var model = typeof config.model === "string" ? config.model.trim() : "";
      var effort = typeof config.reasoningEffort === "string" ? config.reasoningEffort.trim() : "";
      if (!provider || !model) return "跟随宿主（未单独配置模型）";
      return provider + "/" + model + (effort ? " · " + (EFFORT_LABELS[effort] || effort) : "");
    }

    function mergeEvents(current, incoming) {
      var seen = new Set();
      var merged = [];
      var batches = [current || [], incoming || []];
      for (var b = 0; b < batches.length; b++) {
        var rows = batches[b];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (!row || typeof row !== "object") continue;
          var key = row.eventId !== undefined && row.eventId !== null
            ? "id:" + String(row.eventId)
            : row.seq !== undefined && row.seq !== null
              ? "seq:" + String(row.seq)
              : null;
          if (key === null || seen.has(key)) continue;
          seen.add(key);
          merged.push(row);
        }
      }
      merged.sort(function (left, right) {
        return (Number(left.seq) || 0) - (Number(right.seq) || 0);
      });
      return merged;
    }

    function apiPath(name, query) {
      var clean = String(name === undefined || name === null ? "" : name).replace(/^\/+/, "");
      var path = API_BASE + (clean ? "/" + clean : "");
      if (query && typeof query === "object") {
        var parts = [];
        var keys = Object.keys(query);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          var value = query[key];
          if (value === undefined || value === null) continue;
          parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
        }
        if (parts.length > 0) path += "?" + parts.join("&");
      }
      return path;
    }

    function pickProjectId(data, hostWorkspaceId) {
      var projects = data && Array.isArray(data.projects) ? data.projects : [];
      if (hostWorkspaceId) {
        for (var i = 0; i < projects.length; i++) {
          var project = projects[i];
          if (project && project.hostWorkspaceId === hostWorkspaceId && project.id) return project.id;
        }
        return null;
      }
      if (data && typeof data.projectId === "string" && data.projectId) return data.projectId;
      for (var j = 0; j < projects.length; j++) {
        if (projects[j] && projects[j].id) return projects[j].id;
      }
      return null;
    }

    /**
     * 纯几何布局：400px 栏宽时给出与 docs/preview/v01-nodes-*.png 一致的坐标。
     * 返回 nodes 每项都有 id / x / y / col / row（六部 row 为 2、3），
     * 不依赖 DOM，列表渲染与单测共用，避免两套尺寸。
     */
    function computeRailLayout(width) {
      var railWidth = Number(width) > 0 ? Number(width) : 400;
      var padding = 12;
      var gap = 10;
      var sixGap = 8;
      var groupPad = 8;
      var leadHeight = 80;
      var sanHeight = 80;
      var sixHeight = 74;
      var sectionGap = 26;
      // 丞相与三省之间留出分叉展开的垂直空间，和 CSS 的 .wb-trio margin-top 保持一致。
      var leadGap = 48;

      var inner = Math.max(0, railWidth - padding * 2);
      var columnWidth = Math.max(0, (inner - gap * 2) / 3);
      var leadWidth = Math.min(184, inner);
      var leadX = (railWidth - leadWidth) / 2;

      var nodes = [];
      function node(roleId, box) {
        var meta = ROLE_META[roleId];
        return assign({
          id: roleId,
          roleId: roleId,
          name: meta.name,
          mark: meta.mark,
          tier: meta.tier,
          group: meta.group,
        }, box);
      }

      nodes.push(node("lead", {
        x: leadX,
        y: 0,
        w: leadWidth,
        h: leadHeight,
        col: 1,
        row: 0,
        span: 3,
        cx: leadX + leadWidth / 2,
      }));

      var sanY = leadHeight + leadGap;
      var sanIds = ["zhongshu", "shangshu", "menxia"];
      for (var i = 0; i < sanIds.length; i++) {
        var sanX = padding + i * (columnWidth + gap);
        nodes.push(node(sanIds[i], {
          x: sanX,
          y: sanY,
          w: columnWidth,
          h: sanHeight,
          col: i,
          row: 1,
          cx: sanX + columnWidth / 2,
        }));
      }

      var groupY = sanY + sanHeight + sectionGap;
      var sixY = groupY + groupPad;
      var sixWidth = Math.max(0, (inner - groupPad * 2 - sixGap * 2) / 3);
      var sixIds = ["libu", "hubu", "lipu", "bingbu", "xingbu", "gongbu"];
      for (var j = 0; j < sixIds.length; j++) {
        var gridRow = j < 3 ? 0 : 1;
        var col = j % 3;
        var sixX = padding + groupPad + col * (sixWidth + sixGap);
        nodes.push(node(sixIds[j], {
          x: sixX,
          y: sixY + gridRow * (sixHeight + sixGap),
          w: sixWidth,
          h: sixHeight,
          col: col,
          row: gridRow + 2,
          gridRow: gridRow,
          cx: sixX + sixWidth / 2,
        }));
      }

      var groupHeight = groupPad * 2 + sixHeight * 2 + sixGap;

      return {
        width: railWidth,
        padding: padding,
        gap: gap,
        leadWidth: leadWidth,
        columnWidth: columnWidth,
        nodes: nodes,
        lead: nodes[0],
        sansheng: nodes.slice(1, 4),
        ministries: nodes.slice(4),
        groups: {
          lead: { x: leadX, y: 0, w: leadWidth, h: leadHeight, cx: railWidth / 2 },
          sansheng: { x: padding, y: sanY, w: inner, h: sanHeight },
          ministries: { x: padding, y: groupY, w: inner, h: groupHeight, cx: railWidth / 2 },
        },
        wires: {
          lead: { x: railWidth / 2, y: leadHeight },
          ministries: { x: railWidth / 2, y: groupY },
        },
        height: groupY + groupHeight + 16,
      };
    }

    // 分叉线：先垂直下行到 mid，再用两次控制点把切线转正，
    // 终点处以垂直切线落到卡片顶边中点（C 的第二个控制点与终点同 x）。
    function branchPathD(cx0, y0, cx1, y1) {
      var mid = y0 + (y1 - y0) * 0.55;
      return "M " + round(cx0) + " " + round(y0) +
        " V " + round(mid) +
        " C " + round(cx0) + " " + round(y1) + " " + round(cx1) + " " + round(mid) +
        " " + round(cx1) + " " + round(y1);
    }

    // 由几何布局生成连线：丞相底中点 → 三省顶中点，尚书底中点 → 六部组顶边。
    // 真实测量走 DOM rect，量不到时走这里；两边共用同一套 M/V/C 公式。
    function wirePathsFromLayout(layout) {
      var paths = [];
      var lead = layout.lead;
      var sansheng = layout.sansheng;
      var y0 = lead.y + lead.h;
      for (var i = 0; i < sansheng.length; i++) {
        var card = sansheng[i];
        var y1 = card.y;
        if (!(y1 > y0)) continue;
        paths.push({
          key: "lead-" + card.id,
          kind: "branch",
          d: branchPathD(lead.cx, y0, card.cx, y1),
        });
      }
      var shangshu = null;
      for (var j = 0; j < sansheng.length; j++) {
        if (sansheng[j].id === "shangshu") shangshu = sansheng[j];
      }
      var group = layout.groups.ministries;
      if (shangshu) {
        paths.push({
          key: "trunk",
          kind: "trunk",
          d: "M " + round(shangshu.cx) + " " + round(shangshu.y + shangshu.h) +
            " L " + round(shangshu.cx) + " " + round(group.y),
        });
      }
      return paths;
    }

    function isSeatOnlyEventBatch(events) {
      if (!events || events.length === 0) return false;
      for (var i = 0; i < events.length; i++) {
        var type = String((events[i] && events[i].type) || "");
        if (!/^(seat|department|binding|config)\./.test(type)) return false;
      }
      return true;
    }

    function describeError(error) {
      if (!error) return "请求失败";
      var code = error.code ? String(error.code) : "";
      var message = error.message ? String(error.message) : "";
      var text = "";
      if (code && message && message.indexOf(code) < 0) text = code + "：" + message;
      else text = message || code || String(error);
      var details = error.details;
      if (details && typeof details === "object" && typeof details.hint === "string" && details.hint) {
        text += "（" + details.hint + "）";
      }
      return text;
    }

    // ---------------------------------------------------------------------
    // HTTP：统一同源、解包 {ok,value}、失败抛 error.code
    // ---------------------------------------------------------------------

    async function request(method, name, query, body, options) {
      var init = {
        method: method,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      if (options && options.signal) init.signal = options.signal;

      var response;
      try {
        response = await fetch(apiPath(name, query), init);
      } catch (cause) {
        var network = new Error("网络请求失败：" + (cause && cause.message ? cause.message : String(cause)));
        network.code = "NETWORK";
        throw network;
      }

      var payload = null;
      try {
        payload = await response.json();
      } catch (cause) {
        payload = null;
      }

      if (!response.ok || !payload || payload.ok !== true) {
        var failure = (payload && payload.error) || {};
        var error = new Error(failure.message || "请求失败（HTTP " + response.status + "）");
        error.code = failure.code || "HTTP_" + response.status;
        error.details = failure.details;
        error.status = response.status;
        throw error;
      }
      return payload.value;
    }

    function apiGet(name, query, options) {
      return request("GET", name, query, undefined, options);
    }

    function apiPost(name, body, query, options) {
      return request("POST", name, query, body, options);
    }

    // ---------------------------------------------------------------------
    // 宿主服务探测（都不是 public API，缺了要让插件照常加载，不能 park）
    // ---------------------------------------------------------------------

    function readService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === "function") {
          var service = ctx.get(name);
          if (service) return service;
        }
      } catch (error) {
        // 宿主没有这个服务；忽略。
      }
      try {
        return ctx ? ctx[name] : undefined;
      } catch (error) {
        return undefined;
      }
    }

    function betterSidebarOf(ctx) {
      var candidates = [readService(ctx, "betterSidebar"), ctx && ctx.betterSidebar];
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (candidate && typeof candidate.registerTab === "function") return candidate;
      }
      return null;
    }

    function sidebarRightTabsOf(ctx) {
      var service = readService(ctx, "sidebarRightTabs");
      if (service && typeof service.register === "function") return service;
      return null;
    }

    function effectOf(ctx, factory, label) {
      if (ctx && typeof ctx.effect === "function") return ctx.effect(factory, label);
      try {
        return factory();
      } catch (error) {
        console.warn("[sansheng-workbench] " + label + " 注册失败", error);
        return undefined;
      }
    }

    function workspaceIdOf(ctx) {
      var workspace = ctx && ctx.uiWorkspace;
      if (!workspace) return null;
      var direct = workspace.currentWorkspaceId || workspace.workspaceId;
      if (direct) return String(direct);
      try {
        var selection = workspace.selection && typeof workspace.selection.getSnapshot === "function"
          ? workspace.selection.getSnapshot()
          : null;
        if (selection && selection.workspaceId) return String(selection.workspaceId);
      } catch (error) {
        // 忽略：拿不到工作区就退回 bootstrap 自带 projectId。
      }
      return null;
    }

    function displayNameOf(ctx, workspaceId) {
      var workspace = ctx && ctx.uiWorkspace;
      var name = workspace && (workspace.currentWorkspaceName || workspace.workspaceName || workspace.displayName);
      if (typeof name === "string" && name) return name;
      return workspaceId ? "工作区 " + workspaceId : "";
    }

    function canonicalRootOf(ctx) {
      var workspace = ctx && ctx.uiWorkspace;
      var root = workspace && (
        workspace.currentWorkspaceRoot ||
        workspace.workspaceRoot ||
        (workspace.currentWorkspace && workspace.currentWorkspace.root)
      );
      return typeof root === "string" && root ? root : null;
    }

    async function resolveWorkbenchProject(ctx) {
      var hostWorkspaceId = workspaceIdOf(ctx);
      var value = await apiGet("bootstrap");
      var targetId = pickProjectId(value, hostWorkspaceId);

      if (hostWorkspaceId && !targetId) {
        var body = {
          hostWorkspaceId: hostWorkspaceId,
          displayNameCache: displayNameOf(ctx, hostWorkspaceId),
        };
        var root = canonicalRootOf(ctx);
        if (root) body.canonicalRoot = root;

        var created = null;
        try {
          created = await apiPost("project", body);
        } catch (error) {
          if (error && error.code === "DUPLICATE_PROJECT" && error.details && error.details.projectId) {
            targetId = error.details.projectId;
          } else {
            throw error;
          }
        }
        if (created) {
          targetId = (created.project && created.project.id) || created.id || targetId;
        }
        if (!targetId) {
          value = await apiGet("bootstrap");
          targetId = pickProjectId(value, hostWorkspaceId) || value.projectId || null;
        }
      }

      if (targetId && value.projectId !== targetId) {
        value = await apiGet("bootstrap", { projectId: targetId });
      }
      if (!targetId) targetId = value.projectId || null;
      return { projectId: targetId, value: value };
    }

    async function findBoundProject(ctx, sessionId) {
      var cached = BOUND_PROJECT_CACHE.get(sessionId);
      if (cached) return cached;
      var first = await apiGet("bootstrap");
      var projects = Array.isArray(first.projects) ? first.projects : [];
      var hostWorkspaceId = workspaceIdOf(ctx);
      var ordered = projects.slice().sort(function (left, right) {
        var leftMatch = left && left.hostWorkspaceId === hostWorkspaceId ? 1 : 0;
        var rightMatch = right && right.hostWorkspaceId === hostWorkspaceId ? 1 : 0;
        return rightMatch - leftMatch;
      });

      function hasSession(value) {
        var seats = value && Array.isArray(value.seats) ? value.seats : [];
        for (var i = 0; i < seats.length; i++) {
          var binding = seats[i] && seats[i].binding;
          if (!binding) continue;
          if (binding.currentSessionId === sessionId || binding.sessionId === sessionId) return true;
        }
        return false;
      }

      if (first.projectId && hasSession(first)) {
        BOUND_PROJECT_CACHE.set(sessionId, first.projectId);
        return first.projectId;
      }
      for (var i = 0; i < ordered.length; i++) {
        var project = ordered[i];
        if (!project || !project.id || project.id === first.projectId) continue;
        var value = await apiGet("bootstrap", { projectId: project.id });
        if (hasSession(value)) {
          BOUND_PROJECT_CACHE.set(sessionId, project.id);
          return project.id;
        }
      }
      return null;
    }

    function openSession(ctx, sessionId) {
      var workspace = ctx && ctx.uiWorkspace;
      try {
        if (workspace && typeof workspace.openSession === "function") {
          workspace.openSession(sessionId);
          return true;
        }
        var selection = workspace && workspace.selection;
        if (selection && typeof selection.set === "function") {
          selection.set({ sessionId: sessionId });
          return true;
        }
        throw new Error("宿主未提供打开会话的接口（uiWorkspace.openSession）");
      } catch (error) {
        return error && error.message ? error.message : String(error);
      }
    }

    // ---------------------------------------------------------------------
    // 样式（照 .scratch/mock-nodes/rail.html 与 docs/preview/v01-nodes-400-*.png）
    // ---------------------------------------------------------------------

    const CSS = [
      ".wb-rail{--wb-bg:#f7f9fc;--wb-card:#ffffff;--wb-line:#e3e8ef;--wb-line-strong:#c7d8f5;--wb-ink:#0f172a;--wb-ink-2:#475467;--wb-ink-3:#98a2b3;--wb-blue:#3b82f6;--wb-green:#22c55e;--wb-amber:#f59e0b;--wb-gray:#94a3b8;--wb-wire:#c9d6ea;--wb-dashed:#d7e1f0;--wb-group-bg:rgba(255,255,255,.55);position:relative;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;background:var(--wb-bg);color:var(--wb-ink);font-size:12px;line-height:1.4;font-family:inherit;overflow:hidden}",
      ".wb-rail *,.wb-rail *::before,.wb-rail *::after{box-sizing:border-box}",
      ".wb-head{flex:none;display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:10px 14px 8px}",
      ".wb-title{font-size:12px;font-weight:600;color:var(--wb-ink-2);letter-spacing:.01em}",
      ".wb-meta{font-size:10.5px;color:var(--wb-ink-3);white-space:nowrap}",
      ".wb-tabs{flex:none;display:flex;gap:2px;margin:0 12px 8px;padding:2px;border:1px solid var(--wb-line);border-radius:8px;background:var(--wb-card)}",
      ".wb-tab{flex:1 1 0;min-width:0;border:0;background:transparent;color:var(--wb-ink-3);font:inherit;font-size:11px;line-height:1.2;padding:4px 6px;border-radius:6px;cursor:pointer}",
      ".wb-tab.is-active{background:var(--wb-bg);color:var(--wb-ink);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.05)}",
      ".wb-tab:hover{color:var(--wb-ink-2)}",
      ".wb-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 12px 16px}",
      ".wb-alert{display:flex;align-items:flex-start;gap:6px;margin:0 12px 8px;padding:6px 8px;border:1px solid #fecaca;border-radius:7px;background:#fef2f2;color:#b42318;font-size:11px;line-height:1.4;flex:none}",
      ".wb-alert.is-info{border-color:#bbf7d0;background:#f0fdf4;color:#166534}",
      ".wb-alert-text{flex:1 1 auto;min-width:0;word-break:break-word}",
      ".wb-alert button{flex:none;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:10px;line-height:1;padding:3px 5px;border-radius:4px;cursor:pointer}",
      ".wb-tree{position:relative;padding:0 0 4px}",
      ".wb-wires{position:absolute;left:0;top:0;z-index:0;pointer-events:none;overflow:visible}",
      ".wb-wire{fill:none;stroke:var(--wb-wire);stroke-width:1.2;stroke-linecap:round}",
      ".wb-lead-row{display:flex;justify-content:center;padding-top:4px}",
      ".wb-trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:48px}",
      ".wb-group{position:relative;margin-top:26px;padding:8px;border:1px dashed var(--wb-dashed);border-radius:12px;background:var(--wb-group-bg)}",
      ".wb-group-label{position:absolute;top:-9px;left:10px;padding:0 5px;border-radius:4px;background:var(--wb-bg);color:var(--wb-ink-3);font-size:9.5px;line-height:18px;letter-spacing:.02em}",
      ".wb-six{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}",
      ".wb-card{position:relative;z-index:1;display:flex;flex-direction:column;gap:1px;min-width:0;padding:8px 10px;border:1px solid var(--wb-line);border-radius:10px;background:var(--wb-card);box-shadow:0 1px 2px rgba(16,24,40,.04);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease,transform .12s ease}",
      ".wb-card:hover{border-color:var(--wb-line-strong)}",
      ".wb-card:focus-visible{outline:2px solid var(--wb-blue);outline-offset:2px}",
      ".wb-card.is-lead{width:min(184px,100%);margin:0 auto;padding:9px 12px;border-color:var(--wb-line-strong);background:linear-gradient(180deg,#fbfdff 0%,#ffffff 100%)}",
      ".wb-card.is-running{border-color:var(--wb-blue);box-shadow:0 0 0 2px rgba(59,130,246,.14),0 2px 8px rgba(59,130,246,.12)}",
      ".wb-card.is-attention{border-color:var(--wb-amber)}",
      ".wb-card.is-unavailable{opacity:.72}",
      ".wb-kicker{font-size:10px;color:var(--wb-ink-3);letter-spacing:.02em}",
      ".wb-name{font-size:15px;font-weight:600;line-height:1.25;color:var(--wb-ink)}",
      ".wb-model{font-size:11px;letter-spacing:-.01em;color:var(--wb-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".wb-status{display:flex;align-items:center;gap:5px;margin-top:1px;font-size:11px;color:var(--wb-ink-2);white-space:nowrap;min-width:0}",
      ".wb-card.has-connect .wb-status{padding-right:30px}",
      ".wb-status>span:last-child{overflow:hidden;text-overflow:ellipsis}",
      ".wb-card{min-width:0}",
      ".wb-connect{max-width:calc(100% - 10px);padding:2px 5px;font-size:9.5px}",
      ".wb-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--wb-gray)}",
      ".wb-dot.is-idle{background:var(--wb-green)}",
      ".wb-dot.is-running{background:var(--wb-blue)}",
      ".wb-dot.is-attention{background:var(--wb-amber)}",
      ".wb-connect{position:absolute;right:8px;bottom:7px;z-index:2;padding:3px 6px;border:1px solid var(--wb-line-strong);border-radius:5px;background:var(--wb-card);color:var(--wb-ink-2);font:inherit;font-size:10px;line-height:1;cursor:pointer}",
      ".wb-connect:hover{border-color:var(--wb-blue);color:var(--wb-blue)}",
      ".wb-connect:disabled{opacity:.6;cursor:default}",
      ".wb-list{display:flex;flex-direction:column;gap:6px;padding:2px 0 8px}",
      ".wb-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 2px;color:var(--wb-ink-2);font-size:11px}",
      ".wb-small-btn{border:1px solid var(--wb-line-strong);border-radius:6px;background:var(--wb-card);color:var(--wb-ink-2);font:inherit;font-size:10.5px;line-height:1;padding:4px 7px;cursor:pointer}",
      ".wb-small-btn:hover{border-color:var(--wb-blue);color:var(--wb-blue)}",
      ".wb-small-btn:disabled{opacity:.6;cursor:default}",
      ".wb-task{border:1px solid var(--wb-line);border-radius:9px;background:var(--wb-card);padding:8px 9px;display:flex;flex-direction:column;gap:2px}",
      ".wb-task-title{font-size:12px;font-weight:600;color:var(--wb-ink);word-break:break-word}",
      ".wb-task-meta{font-size:10.5px;color:var(--wb-ink-3)}",
      ".wb-task-body{margin-top:2px;font-size:11px;color:var(--wb-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".wb-task-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}",
      ".wb-small-btn.is-quiet{border-color:var(--wb-line);color:var(--wb-ink-3)}",
      ".wb-small-btn.is-quiet:hover{border-color:var(--wb-red,#d9534f);color:var(--wb-red,#d9534f)}",
      ".wb-empty{margin:10px 2px;color:var(--wb-ink-3);font-size:11px;line-height:1.5}",
      ".wb-form{display:flex;flex-direction:column;gap:6px;padding:8px;margin-bottom:2px;border:1px solid var(--wb-line);border-radius:9px;background:var(--wb-card)}",
      ".wb-input,.wb-select,.wb-textarea{width:100%;border:1px solid var(--wb-line);border-radius:6px;background:var(--wb-bg);color:var(--wb-ink);font:inherit;font-size:11px;padding:5px 6px}",
      ".wb-textarea{min-height:44px;resize:vertical}",
      ".wb-form-row{display:flex;gap:6px;align-items:center;justify-content:flex-end}",
      ".wb-artifact{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:1px solid var(--wb-line);border-radius:9px;background:var(--wb-card);color:inherit;font:inherit;padding:8px 9px;cursor:pointer}",
      ".wb-artifact:hover{border-color:var(--wb-line-strong)}",
      ".wb-artifact-name{font-size:12px;font-weight:600;color:var(--wb-ink);word-break:break-word}",
      ".wb-artifact-meta{font-size:10.5px;color:var(--wb-ink-3)}",
      ".wb-artifact.is-missing{border-style:dashed;border-color:#f2b8b5;background:#fff6f5}",
      ".wb-artifact.is-missing .wb-artifact-name{color:#b42318}",
      ".wb-artifact-flag{color:#b42318}",
      ".wb-artifact-flag.is-unknown{color:var(--wb-ink-3)}",
      ".wb-missing-note{margin:0;padding:7px 8px;border:1px solid #f2b8b5;border-radius:7px;background:#fff6f5;color:#b42318;font-size:11px;line-height:1.5}",
      ".wb-task-tag{display:inline-block;margin-right:4px;padding:0 4px;border-radius:4px;background:rgba(59,130,246,.12);color:#2563eb;font-size:9.5px;font-weight:600}",
      ".wb-task.is-new{outline:2px solid var(--wb-blue);outline-offset:1px}",
      ".wb-drawer{position:absolute;top:0;right:0;bottom:0;z-index:6;display:flex;flex-direction:column;gap:8px;width:min(280px,82%);padding:12px;overflow-y:auto;border-left:1px solid var(--wb-line);background:var(--wb-card);box-shadow:-8px 0 24px rgba(16,24,40,.08)}",
      ".wb-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".wb-drawer-title{font-size:12px;font-weight:600;color:var(--wb-ink-2)}",
      ".wb-icon-btn{border:0;background:transparent;color:var(--wb-ink-3);font:inherit;font-size:16px;line-height:1;padding:2px 4px;border-radius:4px;cursor:pointer}",
      ".wb-icon-btn:hover{background:var(--wb-bg);color:var(--wb-ink)}",
      ".wb-field{display:flex;flex-direction:column;gap:2px}",
      ".wb-field-label{font-size:10px;color:var(--wb-ink-3);letter-spacing:.02em}",
      ".wb-field-value{font-size:11.5px;color:var(--wb-ink);word-break:break-word}",
      ".wb-drawer-body{margin:0;font-size:11.5px;line-height:1.55;color:var(--wb-ink-2);white-space:pre-wrap;word-break:break-word}",
      ".wb-tab-title{display:inline-flex;align-items:center;gap:4px}",
      ".wb-main-split{display:flex;flex-direction:row;height:100%;min-width:0}",
      ".wb-main-native{flex:1 1 auto;min-width:560px;min-height:0;height:100%;display:flex;flex-direction:column}",
      ".wb-main-resizer{flex:0 0 2px;position:relative;width:2px;cursor:col-resize;background:rgba(127,127,127,.18)}",
      ".wb-main-resizer::after{content:\"\";position:absolute;top:0;bottom:0;left:-4px;right:-4px}",
      ".wb-main-resizer:hover{background:var(--wb-blue,#3b82f6)}",
      ".wb-main-rail{flex:0 0 auto;height:100%;min-width:0;overflow:hidden;border-left:1px solid rgba(127,127,127,.12)}",
      "@media (prefers-color-scheme: dark){.wb-rail{--wb-bg:#161a20;--wb-card:#1e232b;--wb-line:#2c333d;--wb-line-strong:#3a4350;--wb-ink:#e6ebf2;--wb-ink-2:#a9b4c2;--wb-ink-3:#7b8797;--wb-blue:#6ea8ff;--wb-green:#4ade80;--wb-amber:#f59e0b;--wb-gray:#5c6672;--wb-wire:#3a4350;--wb-dashed:#2f3742;--wb-group-bg:rgba(30,35,43,.6)}.wb-card.is-lead{background:linear-gradient(180deg,#1f2530 0%,#1e232b 100%);border-color:#3b4a63}.wb-card.is-running{border-color:#3b5a8a;background:#1d242f;box-shadow:0 0 0 2px rgba(110,168,255,.16),0 2px 8px rgba(110,168,255,.12)}.wb-alert{border-color:#5b2b2b;background:#2a1a1c;color:#fca5a5}.wb-alert.is-info{border-color:#245c3a;background:#12271b;color:#86efac}.wb-tabs,.wb-card,.wb-task,.wb-artifact,.wb-form{background:var(--wb-card)}.wb-tab.is-active{background:#242a33}.wb-drawer{box-shadow:-8px 0 24px rgba(0,0,0,.35)}.wb-artifact.is-missing{border-color:#6b3a36;background:#2a1c1c}.wb-artifact.is-missing .wb-artifact-name{color:#fca5a5}.wb-artifact-flag{color:#fca5a5}.wb-artifact-flag.is-unknown{color:var(--wb-ink-3)}.wb-missing-note{border-color:#6b3a36;background:#2a1c1c;color:#fca5a5}.wb-task-tag{background:rgba(110,168,255,.16);color:#9cc4ff}}",
    ].join("");

    function injectCss() {
      if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return;
      try {
        var selector = "style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]";
        if (typeof document.querySelector === "function" && document.querySelector(selector) !== null) return;
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-sansheng-liubu-mode";
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = CSS;
        if (document.head && typeof document.head.appendChild === "function") document.head.appendChild(tag);
      } catch (error) {
        // 样式失败不阻断面板功能。
      }
    }

    injectCss();

    // ---------------------------------------------------------------------
    // 纯 UI 小工具
    // ---------------------------------------------------------------------

    const BOUND_PROJECT_CACHE = new Map();

    function readRailWidth() {
      try {
        var stored = Number(localStorage.getItem(RAIL_WIDTH_KEY));
        if (isFinite(stored) && stored > 0) return clamp(stored, RAIL_MIN, RAIL_MAX);
      } catch (error) {
        // localStorage 不可用时用默认值。
      }
      return RAIL_DEFAULT;
    }

    function saveRailWidth(width) {
      try {
        localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(clamp(width, RAIL_MIN, RAIL_MAX))));
      } catch (error) {
        // 忽略。
      }
    }

    function mainTakeoverEnabled() {
      try {
        return String(localStorage.getItem(MAIN_SWITCH_KEY) || "") !== "off";
      } catch (error) {
        return true;
      }
    }

    function shortTime(value) {
      if (!value) return "";
      var text = String(value);
      return text.length >= 16 ? text.slice(0, 16).replace("T", " ") : text;
    }

    function emptyTaskForm() {
      return { title: "", objective: "", ownerRoleId: "lead" };
    }

    function seatsFor(data) {
      var byId = {};
      var rows = data && Array.isArray(data.seats) ? data.seats : [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].roleId) byId[rows[i].roleId] = rows[i];
      }
      return ROLE_ORDER.map(function (roleId) {
        if (byId[roleId]) return byId[roleId];
        var meta = ROLE_META[roleId];
        return {
          roleId: roleId,
          name: meta.name,
          short: meta.name,
          tier: meta.tier,
          group: meta.group,
          column: meta.column,
          row: meta.row,
          duty: meta.duty,
          connected: false,
          pending: true,
          pendingLabel: "尚未接通",
          activeTaskId: null,
          binding: null,
          config: null,
          placeholder: true,
        };
      });
    }

    function findResultForArtifact(results, artifact) {
      if (!Array.isArray(results) || !artifact) return null;
      if (artifact.sourceResultId) {
        for (var i = 0; i < results.length; i++) {
          if (results[i] && results[i].id === artifact.sourceResultId) return results[i];
        }
      }
      for (var j = 0; j < results.length; j++) {
        var result = results[j];
        if (result && Array.isArray(result.artifactRefs) && result.artifactRefs.indexOf(artifact.id) >= 0) return result;
      }
      return null;
    }

    // 成果存在性：missing 是宿主确认文件已不在；unknown 只表示没核验过，
    // 绝不能当成“正常”，也不能用警告色吓人。
    function existenceLabel(existence) {
      if (existence === "missing") return "文件已失效";
      if (existence === "unknown") return "位置未核验";
      return "";
    }

    // 原始 verification.status 是英文枚举，直接摆在「文件已失效」旁边会读成自相矛盾：
    // 「已核验」说的是结果被核验过，不是文件现在还在。
    function verificationLabel(status) {
      if (status === "verified") return "已核验";
      if (status === "rejected") return "未通过";
      if (status === "unverified") return "未核验";
      return "核验未知";
    }

    function revisionLabel(artifact) {
      var revision = Number(artifact && artifact.revision);
      if (!isFinite(revision) || revision < 1) revision = 1;
      revision = Math.floor(revision);
      var text = "第 " + revision + " 版";
      if (revision > 1 && artifact && artifact.revisesArtifactId) {
        text += " · 修订自上一版";
      }
      return text;
    }

    function taskKindLabel(task) {
      return task && task.kind === "revision" ? "修订" : "";
    }

    // 任务行上该有哪几个动作，纯函数，UI 与测试共用一份判断。
    function taskActionKeys(task) {
      var keys = [];
      if (!task || typeof task !== "object") return keys;
      if (task.status === "draft" || task.status === "queued") keys.push("dispatch");
      if (task.status === "queued" || task.status === "running" || task.status === "needs_attention") keys.push("cancel");
      return keys;
    }

    function conversationPhase(session, conversation) {
      if (!session || !conversation) return "blank";
      var activeTargets = conversation.activeTargets;
      var hasActiveTargets = activeTargets && typeof activeTargets.size === "number" && activeTargets.size > 0;
      if (hasActiveTargets) return "active";
      if (!session.blank && !session.awaitingFirstTurn) return "active";
      if (session.running) return "active";
      return session.promptAttempted ? "engaging" : "blank";
    }

    function useBoundProject(ctx, sessionId) {
      var state = React.useState(null);
      var projectId = state[0];
      var setProjectId = state[1];

      React.useEffect(function () {
        if (!sessionId) {
          setProjectId(null);
          return undefined;
        }
        var cancelled = false;
        findBoundProject(ctx, sessionId)
          .then(function (found) {
            if (!cancelled) setProjectId(found);
          })
          .catch(function () {
            if (!cancelled) setProjectId(null);
          });
        return function () {
          cancelled = true;
        };
      }, [ctx, sessionId]);

      return projectId;
    }

    // 分隔条的键盘语义抽成纯函数：同一套键位在真浏览器和单测里走同一条代码。
    // 不支持的键返回 null（调用方据此决定是否 preventDefault）。
    function railResizeTarget(key, options) {
      var opts = options || {};
      var width = Number(opts.width);
      if (!isFinite(width)) width = RAIL_MIN;
      var step = opts.shift ? 64 : 16;
      if (key === "ArrowLeft") return clamp(width - step, RAIL_MIN, RAIL_MAX);
      if (key === "ArrowRight") return clamp(width + step, RAIL_MIN, RAIL_MAX);
      if (key === "Home") return RAIL_MIN;
      if (key === "End") return RAIL_MAX;
      return null;
    }

    function useRailWidth() {
      var state = React.useState(readRailWidth());
      var width = state[0];
      var setWidth = state[1];
      var cleanupRef = React.useRef(null);

      React.useEffect(function () {
        return function () {
          if (cleanupRef.current) cleanupRef.current();
        };
      }, []);

      function onMouseDown(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        var session = { x: Number(event.clientX) || 0, width: width, last: width };
        function onMove(moveEvent) {
          var next = clamp(session.width - ((Number(moveEvent.clientX) || 0) - session.x), RAIL_MIN, RAIL_MAX);
          session.last = next;
          setWidth(next);
        }
        function cleanup() {
          if (typeof document !== "undefined" && document.removeEventListener) {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
          }
          cleanupRef.current = null;
        }
        function onUp() {
          cleanup();
          saveRailWidth(session.last);
        }
        if (typeof document !== "undefined" && document.addEventListener) {
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
          cleanupRef.current = cleanup;
        }
      }

      function nudge(delta) {
        var next = clamp(width + delta, RAIL_MIN, RAIL_MAX);
        if (next === width) return;
        setWidth(next);
        saveRailWidth(next);
      }

      return [width, onMouseDown, nudge];
    }

    // ---------------------------------------------------------------------
    // 组件
    // ---------------------------------------------------------------------

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error) {
        try {
          console.error("[sansheng-workbench] 面板渲染失败", error);
        } catch (ignored) {
          // 忽略日志失败。
        }
      }

      render() {
        if (this.state.error) {
          return h("div", { className: "wb-alert", role: "alert" }, [
            h("span", { className: "wb-alert-text" }, "工作台面板渲染失败：" + (this.state.error.message || String(this.state.error))),
          ]);
        }
        return this.props.children;
      }
    }

    function SeatCard(props) {
      var seat = props.seat;
      var meta = ROLE_META[seat.roleId] || {};
      var binding = seat.binding || null;
      var sessionId = binding && (binding.currentSessionId || binding.sessionId);
      var status = seat.placeholder
        ? "loading"
        : (binding && binding.status) || (seat.connected ? "idle" : "uninitialized");
      var label = seat.placeholder ? "读取中…" : statusOf(status);
      var name = seatDisplayName(seat);
      var model = formatModelLine(seat.config);
      var fullModel = modelTitle(seat.config);
      var isLead = seat.roleId === "lead";
      var showConnect = !seat.placeholder && !seat.connected;
      var classes = ["wb-card"];
      if (isLead) classes.push("is-lead");
      if (status === "running") classes.push("is-running");
      if (status === "needs_attention") classes.push("is-attention");
      if (status === "unavailable") classes.push("is-unavailable");
      if (showConnect) classes.push("has-connect");

      function activate() {
        if (props.onActivate) props.onActivate(seat);
      }

      function onKeyDown(event) {
        if (!event) return;
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          if (typeof event.preventDefault === "function") event.preventDefault();
          activate();
        }
      }

      var children = [
        h("span", { className: "wb-kicker", key: "kicker" }, meta.kicker || ""),
        h("span", { className: "wb-name", key: "name" }, name),
        h("span", { className: "wb-model", key: "model", title: fullModel }, model),
        h("span", { className: "wb-status", key: "status" }, [
          h("span", { className: "wb-dot is-" + status, key: "dot" }),
          h("span", { key: "label" }, label),
        ]),
      ];

      if (showConnect) {
        children.push(h("button", {
          key: "connect",
          type: "button",
          className: "wb-connect",
          disabled: Boolean(props.connecting),
          onClick: function (event) {
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            if (props.onConnect) props.onConnect(seat);
          },
        }, props.connecting ? "接通中…" : "接通"));
      }

      return h("div", {
        className: classes.join(" "),
        ref: props.cardRef,
        role: "button",
        tabIndex: 0,
        title: [seat.duty || meta.duty || "", fullModel].filter(Boolean).join(" · "),
        "aria-label": (seat.name || name) + "，" + label + (sessionId ? "，点击打开会话" : ""),
        onClick: activate,
        onKeyDown: onKeyDown,
      }, children);
    }

    function WorkbenchRail(props) {
      var ctx = props.ctx;
      var compact = props.compact !== false;

      var viewState = React.useState("court");
      var view = viewState[0];
      var setView = viewState[1];

      var projectState = React.useState(props.projectId || null);
      var projectId = projectState[0];
      var setProjectId = projectState[1];

      var dataState = React.useState(null);
      var data = dataState[0];
      var setData = dataState[1];

      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];

      // 提示语气：成功用 info（绿），失败/警告用 error（红）。默认红——凡是没显式说
      // "这是好消息"的提示，多半是用户在排障。
      var noticeToneState = React.useState("error");
      var noticeTone = noticeToneState[0];
      var setNoticeTone = noticeToneState[1];

      function announce(message, tone) {
        setNoticeTone(tone || "error");
        setNotice(message);
      }

      var connectingState = React.useState(null);
      var connecting = connectingState[0];
      var setConnecting = connectingState[1];

      var artifactState = React.useState(null);
      var selectedArtifactId = artifactState[0];
      var setSelectedArtifactId = artifactState[1];

      var formOpenState = React.useState(false);
      var taskFormOpen = formOpenState[0];
      var setTaskFormOpen = formOpenState[1];

      var formState = React.useState(emptyTaskForm());
      var taskForm = formState[0];
      var setTaskForm = formState[1];

      var taskBusyState = React.useState(false);
      var taskBusy = taskBusyState[0];
      var setTaskBusy = taskBusyState[1];

      // 任务行上的「派工 / 取消」：存 taskId，防止同一行被连点两次。
      var dispatchBusyState = React.useState(null);
      var dispatchBusy = dispatchBusyState[0];
      var setDispatchBusy = dispatchBusyState[1];

      var reviseOpenState = React.useState(false);
      var reviseOpen = reviseOpenState[0];
      var setReviseOpen = reviseOpenState[1];

      var reviseTextState = React.useState("");
      var reviseText = reviseTextState[0];
      var setReviseText = reviseTextState[1];

      // null | "draft" | "queued"：标明正在提交哪个按钮，防止重复点。
      var reviseBusyState = React.useState(null);
      var reviseBusy = reviseBusyState[0];
      var setReviseBusy = reviseBusyState[1];

      var highlightTaskState = React.useState(null);
      var highlightTaskId = highlightTaskState[0];
      var setHighlightTaskId = highlightTaskState[1];
      var highlightTimerRef = React.useRef(null);

      var reloadState = React.useState(0);
      var reloadToken = reloadState[0];
      var setReloadToken = reloadState[1];

      var projectIdRef = React.useRef(projectId);
      var seqRef = React.useRef(0);
      var hostRef = React.useRef(null);
      var loadTokenRef = React.useRef(0);
      var aliveRef = React.useRef(true);
      var treeRef = React.useRef(null);
      var leadRef = React.useRef(null);
      var groupRef = React.useRef(null);
      var sanRefs = React.useRef({});

      // 首帧先给一份 400px 的几何连线，保证即使宿主/预览器不跑 effect 也能看见树；
      // 真实浏览器随后用 getBoundingClientRect 校正到实际栏宽。
      var initialLayout = computeRailLayout(400);
      var wireState = React.useState({
        width: initialLayout.width,
        height: initialLayout.height,
        paths: wirePathsFromLayout(initialLayout),
      });
      var wires = wireState[0];
      var setWires = wireState[1];

      projectIdRef.current = projectId;

      React.useEffect(function () {
        aliveRef.current = true;
        return function () {
          aliveRef.current = false;
          if (highlightTimerRef.current) {
            clearTimeout(highlightTimerRef.current);
            highlightTimerRef.current = null;
          }
        };
      }, []);

      function applyBootstrap(result, token) {
        if (token !== undefined && token !== loadTokenRef.current) return;
        if (!aliveRef.current) return;
        projectIdRef.current = result.projectId;
        seqRef.current = Number(result.value && result.value.eventSeq) || 0;
        setProjectId(result.projectId);
        setData(result.value);
      }

      // 首屏 / 项目切换 / 手动重试：整树重取，绝不沿用上一个项目的 seats。
      React.useEffect(function () {
        var cancelled = false;
        var token = ++loadTokenRef.current;
        setData(null);
        setError(null);
        setSelectedArtifactId(null);
        setNotice(null);
        hostRef.current = workspaceIdOf(ctx);

        var loading;
        if (props.projectId) {
          loading = apiGet("bootstrap", { projectId: props.projectId }).then(function (value) {
            return { projectId: props.projectId, value: value };
          });
        } else {
          loading = resolveWorkbenchProject(ctx);
        }

        loading.then(function (result) {
          if (cancelled) return;
          applyBootstrap(result, token);
        }).catch(function (failure) {
          if (cancelled) return;
          if (token !== loadTokenRef.current) return;
          setError(describeError(failure));
        });

        return function () {
          cancelled = true;
        };
      }, [ctx, props.projectId, reloadToken]);

      // 工作区切换：换项目就整树重取。
      React.useEffect(function () {
        if (props.projectId) return undefined;
        var workspace = ctx && ctx.uiWorkspace;
        if (!workspace) return undefined;
        var disposers = [];
        var pendingToken = 0;
        var cancelled = false;

        function check() {
          var next = workspaceIdOf(ctx);
          if (!next || next === hostRef.current) return;
          hostRef.current = next;
          var token = ++pendingToken;
          var loadToken = ++loadTokenRef.current;
          setData(null);
          setSelectedArtifactId(null);
          setNotice(null);
          setError(null);
          resolveWorkbenchProject(ctx).then(function (result) {
            if (cancelled || token !== pendingToken) return;
            applyBootstrap(result, loadToken);
          }).catch(function (failure) {
            if (cancelled || token !== pendingToken) return;
            if (loadToken === loadTokenRef.current) setError(describeError(failure));
          });
        }

        var selection = workspace.selection;
        if (selection && typeof selection.subscribe === "function") {
          var off = selection.subscribe(check);
          if (typeof off === "function") disposers.push(off);
        }
        if (typeof workspace.subscribe === "function") {
          var offWorkspace = workspace.subscribe(check);
          if (typeof offWorkspace === "function") disposers.push(offWorkspace);
        }
        if (typeof workspace.on === "function") {
          var offEvent = workspace.on("change", check);
          if (typeof offEvent === "function") disposers.push(offEvent);
        }

        return function () {
          cancelled = true;
          for (var i = 0; i < disposers.length; i++) {
            try {
              disposers[i]();
            } catch (ignored) {
              // 忽略取消订阅失败。
            }
          }
        };
      }, [ctx, props.projectId]);

      // 长轮询：事件只作为“该刷新了”的信号，状态一律回读账本，绝不猜。
      React.useEffect(function () {
        if (!projectId) return undefined;
        var stopped = false;
        var paused = false;
        var inflight = false;
        var timer = null;
        var controller = null;

        function schedule(delay) {
          if (stopped) return;
          timer = setTimeout(run, delay);
        }

        function refresh(mode) {
          return apiGet("bootstrap", { projectId: projectId }).then(function (value) {
            if (stopped || !aliveRef.current) return null;
            if (projectIdRef.current !== projectId) return null;
            var seq = Number(value && value.eventSeq);
            if (isFinite(seq)) seqRef.current = Math.max(seqRef.current, seq);
            setData(function (previous) {
              if (!previous || previous.projectId !== value.projectId) return value;
              if (mode === "seats") {
                return assign({}, previous, { seats: value.seats, eventSeq: value.eventSeq });
              }
              return assign({}, previous, {
                seats: value.seats,
                tasks: value.tasks,
                artifacts: value.artifacts,
                results: value.results,
                project: value.project || previous.project,
                projects: value.projects || previous.projects,
                eventSeq: value.eventSeq,
              });
            });
            return value;
          });
        }

        function run() {
          if (stopped || inflight) return;
          timer = null;
          if (paused) {
            schedule(1500);
            return;
          }
          inflight = true;
          var localController = typeof AbortController === "function" ? new AbortController() : null;
          controller = localController;

          apiGet("events", { projectId: projectId, since: seqRef.current }, {
            signal: localController ? localController.signal : undefined,
          }).then(function (result) {
            if (stopped) return undefined;
            var events = result && Array.isArray(result.events) ? result.events : [];
            if (result && result.reset) {
              seqRef.current = Number(result.seq) || 0;
              return refresh("full").then(function () {
                schedule(120);
              });
            }
            if (events.length > 0) {
              var merged = mergeEvents([], events);
              var maxSeq = Number(result.seq) || 0;
              for (var i = 0; i < merged.length; i++) {
                maxSeq = Math.max(maxSeq, Number(merged[i].seq) || 0);
              }
              seqRef.current = Math.max(seqRef.current, maxSeq);
              var mode = isSeatOnlyEventBatch(merged) ? "seats" : "full";
              return refresh(mode).then(function () {
                schedule(result.hasMore ? 0 : 120);
              });
            }
            var seq = Number(result && result.seq);
            if (isFinite(seq)) seqRef.current = Math.max(seqRef.current, seq);
            schedule(result && result.hasMore ? 0 : 250);
            return undefined;
          }).catch(function (failure) {
            if (stopped) return;
            if (failure && failure.name === "AbortError") return;
            setNotice(describeError(failure));
            schedule(2500);
          }).then(function () {
            inflight = false;
            controller = null;
          });
        }

        function onVisibilityChange() {
          if (typeof document !== "undefined" && document.hidden) {
            paused = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            if (controller) controller.abort();
            return;
          }
          paused = false;
          if (!inflight) run();
        }

        if (typeof document !== "undefined" && document.addEventListener) {
          document.addEventListener("visibilitychange", onVisibilityChange);
        }
        run();

        return function () {
          stopped = true;
          if (timer) clearTimeout(timer);
          if (controller) controller.abort();
          if (typeof document !== "undefined" && document.removeEventListener) {
            document.removeEventListener("visibilitychange", onVisibilityChange);
          }
        };
      }, [projectId]);

      // 连线：每次渲染后按真实 rect 现算，窄栏/字体差异都不会错位。
      React.useEffect(function () {
        if (view !== "court") return undefined;
        var tree = treeRef.current;
        if (!tree || typeof tree.getBoundingClientRect !== "function") return undefined;

        // 真实布局量不到时（离线预览替身 DOM、隐藏 tab 里 rect 全 0）的兜底：
        // 用 computeRailLayout 的几何盒子算同一组贝塞尔，公式与真实测量完全一致。
        function fallbackWires(widthHint) {
          var width = Number(widthHint) > 0 ? Number(widthHint) : 0;
          if (!width) {
            try {
              width = tree.clientWidth || 0;
            } catch (ignored) {
              width = 0;
            }
          }
          var layout = computeRailLayout(width || 400);
          return { width: layout.width, height: layout.height, paths: wirePathsFromLayout(layout) };
        }

        function measure() {
          var box = tree.getBoundingClientRect();
          if (!box || !box.width) {
            setWires(fallbackWires(0));
            return;
          }

          function rel(element) {
            var rect = element.getBoundingClientRect();
            return {
              top: rect.top - box.top,
              bottom: rect.bottom - box.top,
              left: rect.left - box.left,
              cx: rect.left - box.left + rect.width / 2,
            };
          }

          var paths = [];
          var lead = leadRef.current;
          if (lead) {
            var leadRect = rel(lead);
            var sanIds = ["zhongshu", "shangshu", "menxia"];
            for (var i = 0; i < sanIds.length; i++) {
              var element = sanRefs.current[sanIds[i]];
              if (!element) continue;
              var cardRect = rel(element);
              var y0 = leadRect.bottom;
              var y1 = cardRect.top;
              if (!(y1 > y0)) continue;
              paths.push({
                key: "lead-" + sanIds[i],
                kind: "branch",
                d: branchPathD(leadRect.cx, y0, cardRect.cx, y1),
              });
            }
          }

          var shangshu = sanRefs.current.shangshu;
          var group = groupRef.current;
          if (shangshu && group) {
            var shangshuRect = rel(shangshu);
            var groupRect = rel(group);
            if (groupRect.top > shangshuRect.bottom) {
              paths.push({
                key: "trunk",
                kind: "trunk",
                d: "M " + round(shangshuRect.cx) + " " + round(shangshuRect.bottom) +
                  " L " + round(shangshuRect.cx) + " " + round(groupRect.top),
              });
            }
          }

          if (paths.length === 0) {
            // 关键 rect 全是 0（替身 DOM）时不能把 0 传给 <svg width>。
            setWires(fallbackWires(box.width));
            return;
          }
          setWires({ width: Math.round(box.width), height: Math.round(box.height), paths: paths });
        }

        measure();
        var observer = null;
        if (typeof ResizeObserver === "function") {
          observer = new ResizeObserver(function () {
            measure();
          });
          observer.observe(tree);
        }
        if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("resize", measure);

        return function () {
          if (observer) observer.disconnect();
          if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("resize", measure);
        };
      }, [view, data]);

      var seats = seatsFor(data);
      var connectedCount = 0;
      for (var seatIndex = 0; seatIndex < seats.length; seatIndex++) {
        if (seats[seatIndex].connected) connectedCount += 1;
      }
      var metaText = "十席 · " + connectedCount + " 席已接通";

      function activateSeat(seat) {
        var binding = seat && seat.binding;
        var sessionId = binding && (binding.currentSessionId || binding.sessionId);
        if (!sessionId) return;
        var failure = openSession(ctx, sessionId);
        if (typeof failure === "string") setNotice("打开会话失败：" + failure);
      }

      function connectSeat(seat) {
        if (!projectId || connecting) return;
        setConnecting(seat.roleId);
        setNotice(null);
        apiPost("connect", { projectId: projectId, roleId: seat.roleId }).then(function (result) {
          var sessionId = result && (
            result.sessionId ||
            (result.seat && result.seat.binding && (result.seat.binding.currentSessionId || result.seat.binding.sessionId))
          );
          return apiGet("bootstrap", { projectId: projectId }).then(function (value) {
            if (!aliveRef.current) return;
            if (projectIdRef.current === projectId) {
              seqRef.current = Math.max(seqRef.current, Number(value.eventSeq) || 0);
              setData(value);
            }
            if (sessionId) {
              var failure = openSession(ctx, sessionId);
              if (typeof failure === "string") {
                announce("已接通，但打开会话失败：" + failure, "error");
              } else {
                announce("已接通。现在可以去任务页派工了。", "info");
              }
            } else {
              announce("已接通，但宿主没有返回会话号；请重试或检查宿主会话能力。", "error");
            }
          });
        }).catch(function (failure) {
          setNotice(describeError(failure));
        }).then(function () {
          setConnecting(null);
        });
      }

      function submitTask(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (!projectId) {
          setNotice("还没有定位到工作台项目，无法新建任务。");
          return;
        }
        var title = String(taskForm.title || "").trim();
        var objective = String(taskForm.objective || "").trim();
        if (!title || !objective) {
          setNotice("新建任务需要填写标题和目标。");
          return;
        }
        setTaskBusy(true);
        setNotice(null);
        apiPost("task", {
          projectId: projectId,
          title: title,
          objective: objective,
          ownerRoleId: taskForm.ownerRoleId || "lead",
          sourceRoleId: "lead",
          // 服务端 queued 要求该部门已接通会话；界面不替用户做这个决定，先存草稿。
          status: "draft",
        }).then(function () {
          return apiGet("bootstrap", { projectId: projectId });
        }).then(function (value) {
          if (!aliveRef.current) return;
          if (projectIdRef.current === projectId) {
            seqRef.current = Math.max(seqRef.current, Number(value.eventSeq) || 0);
            setData(value);
          }
          setTaskForm(emptyTaskForm());
          setTaskFormOpen(false);
          announce("已存为草稿。去任务页点「派工」才会交给部门。", "info");
        }).catch(function (failure) {
          setNotice(describeError(failure));
        }).then(function () {
          setTaskBusy(false);
        });
      }

      // 派工：把队列里的任务真正交给主责部门的会话。
      // 宿主的 /dispatch 需要 targetSessionId + bindingGeneration 才肯真的发送；
      // 缺这两项时后端只会把派发记成 prepared（"已备好、没发出"），所以这里先检查席位。
      function dispatchTaskItem(task) {
        if (!projectId || !task || dispatchBusy) return;
        var seat = null;
        for (var i = 0; i < seats.length; i += 1) {
          if (seats[i] && seats[i].roleId === task.ownerRoleId) {
            seat = seats[i];
            break;
          }
        }
        var binding = seat && seat.binding;
        var sessionId = binding && (binding.currentSessionId || binding.sessionId);
        if (!sessionId) {
          setNotice("「" + (ROLE_META[task.ownerRoleId] ? ROLE_META[task.ownerRoleId].name : task.ownerRoleId) + "」还没接通会话，先在朝堂里点「接通」。");
          return;
        }
        setDispatchBusy(task.id);
        setNotice(null);
        var body = {
          projectId: projectId,
          taskId: task.id,
          // 幂等键：同一张任务重复点不会派出两份，后端会返回既有那条。
          idempotencyKey: "ui:" + task.id,
          sourceRoleId: "lead",
          targetRoleId: task.ownerRoleId,
          targetSessionId: sessionId,
          bindingGeneration: binding.bindingGeneration,
          mode: "queue",
        };
        apiPost("dispatch", body).then(function (result) {
          var record = result && (result.dispatch || result);
          var status = record && (record.status || record.state);
          return apiGet("bootstrap", { projectId: projectId }).then(function (value) {
            if (aliveRef.current && projectIdRef.current === projectId) {
              seqRef.current = Math.max(seqRef.current, Number(value.eventSeq) || 0);
              setData(value);
            }
            if (status === "accepted") announce("已派出，部门会话里能看到这条任务。", "info");
            else if (status === "prepared") announce("已记入台账，但宿主没接上会话层，暂时没有真的发出。", "error");
            else if (status === "unknown") announce("宿主可能已经收到，但账上没拿到确认；先别重派，等对账。", "error");
            else if (result && result.duplicate) announce("这条任务之前已经派过，没有重复发送。", "info");
          });
        }).catch(function (failure) {
          setNotice(describeError(failure));
        }).then(function () {
          setDispatchBusy(null);
        });
      }

      function cancelTaskItem(task) {
        if (!projectId || !task || dispatchBusy) return;
        setDispatchBusy(task.id);
        setNotice(null);
        apiPost("task/cancel", { projectId: projectId, taskId: task.id }).then(function () {
          return apiGet("bootstrap", { projectId: projectId });
        }).then(function (value) {
          if (!aliveRef.current) return;
          if (projectIdRef.current === projectId) {
            seqRef.current = Math.max(seqRef.current, Number(value.eventSeq) || 0);
            setData(value);
          }
          announce("已取消。", "info");
        }).catch(function (failure) {
          setNotice(describeError(failure));
        }).then(function () {
          setDispatchBusy(null);
        });
      }

      // A22：不重跑三省，只给原主责部门开一条修订任务。
      function submitRevision(artifact, status) {
        if (!projectId || !artifact) {
          setNotice("还没有定位到工作台项目或成果，无法提交修订。");
          return;
        }
        var instruction = String(reviseText || "").trim();
        if (!instruction) {
          setNotice("请先写清楚要主责部门改什么。");
          return;
        }
        if (reviseBusy) return;
        var targetProjectId = projectId;
        setReviseBusy(status);
        setNotice(null);
        apiPost("artifact/revision", {
          projectId: targetProjectId,
          artifactId: artifact.id,
          instruction: instruction,
          status: status,
        }).then(function (value) {
          var createdTaskId = value && value.task && value.task.id ? value.task.id : null;
          return apiGet("bootstrap", { projectId: targetProjectId }).then(function (next) {
            if (!aliveRef.current || projectIdRef.current !== targetProjectId) return;
            seqRef.current = Math.max(seqRef.current, Number(next && next.eventSeq) || 0);
            setData(next);
            setReviseOpen(false);
            setReviseText("");
            setSelectedArtifactId(null);
            setView("tasks");
            if (createdTaskId) {
              setHighlightTaskId(createdTaskId);
              if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
              highlightTimerRef.current = setTimeout(function () {
                highlightTimerRef.current = null;
                if (aliveRef.current) setHighlightTaskId(null);
              }, 2600);
            }
          });
        }).catch(function (failure) {
          if (!aliveRef.current) return;
          var message = describeError(failure);
          // 服务端 INVALID_STATE 的原文就是「尚未接通会话」；这里补一句怎么解决。
          if (failure && (failure.code === "INVALID_STATE" || String(message).indexOf("尚未接通") >= 0)) {
            message += " 请先在「朝堂」里接通主责部门，再点「直接派工」。";
          }
          setNotice(message);
        }).then(function () {
          if (aliveRef.current) setReviseBusy(null);
        });
      }

      function switchView(next) {
        setView(next);
        if (next !== "artifacts") {
          setSelectedArtifactId(null);
          setReviseOpen(false);
          setReviseText("");
          setReviseBusy(null);
        }
      }

      function tabButton(key, label) {
        var active = view === key;
        return h("button", {
          key: key,
          type: "button",
          role: "tab",
          "aria-selected": active,
          className: "wb-tab" + (active ? " is-active" : ""),
          onClick: function () {
            switchView(key);
          },
        }, label);
      }

      function renderCourt() {
        var seatNodes = seats;
        var byId = {};
        for (var i = 0; i < seatNodes.length; i++) byId[seatNodes[i].roleId] = seatNodes[i];

        function cardRef(roleId) {
          return function (element) {
            if (roleId === "lead") leadRef.current = element;
            if (roleId === "zhongshu" || roleId === "shangshu" || roleId === "menxia") {
              sanRefs.current[roleId] = element;
            }
          };
        }

        function renderCard(roleId) {
          var seat = byId[roleId];
          if (!seat) return null;
          return h(SeatCard, {
            key: roleId,
            seat: seat,
            cardRef: cardRef(roleId),
            connecting: connecting === roleId,
            onActivate: activateSeat,
            onConnect: connectSeat,
          });
        }

        var sanIds = ["zhongshu", "shangshu", "menxia"];
        var firstRow = ["libu", "hubu", "lipu"];
        var secondRow = ["bingbu", "xingbu", "gongbu"];

        return h("div", { className: "wb-tree", ref: treeRef }, [
          h("svg", {
            key: "wires",
            className: "wb-wires",
            width: wires.width || 0,
            height: wires.height || 0,
            "aria-hidden": "true",
          }, wires.paths.map(function (wire) {
            return h("path", {
              key: wire.key,
              className: wire.kind === "trunk" ? "wb-wire is-trunk" : "wb-wire",
              d: wire.d,
            });
          })),
          h("div", { className: "wb-lead-row", key: "lead" }, [renderCard("lead")]),
          h("div", { className: "wb-trio", key: "sansheng" }, sanIds.map(renderCard)),
          h("div", { className: "wb-group", ref: groupRef, key: "ministries" }, [
            h("span", { className: "wb-group-label", key: "label" }, "六部 · 同级"),
            h("div", { className: "wb-six", key: "six" }, firstRow.concat(secondRow).map(renderCard)),
          ]),
        ]);
      }

      function renderTasks() {
        var tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
        var ownerOptions = ROLE_ORDER.map(function (roleId) {
          return h("option", { key: roleId, value: roleId }, ROLE_META[roleId].name);
        });

        return h("div", { className: "wb-list" }, [
          h("div", { className: "wb-list-head", key: "head" }, [
            h("span", { key: "count" }, "任务 · " + tasks.length),
            h("button", {
              key: "new",
              type: "button",
              className: "wb-small-btn",
              onClick: function () {
                setTaskFormOpen(!taskFormOpen);
              },
            }, taskFormOpen ? "收起" : "新建"),
          ]),
          taskFormOpen ? h("form", { className: "wb-form", key: "form", onSubmit: submitTask }, [
            h("input", {
              key: "title",
              className: "wb-input",
              placeholder: "标题",
              value: taskForm.title,
              onChange: function (event) {
                setTaskForm(assign({}, taskForm, { title: event.target.value }));
              },
            }),
            h("textarea", {
              key: "objective",
              className: "wb-textarea",
              placeholder: "目标（交给部门做什么）",
              value: taskForm.objective,
              onChange: function (event) {
                setTaskForm(assign({}, taskForm, { objective: event.target.value }));
              },
            }),
            h("select", {
              key: "owner",
              className: "wb-select",
              value: taskForm.ownerRoleId,
              onChange: function (event) {
                setTaskForm(assign({}, taskForm, { ownerRoleId: event.target.value }));
              },
            }, ownerOptions),
            h("div", { className: "wb-form-row", key: "actions" }, [
              h("button", { key: "submit", type: "submit", className: "wb-small-btn", disabled: taskBusy }, taskBusy ? "提交中…" : "存为草稿"),
            ]),
          ]) : null,
          tasks.length === 0 ? h("p", { className: "wb-empty", key: "empty" }, "这个项目还没有任务。点「新建」先存一张草稿。") : null,
          tasks.map(function (task) {
            var owner = task.ownerRoleId && ROLE_META[task.ownerRoleId] ? ROLE_META[task.ownerRoleId].name : (task.ownerRoleId || "—");
            var status = TASK_STATUS_LABELS[task.status] || task.status || "—";
            var kind = taskKindLabel(task);
            var titleText = task.title || "（未命名）";
            var busy = dispatchBusy === task.id;
            var actionKeys = taskActionKeys(task);
            var canDispatch = actionKeys.indexOf("dispatch") !== -1;
            var canCancel = actionKeys.indexOf("cancel") !== -1;
            var actions = [];
            if (canDispatch) {
              actions.push(h("button", {
                key: "dispatch",
                type: "button",
                className: "wb-small-btn",
                disabled: busy,
                title: "把这条任务交给主责部门的会话",
                onClick: function (event) {
                  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                  dispatchTaskItem(task);
                },
              }, busy ? "派工中…" : "派工"));
            }
            if (canCancel) {
              actions.push(h("button", {
                key: "cancel",
                type: "button",
                className: "wb-small-btn is-quiet",
                disabled: busy,
                title: "取消这条任务（不影响已经发生的对话）",
                onClick: function (event) {
                  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
                  cancelTaskItem(task);
                },
              }, "取消"));
            }
            return h("div", {
              className: "wb-task" + (highlightTaskId && task.id === highlightTaskId ? " is-new" : ""),
              key: task.id || task.title,
            }, [
              h("div", { className: "wb-task-title", key: "title" }, kind
                ? [h("span", { className: "wb-task-tag", key: "kind" }, kind), titleText]
                : titleText),
              h("div", { className: "wb-task-meta", key: "meta" }, owner + " · " + status + (task.updatedAt ? " · " + shortTime(task.updatedAt) : "")),
              task.objective ? h("div", { className: "wb-task-body", key: "body" }, task.objective) : null,
              actions.length ? h("div", { className: "wb-task-actions", key: "actions" }, actions) : null,
            ]);
          }),
        ]);
      }

      function renderArtifacts() {
        var artifacts = data && Array.isArray(data.artifacts) ? data.artifacts : [];
        return h("div", { className: "wb-list" }, [
          h("div", { className: "wb-list-head", key: "head" }, [
            h("span", { key: "count" }, "成果 · " + artifacts.length),
            h("span", { key: "hint", style: { fontSize: "10px", color: "var(--wb-ink-3)" } }, "点一行看详情"),
          ]),
          artifacts.length === 0 ? h("p", { className: "wb-empty", key: "empty" }, "这个项目还没有登记成果。") : null,
          artifacts.map(function (artifact) {
            var owner = artifact.ownerRoleId && ROLE_META[artifact.ownerRoleId] ? ROLE_META[artifact.ownerRoleId].name : (artifact.ownerRoleId || "—");
            var verify = artifact.verification && artifact.verification.status ? artifact.verification.status : "unverified";
            var existence = artifact.existence;
            var flag = existenceLabel(existence);
            var missing = existence === "missing";
            var metaChildren = [owner + " · " + (artifact.mediaType || "未知类型") + " · " + verificationLabel(verify)];
            if (flag) {
              metaChildren.push(h("span", {
                className: "wb-artifact-flag" + (existence === "unknown" ? " is-unknown" : ""),
                key: "existence",
              }, " · " + flag));
            }
            return h("button", {
              key: artifact.id || artifact.fileRef,
              type: "button",
              className: "wb-artifact" + (missing ? " is-missing" : ""),
              title: (artifact.displayName || artifact.fileRef || artifact.id) +
                (artifact.fileRef && artifact.fileRef !== artifact.displayName ? " · " + artifact.fileRef : "") +
                (flag ? " · " + flag : ""),
              onClick: function () {
                setSelectedArtifactId(artifact.id);
                setReviseOpen(false);
                setReviseText("");
                setReviseBusy(null);
                setNotice(null);
              },
            }, [
              h("span", { className: "wb-artifact-name", key: "name" }, artifact.displayName || artifact.fileRef || artifact.id),
              h("span", { className: "wb-artifact-meta", key: "meta" }, metaChildren),
            ]);
          }),
        ]);
      }

      function renderDrawer() {
        if (!selectedArtifactId) return null;
        var artifacts = data && Array.isArray(data.artifacts) ? data.artifacts : [];
        var artifact = null;
        for (var i = 0; i < artifacts.length; i++) {
          if (artifacts[i] && artifacts[i].id === selectedArtifactId) {
            artifact = artifacts[i];
            break;
          }
        }
        if (!artifact) return null;
        var related = findResultForArtifact(data && data.results, artifact);
        var owner = artifact.ownerRoleId && ROLE_META[artifact.ownerRoleId] ? ROLE_META[artifact.ownerRoleId].name : (artifact.ownerRoleId || "—");
        var verify = artifact.verification && artifact.verification.status ? artifact.verification.status : "unverified";

        var reviseForm = reviseOpen ? h("form", {
          className: "wb-form",
          key: "revise-form",
          onSubmit: function (event) {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            submitRevision(artifact, "draft");
          },
        }, [
          h("textarea", {
            key: "text",
            className: "wb-textarea",
            placeholder: "要改什么？写清楚交给主责部门。",
            value: reviseText,
            onChange: function (event) {
              setReviseText(event.target.value);
            },
          }),
          h("div", { className: "wb-form-row", key: "actions" }, [
            h("button", {
              key: "draft",
              type: "submit",
              className: "wb-small-btn",
              disabled: Boolean(reviseBusy),
            }, reviseBusy === "draft" ? "保存中…" : "存为草稿"),
            h("button", {
              key: "queue",
              type: "button",
              className: "wb-small-btn",
              disabled: Boolean(reviseBusy),
              onClick: function () {
                submitRevision(artifact, "queued");
              },
            }, reviseBusy === "queued" ? "派工中…" : "直接派工"),
          ]),
        ]) : null;

        return h("aside", { className: "wb-drawer", role: "dialog", "aria-label": "成果详情" }, [
          h("div", { className: "wb-drawer-head", key: "head" }, [
            h("span", { className: "wb-drawer-title", key: "title" }, "成果"),
            h("button", {
              key: "close",
              type: "button",
              className: "wb-icon-btn",
              "aria-label": "关闭",
              onClick: function () {
                setSelectedArtifactId(null);
                setReviseOpen(false);
                setReviseText("");
                setReviseBusy(null);
              },
            }, "×"),
          ]),
          h("div", { className: "wb-field", key: "revision" }, [
            h("span", { className: "wb-field-label", key: "label" }, "版本"),
            h("span", { className: "wb-field-value", key: "value" }, revisionLabel(artifact)),
          ]),
          artifact.existence === "missing" ? h("p", { className: "wb-missing-note", key: "missing" },
            "这份文件在磁盘上找不到了，记录还在，可以重新登记或找主责部门补一份。") : null,
          h("div", { className: "wb-field", key: "name" }, [
            h("span", { className: "wb-field-label", key: "label" }, "名称"),
            h("span", { className: "wb-field-value", key: "value" }, artifact.displayName || "（未命名）"),
          ]),
          h("div", { className: "wb-field", key: "owner" }, [
            h("span", { className: "wb-field-label", key: "label" }, "部门 / 任务"),
            h("span", { className: "wb-field-value", key: "value" }, owner + " · " + (artifact.taskId || "未关联任务")),
          ]),
          h("div", { className: "wb-field", key: "file" }, [
            h("span", { className: "wb-field-label", key: "label" }, "文件引用"),
            h("span", { className: "wb-field-value", key: "value" }, artifact.fileRef || "—"),
          ]),
          h("div", { className: "wb-field", key: "verify" }, [
            h("span", { className: "wb-field-label", key: "label" }, "校验状态"),
            h("span", { className: "wb-field-value", key: "value" }, verify),
          ]),
          h("div", { className: "wb-field", key: "summary" }, [
            h("span", { className: "wb-field-label", key: "label" }, "摘要"),
            h("p", { className: "wb-drawer-body", key: "value" }, related && related.summary
              ? related.summary
              : "账本里这条成果没有关联的结案摘要。"),
          ]),
          h("div", { className: "wb-field", key: "revise" }, [
            h("button", {
              key: "toggle",
              type: "button",
              className: "wb-small-btn",
              onClick: function () {
                setReviseOpen(!reviseOpen);
                if (reviseOpen) setReviseText("");
                setNotice(null);
              },
            }, reviseOpen ? "收起修改请求" : "找主责部门修改"),
            reviseForm,
          ]),
        ]);
      }

      var alert = null;
      if (error) {
        alert = h("div", { className: "wb-alert", role: "alert", key: "error" }, [
          h("span", { className: "wb-alert-text", key: "text" }, error),
          h("button", {
            key: "retry",
            type: "button",
            onClick: function () {
              setReloadToken(reloadToken + 1);
            },
          }, "重试"),
        ]);
      } else if (notice) {
        alert = h("div", { className: "wb-alert is-" + noticeTone, role: "alert", key: "notice" }, [
          h("span", { className: "wb-alert-text", key: "text" }, notice),
        ]);
      }

      var content;
      if (view === "tasks") content = renderTasks();
      else if (view === "artifacts") content = renderArtifacts();
      else content = renderCourt();

      return h("div", { className: "wb-rail" + (compact ? " is-compact" : "") }, [
        h("div", { className: "wb-head", key: "head" }, [
          h("span", { className: "wb-title", key: "title" }, "三省六部"),
          h("span", { className: "wb-meta", key: "meta" }, metaText),
        ]),
        h("div", { className: "wb-tabs", role: "tablist", key: "tabs" }, [
          tabButton("court", "朝堂"),
          tabButton("tasks", "任务"),
          tabButton("artifacts", "成果"),
        ]),
        alert,
        h("div", { className: "wb-scroll", key: "scroll" }, [content]),
        renderDrawer(),
      ]);
    }

    function WorkbenchPanel(props) {
      return h(PanelBoundary, null, h(WorkbenchRail, { ctx: props.ctx, compact: true }));
    }

    /**
     * main.conversation 的接管组件。
     * 逃生开关：localStorage["sansheng.workbench.main"] === "off" 时不注册这个槽，
     * 只保留右侧栏「朝堂」页签版，普通聊天完全不受影响。
     */
    function createConversationMain(ctx) {
      return function SanshengConversationMain(props) {
        var input = props || {};
        var sessionId = input.sessionId;
        var useSession = input.useSession;
        var useSessions = input.useSessions;
        var useConversation = input.useConversation;
        var renderSlot = input.renderSlot;
        var renderFactorySlot = input.renderFactorySlot;

        // 宿主自己的 header + content：组件体内任何一步炸掉都回退到这里，中央聊天不白屏。
        function renderNative(phaseValue, heroValue) {
          return h("div", { className: "wb-main-native", "data-phase": phaseValue }, [
            typeof renderSlot === "function" ? renderSlot("conversation.header", {}) : null,
            typeof renderFactorySlot === "function"
              ? renderFactorySlot(
                "conversation.content",
                { variant: "main", phase: phaseValue, hero: heroValue },
                { slots: { widthControls: input.widthControls || {} } },
              )
              : null,
          ]);
        }

        try {
          var session = typeof useSession === "function" ? useSession(function (value) { return value; }) : undefined;
          var conversation = typeof useConversation === "function" ? useConversation(function (value) { return value; }) : undefined;
          var summaryBlank = typeof useSessions === "function"
            ? useSessions(function (state) {
              if (sessionId === undefined || !state) return undefined;
              var summary = state.byId && state.byId[sessionId];
              return summary ? summary.blank : undefined;
            })
            : undefined;

          var shellPhase = session === undefined || conversation === undefined
            ? "blank"
            : conversationPhase(session, conversation);
          var openState = session && session.openState;
          var subagent = session && session.subagent;
          var address = subagent && subagent.address;
          var parentAvailabilityPending = Boolean(address) &&
            address.mode === "continuable" &&
            subagent.parentAvailable === undefined;
          var settling = sessionId !== undefined && (
            (shellPhase === "blank" && openState === "loading" && summaryBlank !== true) ||
            parentAvailabilityPending
          );
          var hero = sessionId === undefined ||
            (shellPhase === "blank" && (openState === "open" || summaryBlank === true));
          var phase = settling ? "settling" : hero ? "hero" : "active";

          var railProjectId = useBoundProject(ctx, sessionId);
          var widthState = useRailWidth();
          var railWidth = widthState[0];
          var onResizeStart = widthState[1];
          var nudgeRail = widthState[2];

          var native = renderNative(phase, hero);

          // 不是本工作台已绑定的部门会话：只渲染原生会话，与宿主原行为一致，不加任何东西。
          if (!sessionId || !railProjectId) return native;

          return h("div", { className: "wb-main-split" }, [
            native,
            h("div", {
              className: "wb-main-resizer",
              key: "resizer",
              role: "separator",
              "aria-orientation": "vertical",
              "aria-label": "调整朝堂栏宽度",
              "aria-valuenow": railWidth,
              "aria-valuemin": RAIL_MIN,
              "aria-valuemax": RAIL_MAX,
              tabIndex: 0,
              title: "拖动或用方向键调整朝堂栏宽度（Shift 加速，Home/End 到两端）",
              onMouseDown: typeof onResizeStart === "function" ? onResizeStart : null,
              onKeyDown: function (event) {
                if (!event || typeof nudgeRail !== "function") return;
                var target = railResizeTarget(event.key, { width: railWidth, shift: Boolean(event.shiftKey) });
                if (target === null) return;
                nudgeRail(target - railWidth);
                if (typeof event.preventDefault === "function") event.preventDefault();
              },
            }),
            h("div", {
              className: "wb-main-rail",
              key: "rail",
              style: { width: railWidth + "px" },
            }, h(PanelBoundary, null,
              h(WorkbenchRail, { ctx: ctx, projectId: railProjectId, compact: false }))),
          ]);
        } catch (error) {
          // 保险：接管逻辑出错时退回宿主原生会话，绝不把中央聊天拖成白屏。
          try {
            console.warn("[sansheng-workbench] 接管失败，回退原生会话：", error);
          } catch (ignored) {
            // 连日志都失败时也要继续回退。
          }
          return renderNative(sessionId === undefined ? "hero" : "active", sessionId === undefined);
        }
      };
    }

    // ---------------------------------------------------------------------
    // 注册
    // ---------------------------------------------------------------------

    function apply(ctx) {
      if (!ctx) throw new Error("三省六部工作台需要宿主上下文");

      // 1) 右侧栏页签「朝堂」：优先 better-sidebar 的 registerTab。
      var better = betterSidebarOf(ctx);
      if (better) {
        effectOf(ctx, function () {
          return better.registerTab({
            id: TAB_ID,
            title: "朝堂",
            description: "三省六部 · 十席部门树",
            order: 5,
            single: true,
            component: function (props) {
              return h(WorkbenchPanel, { ctx: ctx, scope: props && props.scope });
            },
          });
        }, "三省六部工作台：better-sidebar 页签");
      } else {
        var tabs = sidebarRightTabsOf(ctx);
        if (tabs) {
          effectOf(ctx, function () {
            return tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: "builtin",
              title: function () {
                return "朝堂";
              },
            });
          }, "三省六部工作台：右侧栏页签");
        } else {
          console.warn("[sansheng-workbench] 宿主没有 betterSidebar / sidebarRightTabs，页签可能无法停靠；pane 槽仍会注册。");
        }
      }

      // 2) 页签内容 + 标题：即使上面没有服务也注册，宿主若按槽渲染仍可用。
      if (ctx.slots && typeof ctx.slots.inject === "function") {
        ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, function (props) {
            return h(WorkbenchPanel, { ctx: ctx, props: props });
          });
        });
        ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, function () {
            return h("span", { className: "wb-tab-title" }, "朝堂");
          });
        });
      }

      // 3) 中央主区接管：priority -1 抢在宿主默认 0 之前；原生会话内容原样透传。
      //    逃生开关：localStorage["sansheng.workbench.main"] = "off" 时跳过本段。
      if (mainTakeoverEnabled() && ctx.slots && typeof ctx.slots.inject === "function") {
        ctx.slots.inject("main.conversation", function () {
          return ctx.slots.register({
            name: "main.conversation",
            priority: -1,
            children: {
              "conversation.header": { kind: "single", scope: "session-maybe" },
            },
          }, createConversationMain(ctx));
        });
      }
    }

    exports.inject = ["slots", "sessions", "uiWorkspace", "uiConversation"];
    exports.apply = apply;
    exports.WorkbenchRail = WorkbenchRail;
    exports.WorkbenchPanel = WorkbenchPanel;
    exports.__test = {
      computeRailLayout: computeRailLayout,
      railResizeTarget: railResizeTarget,
      statusOf: statusOf,
      mergeEvents: mergeEvents,
      apiPath: apiPath,
      pickProjectId: pickProjectId,
      formatModelLine: formatModelLine,
      seatDisplayName: seatDisplayName,
      modelTitle: modelTitle,
      existenceLabel: existenceLabel,
      verificationLabel: verificationLabel,
      revisionLabel: revisionLabel,
      taskKindLabel: taskKindLabel,
      taskActionKeys: taskActionKeys,
      wirePathsFromLayout: wirePathsFromLayout,
      ROLE_META: ROLE_META,
    };

    return module.exports;
  },
});
