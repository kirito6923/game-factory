// deepseek-proxy.js —— 零安装的 DeepSeek 本地转发代理
// 兼容 Node v12（支持 Windows 7 32位），仅用内置 http/https 模块，无 fetch 依赖。
// 作用：游戏网页(双击打开的 HTML)要调 DeepSeek 官方 API，但官方 API 不返回 CORS 头，
//       浏览器会拦截跨域请求。这个代理跑在本机 127.0.0.1:8787，帮网页转发到官方 API，
//       并补上 CORS 头。你的 API Key 只在本机内存里，绝不出本机、不经过任何第三方。
//
// 用法：
//   node deepseek-proxy.js
// 默认监听 http://127.0.0.1:8787

"use strict";
const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const DIR = __dirname;

/* ---------- 接口设置：读同目录的「接口设置.txt」 ----------
   换接口 / 换模型 / 换 key 只改那个 txt，不用改代码。
   认「名称=值」和「名称:值」；# 开头是注释；文件不存在就退回默认值。 */
function readConfig() {
  const cfg = {};
  try {
    const txt = fs.readFileSync(path.join(DIR, "接口设置.txt"), "utf8").replace(/^\uFEFF/, "");
    txt.split(/\r?\n/).forEach(line => {
      const s = line.trim();
      if (!s || s.charAt(0) === "#") return;
      const m = s.match(/^([^=:：]+)\s*[=:：]\s*(.*)$/);
      if (m) cfg[m[1].trim().toLowerCase()] = m[2].trim();
    });
  } catch (e) { /* 没有这个文件就用默认值 */ }
  return cfg;
}
function firstOf() { // 取第一个非空的值
  for (let i = 0; i < arguments.length; i++) { if (arguments[i]) return arguments[i]; }
  return "";
}
const CFG = readConfig();
const UPSTREAM_CANDIDATES = [firstOf(process.env.UPSTREAM, CFG["上游"], CFG["上游地址"], CFG["upstream"], "https://api.deepseek.com")];
const UPSTREAM = UPSTREAM_CANDIDATES[0];
const CFG_MODEL = firstOf(CFG["模型"], CFG["model"]);
const CFG_KEY = firstOf(CFG["key"], CFG["apikey"], CFG["api_key"], CFG["密钥"]);
const CFG_THINK = firstOf(CFG["思考"], CFG["thinking"]).toLowerCase(); // off=不思考 / on=思考 / 空=不动
/* 本次运行的用量累计（只在窗口里打印花费估算，不落盘） */
const TOT = { out: 0, in: 0, calls: 0 };

// 从学生版页面里读出内置的第一个 key（给诊断页用，免去手输 key）
function builtinKey() {
  try {
    const h = fs.readFileSync(path.join(DIR, "game-factory-student-lite.html"), "utf8");
    const m = h.match(/(oc_sk_[A-Za-z0-9_\-]+|sk-[A-Za-z0-9]{16,})/);
    return m ? m[1] : "";
  } catch (e) { return ""; }
}

// 判断上游 2xx 响应是不是"假的成功"：网关有时用 200 包着错误对象，或者模型没吐正文。
// 返回 null = 正常；返回字符串 = 给用户看的原因。
function inspectUpstream(text) {
  const head = text.replace(/\s+/g, " ").slice(0, 300);
  let j = null;
  try { j = JSON.parse(text); } catch (e) { return "上游返回的不是 JSON：" + head; }
  if (j && j._tag) return "上游拒绝了这个请求（_tag=" + j._tag + "）：" + head;
  if (j && j.error) return "上游返回错误：" + ((j.error && j.error.message) || JSON.stringify(j.error));
  const ch = j && j.choices && j.choices[0];
  if (!ch) return "上游返回的 JSON 里没有 choices：" + head;
  const msg = ch.message || {};
  const c = msg.content;
  if (typeof c === "string" && c.trim()) return null; // 正常
  if (Array.isArray(c) && c.length) return null;      // 分片格式也算正常
  const extra = [];
  if (ch.finish_reason) extra.push("finish_reason=" + ch.finish_reason);
  if (msg.reasoning_content) extra.push("思考内容 " + String(msg.reasoning_content).length + " 字");
  return "模型没返回正文" + (extra.length ? "（" + extra.join("，") + "）" : "") + "：换个模型或调大 max_tokens 再试";
}

