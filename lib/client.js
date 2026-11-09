// 天市 · DSH 客户端
//   1) 左侧栏新增「天市」入口（与「插件」同一套 slots，点开后主区显示工作台）
//   2) 右下角可拖拽悬浮球（位置记忆），点开浮层工作台
// 工作台本体由 host 在 /api/tianshi/workbench 提供，也可直接在浏览器打开。
window.__ModuleLoader__.load({
  id: "dsh-tianshi",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var WORKBENCH_URL = "/api/tianshi/workbench";
    var FAB_ATTR = "data-dsh-tianshi-fab";
    var POS_KEY = "tianshi.fab.pos";
    var PANEL_ID = "tianshi";

    /* ── 天市垣图标 ──
       取象于三垣之一的天市垣：垣内主星为帝座，外围四星连成市垣。
       两笔：外垣（折线闭合的星市）+ 内核（帝座）+ 一颗流速星。
       不用渐变堆砌，只靠描边与两点光源，深色底上辨识度高。 */
    var ICON_SVG =
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      // 星垣外框：四角星位，连成市集的围墙
      '<path d="M5.2 17.4 L4.4 8.6 L12 4.6 L19.6 8.6 L18.8 17.4 Z" ' +
        'stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" opacity=".5"/>' +
      // 帝座：垣心主星
      '<circle cx="12" cy="11.6" r="2.1" fill="currentColor"/>' +
      // 市楼三星：横向排列的估值锚点
      '<circle cx="7.6" cy="14.5" r="1.05" fill="currentColor" opacity=".78"/>' +
      '<circle cx="12" cy="16.2" r="1.05" fill="currentColor" opacity=".78"/>' +
      '<circle cx="16.4" cy="14.5" r="1.05" fill="currentColor" opacity=".78"/>' +
      // 四角星点
      '<circle cx="4.4" cy="8.6" r=".85" fill="currentColor" opacity=".6"/>' +
      '<circle cx="19.6" cy="8.6" r=".85" fill="currentColor" opacity=".6"/>' +
      // 帛度：右上角一颗外来的流星，示意资金流入
      '<path d="M17.4 5.6 L19.9 3.4" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" opacity=".9"/>' +
      '<circle cx="20.2" cy="3.1" r="1.15" fill="currentColor"/>' +
      '</svg>';

    function appIcon(size) {
      var s = size || 22;
      var wrap = document.createElement("span");
      wrap.className = "ts-icon-wrap";
      wrap.style.cssText =
        "width:" + s + "px;height:" + s + "px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:#E8B44C";
      wrap.innerHTML = ICON_SVG;
      var svg = wrap.querySelector("svg");
      if (svg) { svg.setAttribute("width", s); svg.setAttribute("height", s); }
      return wrap;
    }

    function iconHtml(size) {
      var s2 = size || 20;
      return ICON_SVG.replace('<svg ', '<svg width="' + s2 + '" height="' + s2 + '" ');
    }

    function el(tag, style, text) {
      var e = document.createElement(tag);
      if (style) Object.keys(style).forEach(function (k) { e.style[k] = style[k]; });
      if (text !== undefined && text !== null) e.textContent = String(text);
      return e;
    }

    function readPos() {
      try {
        var v = localStorage.getItem(POS_KEY);
        return v ? JSON.parse(v) : null;
      } catch (e) { return null; }
    }
    function savePos(p) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch (e) {}
    }

    function apply(ctx) {
      /* ══════════ ① 左侧栏入口 + 主区面板（与「插件」同一套 slots） ══════════ */
      try {
        if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
          var React = require("react");

          // 主区页面：直接内嵌工作台 iframe
          function TianshiPage() {
            var st = React.useState(false);
            var ready = st[0], setReady = st[1];
            return React.createElement("div", {
              style: { position: "relative", width: "100%", height: "100%", background: "#F7F8FA", overflow: "hidden" },
            }, React.createElement("iframe", {
              src: WORKBENCH_URL,
              title: "天市",
              onLoad: function () { setReady(true); },
              style: {
                width: "100%", height: "100%", border: 0, display: "block", background: "#F7F8FA",
                opacity: ready ? 1 : 0,
                transform: ready ? "none" : "translateY(8px) scale(.995)",
                transition: "opacity .34s ease, transform .46s cubic-bezier(.2,.9,.25,1)",
              },
            }));
          }
          // 侧边栏图标：天市垣星图
          function TianshiIcon() {
            return React.createElement("span", {
              style: { display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#E8B44C" },
              dangerouslySetInnerHTML: { __html: iconHtml(20) },
            });
          }

          ctx.slots.inject("main", function () {
            return ctx.slots.register({
              name: "main",
              key: PANEL_ID,
              children: {},
            }, TianshiPage);
          });
          ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 40,
              label: function () { return "天市"; },
            }, TianshiIcon);
          });

          /* ── 把官方的小鲸鱼换成天市（单占槽位用更低优先级遮蔽官方注册） ── */
          function brandMarkSvg(size) {
            var s2 = size || 24;
            return ICON_SVG.replace('<svg ', '<svg width="' + s2 + '" height="' + s2 + '" ');
          }

          // 侧栏 logo（替换小鲸鱼）
          function TsBrandMark(props) {
            var size = (props && props.size) || 24;
            return React.createElement("span", {
              style: { display: "inline-flex", alignItems: "center", justifyContent: "center" },
              dangerouslySetInnerHTML: { __html: brandMarkSvg(size, true) },
            });
          }
          // 侧栏名称（替换 DeepSeek 字标）
          function TsBrandName() {
            return React.createElement(
              "span",
              { style: { display: "inline-flex", alignItems: "baseline", gap: "6px", whiteSpace: "nowrap" } },
              React.createElement("span", { style: { fontSize: "14px", fontWeight: 650, letterSpacing: ".02em" } }, "天市"),
              React.createElement("span", { style: { fontSize: "10px", opacity: 0.55, letterSpacing: ".04em" } }, "A股分析"),
            );
          }
          // 对话首页那只宠物（替换成天市图标，带轻微呼吸动画）
          function TsHeroMark(props) {
            var size = (props && props.size) || 34;
            return React.createElement("span", {
              className: "ts-hero-mark",
              style: { display: "inline-flex", alignItems: "center", justifyContent: "center" },
              dangerouslySetInnerHTML: { __html: brandMarkSvg(size, true) },
            });
          }
          try {
            ctx.slots.inject("sidebar.brand.mark", function () {
              return ctx.slots.register({ name: "sidebar.brand.mark", priority: -1 }, TsBrandMark);
            });
            ctx.slots.inject("sidebar.brand.name", function () {
              return ctx.slots.register({ name: "sidebar.brand.name", priority: -1 }, TsBrandName);
            });
            ctx.slots.inject("conversation.hero.brand.mark", function () {
              return ctx.slots.register({ name: "conversation.hero.brand.mark", priority: -1 }, TsHeroMark);
            });
          } catch (e) {
            if (typeof console !== "undefined" && console.warn) console.warn("tianshi: brand slots unavailable", e);
          }
        }
      } catch (e) {
        // 侧栏注册失败不影响悬浮球
        if (typeof console !== "undefined" && console.warn) console.warn("tianshi: sidebar slot unavailable", e);
      }

      /* ══════════ ② 右下角可拖拽悬浮球 + 浮层工作台 ══════════ */
      var css = document.createElement("style");
      css.textContent = [
        "[" + FAB_ATTR + "]{position:fixed;z-index:2147483000;width:46px;height:46px;border-radius:15px;border:0;padding:0;",
        "display:flex;align-items:center;justify-content:center;cursor:pointer;",
        "background:#1B2A4A;box-shadow:0 6px 20px -6px rgba(17,24,39,.45),0 2px 6px rgba(17,24,39,.18);",
        "transition:transform .16s cubic-bezier(.32,.72,0,1),box-shadow .16s ease;touch-action:none;user-select:none}",
        "[" + FAB_ATTR + "]:hover{transform:translateY(-2px);box-shadow:0 10px 26px -8px rgba(17,24,39,.5)}",
        "[" + FAB_ATTR + "]:active{transform:scale(.96)}",
        "[" + FAB_ATTR + "][data-drag='1']{cursor:grabbing;transition:none}",
        ".ts-dot{position:absolute;top:7px;right:7px;width:7px;height:7px;border-radius:50%;background:#f04438;box-shadow:0 0 0 2px #1B2A4A}",
        ".ts-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(15,18,25,0);backdrop-filter:blur(0px);",
        "display:flex;align-items:center;justify-content:center;padding:3vh 3vw;visibility:hidden;pointer-events:none;",
        "transition:background .28s ease,backdrop-filter .28s ease,visibility 0s linear .34s}",
        ".ts-overlay.open{background:rgba(15,18,25,.36);backdrop-filter:blur(3px);visibility:visible;pointer-events:auto;",
        "transition:background .28s ease,backdrop-filter .28s ease,visibility 0s}",
        ".ts-win{width:min(1280px,96vw);height:min(880px,90vh);background:#F7F8FA;border-radius:16px;overflow:hidden;",
        "box-shadow:0 32px 80px -24px rgba(0,0,0,.45),0 8px 24px -12px rgba(0,0,0,.3);position:relative;display:flex;flex-direction:column;",
        "opacity:0;transform:scale(.08);transition:transform .42s cubic-bezier(.18,.9,.22,1),opacity .2s ease;will-change:transform,opacity}",
        ".ts-overlay.open .ts-win{opacity:1;transform:none}",
        ".ts-overlay.closing .ts-win{transition:transform .26s cubic-bezier(.4,0,.8,.3),opacity .22s ease .04s}",
        ".ts-bar{position:absolute;top:8px;right:8px;display:flex;z-index:5}",
        ".ts-bar button{width:20px;height:20px;padding:0;border-radius:6px;border:0;background:transparent;",
        "color:#9aa3af;cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center}",
        ".ts-bar button:hover{background:rgba(0,0,0,.06);color:#374151}",
        ".ts-frame{flex:1 1 auto;border:0;width:100%;display:block}",
        ".ts-hero-mark{animation:tsbreathe 2.6s ease-in-out infinite}",
        "@keyframes tsbreathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-2px) scale(1.04)}}",
        ".ts-load{position:absolute;inset:0;background:#F7F8FA;display:flex;flex-direction:column;",
        "align-items:center;justify-content:center;gap:12px;z-index:2;transition:opacity .35s ease}",
        ".ts-load .ts-mk{color:#A87925;animation:tsbreathe 2.2s ease-in-out infinite}",
        ".ts-load.hide{opacity:0;pointer-events:none}",
        ".ts-spin{width:26px;height:26px;border:2.5px solid #eceef2;border-top-color:#3B5BDB;border-radius:50%;animation:tss .8s linear infinite}",
        "@keyframes tss{to{transform:rotate(360deg)}}",
        ".ts-load b{font-size:12.5px;color:#111;font-weight:600}",
        ".ts-load span{font-size:11px;color:#9aa0a6}",
      ].join("");
      document.head.appendChild(css);

      var overlay = null;
      var win = null;
      var frame = null;
      var isOpen = false;
      var frameReady = false;

      function notifyFrame(visible) {
        try { frame && frame.contentWindow && frame.contentWindow.postMessage({ type: "tianshi:visibility", visible: visible }, "*"); } catch (e) {}
      }

      // 只建一次：之后打开/关闭只切换样式，iframe 一直活着，数据也一直在
      function ensureOverlay() {
        if (overlay) return;
        overlay = el("div", null);
        overlay.className = "ts-overlay";
        win = el("div", null);
        win.className = "ts-win";
        var bar = el("div", null);
        bar.className = "ts-bar";
        var close = el("button", null, "\u2715");
        close.setAttribute("aria-label", "关闭");
        close.title = "关闭（Esc）";
        bar.appendChild(close);

        var load = el("div", null);
        load.className = "ts-load";
        var mk = appIcon(40);
        mk.classList.add("ts-mk");
        var lb = el("b", null, "天市");
        var ls = el("span", null, "正在载入市场数据…");
        load.appendChild(mk); load.appendChild(lb); load.appendChild(ls);

        frame = el("iframe", null);
        frame.className = "ts-frame";
        frame.src = WORKBENCH_URL + "?embed=overlay&prewarm=1";
        frame.addEventListener("load", function () {
          frameReady = true;
          load.classList.add("hide");
          setTimeout(function () { if (load.parentElement) load.parentElement.removeChild(load); }, 380);
          notifyFrame(isOpen);
        });
        win.appendChild(bar);
        win.appendChild(frame);
        win.appendChild(load);
        overlay.appendChild(win);
        document.body.appendChild(overlay);
        close.addEventListener("click", closeWorkbench);
        overlay.addEventListener("click", function (e) { if (e.target === overlay) closeWorkbench(); });
      }

      // 让窗口从悬浮球的位置长出来
      function originFromFab() {
        try {
          var f = fab.getBoundingClientRect();
          var w = win.getBoundingClientRect();
          var sx = w.width ? 0 : 1;
          var x = f.left + f.width / 2 - w.left;
          var y = f.top + f.height / 2 - w.top;
          win.style.transformOrigin = (sx ? 50 : x) + "px " + (sx ? 50 : y) + "px";
        } catch (e) {}
      }

      function openWorkbench() {
        ensureOverlay();
        if (isOpen) return;
        isOpen = true;
        originFromFab();
        overlay.classList.remove("closing");
        // 强制一次布局，确保从缩小状态开始过渡
        void win.offsetWidth;
        overlay.classList.add("open");
        notifyFrame(true);
        document.addEventListener("keydown", onKey);
      }

      function closeWorkbench() {
        if (!overlay || !isOpen) return;
        isOpen = false;
        originFromFab();
        overlay.classList.add("closing");
        overlay.classList.remove("open");
        setTimeout(function () { if (!isOpen && overlay) overlay.classList.remove("closing"); }, 360);
        notifyFrame(false);
        document.removeEventListener("keydown", onKey);
      }
      function onKey(e) { if (e.key === "Escape") closeWorkbench(); }

      // 预热：应用空闲后在后台建好隐藏的工作台，第一次点开就是现成的
      function prewarm() { try { ensureOverlay(); } catch (e) {} }
      if (typeof window.requestIdleCallback === "function") {
        setTimeout(function () { window.requestIdleCallback(prewarm, { timeout: 4000 }); }, 1500);
      } else {
        setTimeout(prewarm, 2500);
      }

      var fab = el("button", null);
      fab.setAttribute(FAB_ATTR, "1");
      fab.title = "天市 · A股分析工作台（可拖动）";
      fab.appendChild(appIcon(24));
      var dot = el("span", null);
      dot.className = "ts-dot";
      fab.appendChild(dot);

      // 位置：默认右下角，拖过就记住
      var saved = readPos();
      function place(x, y) {
        var w = window.innerWidth, h = window.innerHeight;
        var size = 46;
        x = Math.max(8, Math.min(w - size - 8, x));
        y = Math.max(8, Math.min(h - size - 8, y));
        fab.style.left = x + "px";
        fab.style.top = y + "px";
        fab.style.right = "auto";
        fab.style.bottom = "auto";
      }
      if (saved) place(saved.x, saved.y);
      else {
        fab.style.right = "20px";
        fab.style.bottom = "104px";
      }
      window.addEventListener("resize", function () {
        if (fab.style.left) place(parseFloat(fab.style.left), parseFloat(fab.style.top));
      });

      // 拖拽：超过 4px 视为拖动，不触发点击
      var dragging = false;
      var moved = false;
      var start = null;
      fab.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        dragging = true;
        moved = false;
        start = { x: e.clientX, y: e.clientY, left: fab.getBoundingClientRect().left, top: fab.getBoundingClientRect().top };
        fab.setAttribute("data-drag", "1");
        try { fab.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      });
      fab.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var dx = e.clientX - start.x;
        var dy = e.clientY - start.y;
        if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        moved = true;
        place(start.left + dx, start.top + dy);
      });
      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        fab.removeAttribute("data-drag");
        try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
        if (moved) {
          savePos({ x: parseFloat(fab.style.left) || 0, y: parseFloat(fab.style.top) || 0 });
        }
      }
      fab.addEventListener("pointerup", endDrag);
      fab.addEventListener("pointercancel", endDrag);
      fab.addEventListener("click", function (e) {
        e.preventDefault();
        if (moved) { moved = false; return; }
        if (isOpen) closeWorkbench();
        else openWorkbench();
      });

      fab.addEventListener("pointerenter", prewarm);
      document.body.appendChild(fab);

      var disposeAll = function () {
        try { closeWorkbench(); } catch (e) {}
        try { if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay); } catch (e) {}
        try { css.remove(); } catch (e) {}
        if (fab.parentElement) fab.parentElement.removeChild(fab);
      };
      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function () { return disposeAll; }, "tianshi: ui mounts");
      }
      window.addEventListener("beforeunload", disposeAll);
    }

    exports.inject = [];
    exports.apply = apply;
    return module.exports;
  },
});