// 静态文件服务：让浏览器直接从 http://127.0.0.1:8787/ 打开页面
// 好处：与 API 同源，彻底避免 file:// 与跨域限制（老浏览器更省心）
function serveFile(res, filename, contentType) {
  const safe = path.basename(filename); // 防目录穿越
  const full = path.join(DIR, safe);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<meta charset='utf-8'><h2>找不到文件：" + safe + "</h2><p>请确认它与 deepseek-proxy.js 在同一文件夹。</p>");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType || "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 5_000_000) req.destroy(); });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body || "{}"); }
      catch(e){ sendJson(res, 400, { error: { message: "请求体不是合法 JSON" } }); return; }

      const target = parsed.target || "/chat/completions";
      const payload = parsed.body !== undefined ? parsed.body : parsed;
      // key 优先用「接口设置.txt」里的；没填才用网页里带的
      const key = CFG_KEY || parsed.key || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
      if (!key) {
        sendJson(res, 400, { error: { message: "缺少 API Key，请在前端填入。" } });
        return;
      }

      // 用 https 转发到上游网关（兼容 Node v12，不用 fetch）
      // 依次尝试候选地址：只有 404（路径不存在）才换下一个，其它错误原样返回，避免掩盖真实原因。
      // 另外：思考型模型（返回里有 reasoning_content）会把 max_tokens 全花在"想"上，正文就是空的，
      // 遇到这种"没正文 + finish_reason=length"就自动把上限翻倍重试。
      let curPayload = payload;
      let bumpCount = 0;
      let injectedThinking = false; // 保留声明：下面那段"上游不认字段就去掉重试"的逻辑会读它
      let strippedThinking = false;
      // ① 模型名以「接口设置.txt」为准（填了才覆盖，网页里写的名字作废，省得改三个文件）
      // ② 思考开关：DeepSeek 官方文档的写法是 {"thinking":{"type":"enabled/disabled"}}，
      //    默认是开启（effort=high）—— 这就是之前一局要 1~3 分钟的原因，课堂必须关掉。
      if (curPayload && typeof curPayload === "object") {
        curPayload = Object.assign({}, curPayload);
        if (CFG_MODEL) curPayload.model = CFG_MODEL;
        if (/^(off|disabled|false|no|关|否|不思考)$/i.test(CFG_THINK)) curPayload.thinking = { type: "disabled" };
        else if (/^(low|少|轻|一点|一点点)$/i.test(CFG_THINK)) { curPayload.thinking = { type: "enabled" }; curPayload.reasoning_effort = "low"; }
        else if (/^(on|enabled|true|yes|开|是)$/i.test(CFG_THINK)) curPayload.thinking = { type: "enabled" };
      }

      const tryUpstream = (ci) => {
        const base = UPSTREAM_CANDIDATES[ci];
        const suffix = target.charAt(0) === "/" ? target : "/" + target;
        let upstreamUrl;
        try { upstreamUrl = new url.URL(base + suffix); }
        catch(e){ sendJson(res, 500, { error: { message: "目标地址解析失败：" + base } }); return; }

        const payloadStr = JSON.stringify(curPayload);
        const upstreamHeaders = {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payloadStr),
          "Authorization": "Bearer " + key,
        };

        const startedAt = Date.now();
        const upstreamReq = https.request({
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || 443,
          path: upstreamUrl.pathname + upstreamUrl.search,
          method: "POST",
          headers: upstreamHeaders,
        }, (upstreamRes) => {
          let chunks = [];
          upstreamRes.on("data", c => chunks.push(c));
          upstreamRes.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = upstreamRes.statusCode || 502;
            if (status === 404 && ci + 1 < UPSTREAM_CANDIDATES.length) {
              tryUpstream(ci + 1); // 该路径不对，换下一个上游地址再试
              return;
            }
            // 上游不认我们注入的 enable_thinking（有些模型会 400），去掉它重试一次
            if (status === 400 && injectedThinking && !strippedThinking &&
                /enable_thinking|unknown|unrecognized|unsupported|extra/i.test(text)) {
              strippedThinking = true;
              curPayload = Object.assign({}, curPayload);
              delete curPayload.enable_thinking;
              console.log("[deepseek-proxy] 上游不认 enable_thinking，去掉后重试");
              tryUpstream(ci);
              return;
            }
            // 假成功（2xx 里包着错误 / 模型没吐正文）也翻成人能看懂的错误
            const problem = (status >= 200 && status < 300) ? inspectUpstream(text) : null;
            if (problem && /模型没返回正文/.test(problem) && bumpCount < 2 && curPayload && typeof curPayload === "object") {
              const oldMax = Number(curPayload.max_tokens) || 4000;
              const newMax = Math.min(oldMax * 2, 64000);
              const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
              if (newMax > oldMax) {
                bumpCount++;
                curPayload = Object.assign({}, curPayload, { max_tokens: newMax });
                console.log("[deepseek-proxy] 本轮 " + secs + "s：上限 " + oldMax + " 被思考吃光，提到 " + newMax + " 重试");
                tryUpstream(ci);
                return;
              }
            }
            if (problem) {
              console.log("[deepseek-proxy] 本轮 " + ((Date.now() - startedAt) / 1000).toFixed(1) + "s：上游 HTTP " + status + " 但内容异常：" + problem);
              sendJson(res, 502, { error: { message: problem } });
              return;
            }
            let tkInfo = "";
            try {
              const uj = JSON.parse(text);
              if (uj && uj.usage) {
                const det = uj.usage.completion_tokens_details || {};
                const outTok = uj.usage.completion_tokens || 0;
                const inTok = uj.usage.prompt_tokens || 0;
                tkInfo = "，输出 " + outTok + " token（含思考 " + (det.reasoning_tokens || 0) + "）+ 输入 " + inTok + " token";
                TOT.out += outTok; TOT.in += inTok; TOT.calls++;
              }
            } catch (e) {}
            console.log("[deepseek-proxy] 本轮 " + ((Date.now() - startedAt) / 1000).toFixed(1) + "s：上游 HTTP " + status + " 正常，返回 " + text.length + " 字节" + tkInfo);
            console.log("[deepseek-proxy] 累计 " + TOT.calls + " 次调用，输出 " + TOT.out + " token，估算 ¥" + ((TOT.out * 8.5 + TOT.in * 2.1) / 1e6).toFixed(2) + "（按高峰价算，实际可能更低）");
            res.writeHead(status, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Cache-Control": "no-store",
            });
            res.end(text);
          });
        });

        upstreamReq.on("error", e => {
          sendJson(res, 502, { error: { message: "上游请求失败：" + e.message } });
        });
        upstreamReq.setTimeout(300000, () => { upstreamReq.destroy(new Error("上游超时（5 分钟）")); });
        upstreamReq.write(payloadStr);
        upstreamReq.end();
      };
      tryUpstream(0);
    });
  } else if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    res.end();
  } else if (req.method === "GET") {
    const p = (function(){ const raw = (req.url || "/").split("?")[0]; try { return decodeURIComponent(raw); } catch(e){ return raw; } })();
    if (p === "/health") {
      sendJson(res, 200, { ok: true, service: "deepseek-proxy" });
    } else if (p === "/debug") {
      // 诊断页：浏览器打开 http://127.0.0.1:8787/debug
      // 可选参数：?model=模型名  &key=你的key（不填就用页面内置的第一个 key）
      const q = {};
      (req.url.split("?")[1] || "").split("&").forEach(kv => {
        if (!kv) return;
        const i = kv.indexOf("=");
        const k = i < 0 ? kv : kv.slice(0, i);
        q[k] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
      });
      const model = q.model || "deepseek-v4.1-flash";
      const key = q.key || CFG_KEY || builtinKey();
      const lines = [
        "AI 游戏工厂 · 上游诊断报告",
        "时间：" + new Date().toLocaleString(),
        "候选上游：" + UPSTREAM_CANDIDATES.join("   |   "),
        "测试模型：" + model,
        "使用 key：" + (key ? key.slice(0, 16) + "…（共 " + key.length + " 字符）" : "❌ 没找到 key"),
        "",
      ];
      const finish = () => {
        lines.push("---");
        lines.push("怎么看：401=key 无效/过期；403=权限或工作区不对；404=地址路径不对；429=限流；");
        lines.push("        200 但带 _tag/error=工作区没开通这个模型；200 但没有正文=这个模型名不被支持。");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end(lines.join("\r\n"));
      };
      let ci = 0;
      const probeNext = () => {
        if (ci >= UPSTREAM_CANDIDATES.length) { finish(); return; }
        const full = UPSTREAM_CANDIDATES[ci++] + "/chat/completions";
        let u = null;
        try { u = new url.URL(full); }
        catch (e) { lines.push("→ " + full, "  地址解析失败", ""); probeNext(); return; }
        const pingBody = JSON.stringify({ model: model, messages: [{ role: "user", content: "请只回复两个字：正常" }], max_tokens: 1024, stream: false });
        const rq = https.request({
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(pingBody),
            "Authorization": "Bearer " + key,
          },
        }, (ur) => {
          const cs = [];
          ur.on("data", c => cs.push(c));
          ur.on("end", () => {
            const t = Buffer.concat(cs).toString("utf8");
            const st = ur.statusCode || 0;
            const prob = (st >= 200 && st < 300) ? inspectUpstream(t) : null;
            lines.push("→ " + full);
            lines.push("  HTTP " + st + "   Content-Type: " + (ur.headers["content-type"] || "-"));
            lines.push("  返回：" + (t.replace(/\s+/g, " ").slice(0, 600) || "(空)"));
            if (st >= 200 && st < 300) lines.push("  判定：" + (prob ? "✗ " + prob : "✓ 正常，接口能通"));
            else lines.push("  判定：✗ 上游返回了错误状态码，见上面的返回内容");
            lines.push("");
            probeNext();
          });
        });
        rq.on("error", e => { lines.push("→ " + full, "  请求失败：" + e.message, ""); probeNext(); });
        rq.setTimeout(30000, () => rq.destroy(new Error("超时 30 秒")));
        rq.write(pingBody);
        rq.end();
      };
      probeNext();
    } else if (p === "/probe") {
      // 参数探测：试几种"关掉思考"的写法，并问出模型的输出上限。
      // 用法：http://127.0.0.1:8787/probe
      //       http://127.0.0.1:8787/probe?model=glm-5.3-flash   &key=...
      const pq = {};
      (req.url.split("?")[1] || "").split("&").forEach(kv => {
        if (!kv) return;
        const i = kv.indexOf("=");
        pq[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
      });
      const pmodel = pq.model || "deepseek-v4.1-flash";
      const pkey = pq.key || CFG_KEY || builtinKey();
      const pbase = UPSTREAM_CANDIDATES[0];
      const variants = [
        { name: "① 基准（不加任何参数）", extra: {} },
        { name: "② 基准再来一次（看波动大小）", extra: {} },
        { name: '③ reasoning_effort: "low"', extra: { reasoning_effort: "low" } },
        { name: '④ reasoning_effort: "medium"', extra: { reasoning_effort: "medium" } },
        { name: '⑤ reasoning_effort: "high"', extra: { reasoning_effort: "high" } },
        { name: "⑥ enable_thinking: false", extra: { enable_thinking: false } },
        { name: "⑦ enable_thinking:false + reasoning_effort:low", extra: { enable_thinking: false, reasoning_effort: "low" } },
        { name: "⑧ 上限探测（故意要 max_tokens 100 万）", extra: {}, max: 1000000 },
      ];
      const plines = [
        "AI 游戏工厂 · 参数探测",
        "模型：" + pmodel,
        "地址：" + pbase,
        "目标：找一个能让模型不思考、直接出正文的写法。",
        "",
      ];
      let vi = 0;
      const nextVariant = () => {
        if (vi >= variants.length) {
          plines.push("---");
          plines.push("判读：思考 token 最小的那个写法就是我们要的（前提是正文正常）。");
          plines.push("① 和 ② 是同一个东西，用来判断波动有多大，别把噪声当效果。");
          plines.push("③④⑤ 若报 400 not supported，说明这个模型只认固定档位。");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
          res.end(plines.join("\r\n"));
          return;
        }
        const v = variants[vi++];
        let vu = null;
        try { vu = new url.URL(pbase + "/chat/completions"); }
        catch (e) { plines.push("地址解析失败", ""); nextVariant(); return; }
        const vbody = Object.assign({
          model: pmodel,
          messages: [{ role: "user", content: "请只回复两个字：正常" }],
          max_tokens: v.max || 1024,
          stream: false,
        }, v.extra);
        const vtxt = JSON.stringify(vbody);
        const v0 = Date.now();
        const vrq = https.request({
          hostname: vu.hostname,
          port: vu.port || 443,
          path: vu.pathname + vu.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(vtxt),
            "Authorization": "Bearer " + pkey,
          },
        }, (vur) => {
          const vcs = [];
          vur.on("data", c => vcs.push(c));
          vur.on("end", () => {
            const vst = vur.statusCode || 0;
            const vt = Buffer.concat(vcs).toString("utf8");
            const vsecs = ((Date.now() - v0) / 1000).toFixed(1);
            let vj = null;
            try { vj = JSON.parse(vt); } catch (e) {}
            const vch = vj && vj.choices && vj.choices[0];
            const vmsg = (vch && vch.message) || {};
            const vcontent = typeof vmsg.content === "string" ? vmsg.content.replace(/\s+/g, " ").trim() : "";
            const vrt = vj && vj.usage && vj.usage.completion_tokens_details && vj.usage.completion_tokens_details.reasoning_tokens;
            plines.push("── " + v.name);
            plines.push("   HTTP " + vst + "   耗时 " + vsecs + "s");
            if (vst >= 200 && vst < 300) {
              plines.push("   思考 token=" + (vrt === undefined ? "无此字段" : vrt) +
                          "   正文：" + (vcontent ? "「" + vcontent.slice(0, 30) + "」" : "(空)"));
            } else {
              plines.push("   返回：" + (vt.replace(/\s+/g, " ").slice(0, 220) || "(空)"));
            }
            plines.push("");
            nextVariant();
          });
        });
        vrq.on("error", e => { plines.push("── " + v.name, "   请求失败：" + e.message, ""); nextVariant(); });
        vrq.setTimeout(45000, () => vrq.destroy(new Error("超时 45 秒")));
        vrq.write(vtxt);
        vrq.end();
      };
      nextVariant();
    } else if (p === "/scan") {
      // 模型横评：看哪些模型"不思考、出正文快"，适合给学生机用。
      // 用法：http://127.0.0.1:8787/scan
      //       http://127.0.0.1:8787/scan?models=glm-5.3-flash,kimi-k2.6   &key=...
      const sq = {};
      (req.url.split("?")[1] || "").split("&").forEach(kv => {
        if (!kv) return;
        const i = kv.indexOf("=");
        sq[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
      });
      const models = (sq.models || "deepseek-v4-flash,deepseek-v4-pro,deepseek-v4.1-flash,glm-5.3,glm-5.2,glm-5.1,kimi-k2.6,kimi-k2.5,minimax-m3,minimax-m2.7,qwen3.8-max,mistral-large-4")
        .split(",").map(s => s.trim()).filter(s => s);
      const skey = sq.key || CFG_KEY || builtinKey();
      const sbase = UPSTREAM_CANDIDATES[0];
      const slines = [
        "AI 游戏工厂 · 模型横评（共 " + models.length + " 个）",
        "地址：" + sbase,
        "key：" + (skey ? skey.slice(0, 16) + "…（共 " + skey.length + " 字符）" : "❌ 没找到"),
        "给每个模型同一个真实小任务（写 30 行打砖块），看它思考多少、正文全不全、要多久。",
        "要找的是「思考 token = 0 且正文完整」的那个。",
        "",
      ];
      let mi = 0;
      const nextModel = () => {
        if (mi >= models.length) {
          slines.push("---");
          slines.push("挑法：思考 token 少（或没有）、正文正常、耗时短的，最适合学生机（快、省、不会把上限吃光）。");
          slines.push("把你想用的名字发我，我写进教师版/学生版/自检页三个文件。");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
          res.end(slines.join("\r\n"));
          return;
        }
        const mname = models[mi++];
        let su = null;
        try { su = new url.URL(sbase + "/chat/completions"); }
        catch (e) { slines.push("地址解析失败", ""); nextModel(); return; }
        const sbody = JSON.stringify({ model: mname, messages: [{ role: "user", content: "用 HTML+JavaScript 写一个最简打砖块游戏（30 行以内），只输出代码，不要解释。" }], max_tokens: 1500, stream: false });
        const t0 = Date.now();
        const srq = https.request({
          hostname: su.hostname,
          port: su.port || 443,
          path: su.pathname + su.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(sbody),
            "Authorization": "Bearer " + skey,
          },
        }, (sur) => {
          const scs = [];
          sur.on("data", c => scs.push(c));
          sur.on("end", () => {
            const st = sur.statusCode || 0;
            const txt = Buffer.concat(scs).toString("utf8");
            const secs = ((Date.now() - t0) / 1000).toFixed(1);
            let sj = null;
            try { sj = JSON.parse(txt); } catch (e) {}
            const sch = sj && sj.choices && sj.choices[0];
            const smsg = (sch && sch.message) || {};
            const scontent = typeof smsg.content === "string" ? smsg.content.replace(/\s+/g, " ").trim() : "";
            const srt = sj && sj.usage && sj.usage.completion_tokens_details && sj.usage.completion_tokens_details.reasoning_tokens;
            const srl = smsg.reasoning_content ? String(smsg.reasoning_content).length : 0;
            slines.push("── " + mname);
            if (st >= 200 && st < 300) {
              slines.push("   HTTP " + st + "   耗时 " + secs + "s   finish_reason=" + ((sch && sch.finish_reason) || "?") +
                          "   思考 token=" + (srt === undefined ? "无此字段" : srt) + "（思考字符 " + srl + "）");
              const sNoThink = (srt === undefined || srt === 0) && srl === 0;
              const sTrunc = sch && sch.finish_reason === "length";
              slines.push("   正文：" + (scontent ? "「" + scontent.slice(0, 40) + "」" : "(空)") +
                          "   共 " + (typeof smsg.content === "string" ? smsg.content.length : 0) + " 字符" +
                          (sTrunc ? "（被上限截断）" : ""));
              slines.push("   判定：" + (!scontent ? "✗ " + inspectUpstream(txt)
                          : (sNoThink ? "★★ 不思考 + 出正文 = 就是它（记下这个名字）"
                          : (sTrunc ? "△ 会思考，且正文被截断（一局要几分钟）" : "✓ 能用，但会思考（每局几分钟）"))));
            } else {
              slines.push("   HTTP " + st + "   耗时 " + secs + "s");
              slines.push("   返回：" + (txt.replace(/\s+/g, " ").slice(0, 240) || "(空)"));
            }
            slines.push("");
            nextModel();
          });
        });
        srq.on("error", e => { slines.push("── " + mname, "   请求失败：" + e.message, ""); nextModel(); });
        srq.setTimeout(45000, () => srq.destroy(new Error("超时 45 秒")));
        srq.write(sbody);
        srq.end();
      };
      nextModel();
    } else if (p === "/keys") {
      // key 体检：逐个试内置/配置里的 key，报告能不能用 + 余额。
      // 用法：http://127.0.0.1:8787/keys
      const klines = [
        "AI 游戏工厂 · API Key 体检",
        "接口地址：" + UPSTREAM_CANDIDATES[0],
        "时间：" + new Date().toLocaleString(),
        "",
      ];
      const keySet = [];
      const pushKey = k => { k = String(k || "").trim(); if (k && keySet.indexOf(k) < 0) keySet.push(k); };
      (CFG_KEY || "").split(/[,\s;，；]+/).forEach(pushKey);
      try {
        const h = fs.readFileSync(path.join(DIR, "game-factory-student-lite.html"), "utf8");
        const all = h.match(/"(sk-[A-Za-z0-9]{16,}|oc_sk_[A-Za-z0-9_\-]+)"/g) || [];
        all.forEach(s => pushKey(s.replace(/"/g, "")));
      } catch (e) {}
      klines.push("共找到 " + keySet.length + " 个 key。", "");
      let ki = 0;
      const nextKey = () => {
        if (ki >= keySet.length) {
          klines.push("---");
          klines.push("判读：✓ 能用；401=key 无效或被删；402=余额不足（要充值）；429=限流（通常仍可用）。");
          klines.push("只要有 2~3 个 ✓，就直接用内置 key，不用另外申请。");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
          res.end(klines.join("\r\n"));
          return;
        }
        const one = keySet[ki++];
        const shown = one.slice(0, 10) + "…" + one.slice(-4);
        const bodyTxt = JSON.stringify({ model: CFG_MODEL || "deepseek-flash", messages: [{ role: "user", content: "回复：好" }], max_tokens: 16, stream: false, thinking: { type: "disabled" } });
        let u = null;
        try { u = new url.URL(UPSTREAM_CANDIDATES[0] + "/chat/completions"); }
        catch (e) { klines.push("地址解析失败", ""); nextKey(); return; }
        const t0 = Date.now();
        const kreq = https.request({
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyTxt),
            "Authorization": "Bearer " + one,
          },
        }, (kr) => {
          const cs = [];
          kr.on("data", c => cs.push(c));
          kr.on("end", () => {
            const st = kr.statusCode || 0;
            const txt = Buffer.concat(cs).toString("utf8");
            let msg = "";
            try { const j = JSON.parse(txt); msg = (j && j.error && j.error.message) || ""; } catch (e) {}
            const verdict = st === 200 ? "✓ 能用"
              : st === 401 ? "✗ key 无效或已被删除"
              : st === 402 ? "✗ 余额不足（要充值）"
              : st === 429 ? "△ 被限流（通常仍可用）"
              : "? 状态 " + st;
            klines.push("── " + shown + "   HTTP " + st + "   耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
            klines.push("   " + verdict + (msg ? "：" + String(msg).slice(0, 90) : ""));
            // 顺便查余额（查不到就算了）
            let bu = null;
            try { bu = new url.URL(UPSTREAM_CANDIDATES[0] + "/user/balance"); } catch (e) {}
            if (!bu) { klines.push(""); nextKey(); return; }
            const breq = https.request({
              hostname: bu.hostname, port: bu.port || 443, path: bu.pathname, method: "GET",
              headers: { "Authorization": "Bearer " + one, "Accept": "application/json" },
            }, (br) => {
              const bs = [];
              br.on("data", c => bs.push(c));
              br.on("end", () => {
                let line = "";
                try {
                  const bj = JSON.parse(Buffer.concat(bs).toString("utf8"));
                  if (bj && bj.balance_infos && bj.balance_infos.length) {
                    line = bj.balance_infos.map(b => (b.currency || "") + " " + (b.total_balance || "?")).join(" / ");
                  } else if (bj && bj.error) {
                    line = "查不到（" + (bj.error.message || "") + "）";
                  }
                } catch (e) {}
                if (line) klines.push("   余额：" + line);
                klines.push("");
                nextKey();
              });
            });
            breq.on("error", () => { klines.push(""); nextKey(); });
            breq.setTimeout(15000, () => breq.destroy());
            breq.end();
          });
        });
        kreq.on("error", e => { klines.push("── " + shown, "   请求失败：" + e.message, ""); nextKey(); });
        kreq.setTimeout(30000, () => kreq.destroy(new Error("超时 30 秒")));
        kreq.write(bodyTxt);
        kreq.end();
      };
      nextKey();
    } else if (p === "/version") {
      /* 自报家门：告诉启动脚本"当前 8787 上跑的到底是哪一版"。
         判据取自本目录学生版页面的 <title>：含「霓虹」=NEON，含「轻快/像素」=PIXEL。
         这样一旦有旧包的僵尸代理占着端口（用户会一直看到旧版本），启动脚本就能察觉并纠正。 */
      let tag = "UNKNOWN", title = "";
      try {
        const h = fs.readFileSync(path.join(DIR, "game-factory-student-lite.html"), "utf8");
        const m = h.match(/<title>([^<]*)<\/title>/);
        title = m ? m[1] : "";
        if (/霓虹/.test(title)) tag = "NEON";
        else if (/轻快|像素/.test(title)) tag = "PIXEL";
      } catch (e) { tag = "NOFILE"; }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end("AI-GAME-FACTORY " + tag + " | " + title);
    } else if (p === "/" || p === "/index.html" || p === "/student") {
      // 默认打开学生轻快版
      serveFile(res, "game-factory-student-lite.html");
    } else if (p === "/teacher") {
      serveFile(res, "game-factory-teacher.html");
    } else if (p === "/check") {
      serveFile(res, "check.html");
    } else if (p === "/original" || p === "/nes") {
      // 原版模式：NES 模拟器页面
      serveFile(res, "fc-original.html");
    } else if (p === "/nes.js") {
      // NES 模拟器库（JSNES）
      serveFile(res, "nes.js", "application/javascript; charset=utf-8");
    } else {
      // 允许访问同目录下的其它 html / js / nes（如示例游戏、内置 ROM）
      if (/^\/[\w\u4e00-\u9fa5\-\.\(\)]+\.html$/.test(p)) {
        serveFile(res, p.slice(1));
      } else if (/^\/[\w\u4e00-\u9fa5\-\.\(\)]+\.nes$/i.test(p)) {
        serveFile(res, p.slice(1), "application/octet-stream");
      } else if (/^\/[\w\-]+\.js$/.test(p)) {
        serveFile(res, p.slice(1), "application/javascript; charset=utf-8");
      } else {
        sendJson(res, 404, { error: { message: "not found" } });
      }
    }
  } else {
    sendJson(res, 404, { error: { message: "not found" } });
  }
});

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log("[deepseek-proxy] 已启动: http://127.0.0.1:" + PORT);
  console.log("[deepseek-proxy] 学生版页面: http://127.0.0.1:" + PORT + "/");
  console.log("[deepseek-proxy] 教师版页面: http://127.0.0.1:" + PORT + "/teacher");
  console.log("[deepseek-proxy] 原版模式:   http://127.0.0.1:" + PORT + "/original");
  console.log("[deepseek-proxy] 自检页面:   http://127.0.0.1:" + PORT + "/check");
  console.log("[deepseek-proxy] 上游:   " + UPSTREAM);
  console.log("[deepseek-proxy] 关闭:   Ctrl+C 或关闭此窗口");
});
