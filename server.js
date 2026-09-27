/*
 * SCLM 协议引擎 · 本地服务器（零依赖，Node >= 18）
 *
 * 架构（编译-执行分离）：
 *   LLM（编译器）     → 只做假设编译与审计：预处理分类 / 多假设 DAG / 检视前提 / 反向审计
 *   本文件（运行时）  → 确定性结构推演：Schema 协议校验、有向图校验（无环）、
 *                        后门路径枚举 + d-分离开放/阻断判定、置信度 A/B/C 定级、修正回路编排
 *
 * 接口：
 *   POST /api/infer  { input, baseUrl?, apiKey?, model? }
 *   POST /api/test   { baseUrl?, apiKey?, model? }
 *   GET  /*          静态文件
 *
 * 配置：页面设置（随请求传入） > 环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8641;
const ROOT = __dirname;
const MAX_ROUNDS = 3;              // 修正回路：最多 3 轮（1 次首发 + 2 次重编译）

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8"
};

/* ============ 编译器系统提示词（第 1-4 层） ============ */

const COMPILE_PROMPT = [
  "你是「SCLM 协议引擎」的编译器，严格遵守编译-执行分离：你只负责假设编译与审计（第 1-4 层），所有因果判定、数值校验、稳健结论由外部 SCM 运行时负责。你无权给出最终答案。",
  "",
  "铁律：",
  "1. 无权给出最终答案：只输出提案、检视、转述；禁止确定性因果结论。",
  "2. 严禁混淆相关与因果；无数据支撑不得给出确定性结论。",
  "3. 格式即协议：只输出一个合法 JSON 对象，不输出任何其他文字、注释、代码块标记；不合法视为编译失败。",
  "",
  "执行步骤：",
  "第1层 预处理：判定问题类型——A 纯事实 / B 观测关联 / C 干预假设 / D 反事实推理；提取内生变量（可观测现象/情绪/事件状态）、外生变量（环境噪音/隐含前提）、缺失信息。只分类，不回答。",
  "第2层 多假设编译：生成 2-5 套相互有【实质差异】的候选 DAG（不同的混杂结构、不同的中介路径、甚至相反的因果方向）。禁止只给单一模型，禁止下结论。",
  "第3层 因果检视：逐图列出前置假设与假设失效条件。只暴露隐含前提，不判对错。",
  "第4层 批判审计：反向攻击——找出可推翻结论的隐藏混杂、对立假设、错误因果点、推理盲区；severity 只能取 lethal（足以推翻全部候选图）/ major（显著削弱可信度）/ minor（次要瑕疵），禁止同等权重罗列。",
  "",
  "节点命名协议：可观测变量 id 用 v1..vn；隐藏变量/外生变量 id 用 u1..un；edges 用 id 引用；labels 给出每个 id 的可读名。D 类（反事实）问题必须先明确事实基线 baseline；无法明确时输出 {\"protocol_error\":\"数据缺失协议：D类问题缺少事实基线\"}。若审计后认为任何候选图都无法成立，输出 {\"protocol_error\":\"无法判定：<原因≤60字>\"}。",
  "",
  "只输出符合以下 Schema 的一个 JSON（所有字段必填，中文）：",
  "{",
  "  \"type\": \"A|B|C|D\",",
  "  \"type_rationale\": \"≤30字分类依据\",",
  "  \"endogenous\": [\"内生变量可读名…\"],",
  "  \"exogenous\": [\"外生变量可读名…\"],",
  "  \"missing\": [\"缺失信息…\"],",
  "  \"baseline\": null,   // 仅 D 类非空：{\"facts\":[\"已发生的事实…\"],\"values\":[{\"var\":\"变量名\",\"value\":\"当时取值\"}]}",
  "  \"dags\": [   // 2-5 个，必须实质差异",
  "    { \"dag_id\": \"1\", \"exposure\": \"v1\", \"outcome\": \"v4\",",
  "      \"variables\": [{\"id\":\"v1\",\"label\":\"可读名\",\"note\":\"≤15字\"}],",
  "      \"hidden\":    [{\"id\":\"u1\",\"label\":\"可读名\",\"note\":\"≤15字\"}],",
  "      \"edges\": [[\"u1\",\"v1\"],[\"v1\",\"v4\"]],",
  "      \"assumptions\": [\"该图建模假设…\"],",
  "      \"prior_interval\": [30, 55],",
  "      \"robust\": \"强|中|弱\" }",
  "  ],",
  "  \"review\": [ {\"dag_id\":\"1\", \"premises\":[\"前置假设…\"], \"failure_conditions\":[\"假设失效条件…\"]} ],",
  "  \"audit\": [ {\"severity\":\"lethal|major|minor\", \"risk\":\"风险描述…\", \"affects\":\"影响哪个图/哪条结论\"} ],",
  "  \"tendency\": \"≤60字的倾向性说明（明确不构成结论）\",",
  "  \"uncertainty\": \"≤60字不确定性声明\",",
  "  \"revision_note\": \"首轮输出空字符串\"",
  "}"
].join("\n");

const REVISE_SUFFIX = (prevJSON, issues) => [
  "",
  "—— 修正回路触发 ——",
  "你上一轮的编译输出未通过运行时校验，问题如下：",
  Array.isArray(issues) ? issues.join("；") : String(issues),
  "",
  "上一轮输出（供修改参考）：",
  prevJSON,
  "",
  "请回到第 2 层重编译：修复全部问题（或按协议输出 protocol_error 拒绝推演），",
  "并在 revision_note 字段用 ≤80 字记录本轮修改点。仍然只输出一个合法 JSON 对象。"
].join("\n");

const USER_MSG = (input) => [
  "目标：分析以下事件，输出 SCLM 协议推演记录（第 1-4 层）。",
  "背景输入：" + input,
  "",
  "边界：多假设必须有实质差异；审计必须分级；不得给出确定性结论；只输出 Schema 规定的 JSON。"
].join("\n");

/* ============ 经典格式系统提示词（SCLM 输出 · 观测推理） ============ */

const CLASSIC_PROMPT = [
  "你是 SCLM（Structural Causal Logic Model）因果推理引擎。你的唯一角色是「编译器」：把用户的自然语言观测证据编译为结构因果模型（三元组 M = ⟨U, V, F⟩），并以贝叶斯后验的形式输出推断结果。SCM 是运行时，你是编译器，两者职责分离。",
  "",
  "执行步骤：",
  "1. 读取上下文：从输入中提取内生变量 V（观察到的现象、情绪、事件状态）与外生变量 U（环境噪音、隐含前提、不可观测因素）。",
  "2. 定义结构：构建 M = ⟨U, V, F⟩，并推导 do 算子干预与反事实结论。",
  "3. 生成输出：只输出一个 JSON 对象，不输出任何其他文字、注释或代码块标记。",
  "",
  "写作要求（最重要，直接决定质量）：",
  "- 像一个在该领域摸爬滚打多年的老手在给朋友拆解问题：口吻具体、克制、带行话。禁止空话套话、万能句式、说教腔、总结腔。",
  "- 概率标签必须针对这条输入量身定制：交易情境就用交易黑话（如「排除 20cm 创业板/科创板干扰」「真实承接」「官方定义口径」），生活情境就用该情境里真实会说的表达。检验标准：把标签放到另一条无关输入上若依然成立，就是不合格的通用句。",
  "- 数值要像真实贝叶斯推演：四条概率有层次有差异（第一条最高、第三条通常最低），不要全部偏高、不要凑整数、不要等差。",
  "- do_txt 与 cf_txt 必须含具体百分比和该情境的机制名，不要泛泛而谈。",
  "- 各条 note 是一句话依据，像老手的口头禅式点评，不是解释概念。",
  "",
  "probs 四条依次为：①表面条件概率（直接从观测信号读出的） ②排除干扰/混淆变量后的概率 ③机制有效性概率 ④该领域对「有效/成立」的官方或实际口径概率。每条 label ≤ 24 字。",
  "",
  "只输出符合以下结构的 JSON（所有字段必填，全部使用中文）：",
  "{",
  "  \"domain_badge\": \"领域标签，不超过4字，如：交易情境 / 生活情境 / 职场情境 / 学业情境\"",
  "  \"keywords\": 2或3,",
  "  \"refs\": 8到16的整数,",
  "  \"evidence\": \"用户输入原文，原样返回\",",
  "  \"probs\": [ {\"label\": \"概率标签\", \"value\": 0到100整数, \"note\": \"不超过18字的一句话依据\"} ×4 ],",
  "  \"confidence\": 74到92的整数,",
  "  \"confidence_reason\": \"不超过20字，说明置信度为何是这个水平\",",
  "  \"u\": [\"u₁ ...\", \"u₂ ...\", \"u₃ ...\"],",
  "  \"v\": [\"v₁ ...\", \"v₂ ...\", \"v₃ ...\", \"v₄ ...\"],",
  "  \"f\": [\"v₁ ← f₁(依赖变量)\", \"v₂ ← f₂(...)\", \"v₃ ← f₃(...)（决策节点）\", \"v₄ ← f₄(...)（结果节点）\"],",
  "  \"do_txt\": \"一句话干预推断，含具体百分比与机制\",",
  "  \"cf_txt\": \"反事实一句话，含具体百分比\",",
  "  \"math_layer\": \"1到2句，围绕 SCM 三元组 M = ⟨U, V, F⟩ 针对本条输入的具体化阐述\",",
  "  \"compute_layer\": \"1到2句，LLM 作为编译器 / SCM 作为运行时，结合本条输入说明\",",
  "  \"epistemi_layer\": \"1到2句，知识在于干预不变性而非文本相似性，结合本条输入说明\"",
  "}"
].join("\n");

/* ============ 基础设施 ============ */

function readBody(req){
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => {
      b += c;
      if(b.length > 1e6){ reject(new Error("请求体过大")); req.destroy(); }
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

function json(res, code, obj){
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveStatic(p, res){
  if(p === "/") p = "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  if(!file.startsWith(ROOT)){ res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if(err){
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

/* ============ LLM 调用（OpenAI 兼容） ============ */

function resolveCfg(body){
  return {
    baseUrl: (body && body.baseUrl) || process.env.LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    apiKey:  String((body && body.apiKey)  || process.env.LLM_API_KEY  || "").replace(/\s+/g, ""),
    model:   (body && body.model)   || process.env.LLM_MODEL    || "glm-4.6"
  };
}

async function callLLM(cfg, userMsg, maxTokens, temperature, systemPrompt){
  if(typeof fetch !== "function") throw new Error("当前 Node 版本过低（需 ≥18 才有内置 fetch）");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try{
    const r = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt || COMPILE_PROMPT },
          { role: "user", content: userMsg }
        ],
        temperature: temperature == null ? 0.3 : temperature,
        max_tokens: maxTokens || 3500
      }),
      signal: ctrl.signal
    });
    const text = await r.text();
    if(!r.ok){
      let msg = "上游 API HTTP " + r.status + "：" + text.slice(0, 300);
      if(r.status === 401){
        msg = "上游 API 返回 401（令牌无效或已过期）。排查：① 填平台控制台的【原始 API Key】；② Key 是否过期/被重置；③ Base URL 必须与 Key 同平台。";
        if(/bigmodel\.cn/i.test(cfg.baseUrl) && /^sk-[0-9a-zA-Z]{20,}/.test(cfg.apiKey)){
          msg = "上游 API 返回 401：你的 Key 是 sk- 开头（DeepSeek / OpenAI 风格），但 Base URL 指向智谱——Key 和平台不匹配。若用 DeepSeek：Base URL 改为 https://api.deepseek.com ，模型改为 deepseek-chat。";
        }
      } else if(r.status === 404){
        msg = "上游 API 返回 404（接口路径不存在）。Base URL 一般要填到版本号这一级，智谱为 https://open.bigmodel.cn/api/paas/v4，DeepSeek 为 https://api.deepseek.com。原始返回：" + text.slice(0, 200);
      }
      throw new Error(msg);
    }
    let j;
    try{ j = JSON.parse(text); }catch(e){ throw new Error("上游返回非 JSON：" + text.slice(0, 300)); }
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if(!content) throw new Error("API 返回 content 为空：" + text.slice(0, 300));
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function extractJSON(s){
  s = String(s).trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const i = s.indexOf("{"), k = s.lastIndexOf("}");
  if(i === -1 || k === -1 || k <= i) throw new Error("LLM 返回中未找到 JSON 对象");
  return JSON.parse(s.slice(i, k + 1));
}

/* ============ SCM 结构运行时（确定性推演，无 LLM） ============ */

/* 图校验：id 引用完整性 + 有向无环 */
function graphErrors(dag){
  const errs = [];
  const obs = Array.isArray(dag.variables) ? dag.variables : [];
  const hid = Array.isArray(dag.hidden) ? dag.hidden : [];
  const ids = new Set([...obs.map(v => v && v.id), ...hid.map(v => v && v.id)]);
  if(!ids.has(dag.exposure)) errs.push("exposure 节点 " + dag.exposure + " 不在变量表中");
  if(!ids.has(dag.outcome))  errs.push("outcome 节点 " + dag.outcome + " 不在变量表中");
  if(dag.exposure === dag.outcome) errs.push("exposure 与 outcome 不能相同");
  (dag.edges || []).forEach(e => {
    if(!Array.isArray(e) || e.length !== 2 || !ids.has(e[0]) || !ids.has(e[1])){
      errs.push("边 " + JSON.stringify(e) + " 引用了未定义节点");
    }
  });
  /* Kahn 检测有向环 */
  if(!errs.length){
    const indeg = {}, children = {};
    ids.forEach(id => { indeg[id] = 0; children[id] = []; });
    (dag.edges || []).forEach(([a, b]) => { indeg[b]++; children[a].push(b); });
    const q = Array.from(ids).filter(id => indeg[id] === 0);
    let seen = 0;
    while(q.length){
      const n = q.shift(); seen++;
      children[n].forEach(m => { if(--indeg[m] === 0) q.push(m); });
    }
    if(seen !== ids.size) errs.push("存在有向环（DAG 必须无环）");
  }
  return errs;
}

/* d-分离：枚举 exposure→outcome 全部简单路径，判定开放/阻断；分类后门路径 */
function analyzeDAG(dag){
  const ids = new Set([
    ...(dag.variables || []).map(v => v && v.id),
    ...(dag.hidden || []).map(v => v && v.id)
  ]);
  const E = (dag.edges || []).filter(e => Array.isArray(e) && e.length === 2);
  const directed = new Set(E.map(([a, b]) => a + "|" + b));
  const children = {};
  ids.forEach(id => children[id] = []);
  E.forEach(([a, b]) => children[a] && children[a].push(b));

  const zObs = new Set((dag.variables || []).map(v => v.id));   // 可观测变量集合 Z
  zObs.delete(dag.exposure); zObs.delete(dag.outcome);

  /* collider 及其后代是否触及 Z */
  function colliderOpen(n){
    if(zObs.has(n)) return true;
    const st = [...(children[n] || [])], seen = new Set();
    while(st.length){
      const m = st.pop();
      if(zObs.has(m)) return true;
      if(!seen.has(m)){ seen.add(m); (children[m] || []).forEach(x => st.push(x)); }
    }
    return false;
  }

  /* 全部简单路径 */
  const paths = [];
  const cur = [dag.exposure], used = new Set([dag.exposure]);
  const adj = {};
  ids.forEach(id => adj[id] = new Set());
  E.forEach(([a, b]) => { adj[a].add(b); adj[b].add(a); });
  (function dfs(node){
    if(node === dag.outcome){ paths.push([...cur]); return; }
    [...adj[node]].forEach(nb => {
      if(!used.has(nb)){ used.add(nb); cur.push(nb); dfs(nb); cur.pop(); used.delete(nb); }
    });
  })(dag.exposure);

  const backdoor = [], causal = [], other = [];
  paths.forEach(p => {
    const firstIntoExposure = directed.has(p[1] + "|" + p[0]);  // 首边指向 exposure → 后门
    let open = true; const blockers = [];
    for(let i = 1; i < p.length - 1; i++){
      const prev = p[i - 1], next = p[i + 1];
      const collider = directed.has(prev + "|" + p[i]) && directed.has(next + "|" + p[i]);
      if(collider){
        if(!colliderOpen(p[i])){ open = false; blockers.push(p[i] + "(碰撞子)"); }
      } else if(zObs.has(p[i])){
        open = false; blockers.push(p[i]);
      }
    }
    const isCausal = p.every((n, i) => i === 0 || directed.has(p[i - 1] + "|" + n));
    const rec = { path: p, open, blockers };
    if(firstIntoExposure) backdoor.push(rec);
    else if(isCausal) causal.push(rec);
    else other.push(rec);
  });

  return {
    dag_id: dag.dag_id,
    backdoor_total: backdoor.length,
    backdoor_open: backdoor.filter(r => r.open).length,
    open_paths: backdoor.filter(r => r.open).map(r => r.path),
    blocked_paths: backdoor.filter(r => !r.open).map(r => ({ path: r.path, blockers: r.blockers })),
    has_causal_path: causal.length > 0
  };
}

/* 协议 Schema 校验（格式即协议） */
function validateRecord(d){
  const errs = [];
  if(!d || typeof d !== "object") return ["输出不是 JSON 对象"];
  if(!["A", "B", "C", "D"].includes(d.type)) errs.push("type 必须是 A/B/C/D");
  if(!Array.isArray(d.dags) || d.dags.length < 2) errs.push("dags 至少需要 2 套候选（禁止单一模型）");
  if(d.dags && d.dags.length > 5) errs.push("dags 最多 5 套");
  (d.dags || []).forEach((dag, i) => {
    dag = dag || {};
    if(!dag.dag_id) errs.push("第 " + (i + 1) + " 个 DAG 缺 dag_id");
    graphErrors(dag).forEach(e => errs.push("DAG " + (dag.dag_id || i + 1) + "：" + e));
    if(!Array.isArray(dag.variables) || !dag.variables.length) errs.push("DAG " + (dag.dag_id || i + 1) + " 缺 variables");
    if(dag.prior_interval && (!Array.isArray(dag.prior_interval) || dag.prior_interval.length !== 2 ||
      !isFinite(dag.prior_interval[0]) || !isFinite(dag.prior_interval[1]) ||
      dag.prior_interval[0] < 0 || dag.prior_interval[1] > 100 || dag.prior_interval[0] > dag.prior_interval[1])){
      errs.push("DAG " + (dag.dag_id || i + 1) + " prior_interval 必须是 [下界,上界] 且 0≤下界≤上界≤100");
    }
  });
  if(!Array.isArray(d.audit)) errs.push("缺 audit（批判审计必须输出，可为空数组但需明确）");
  (d.audit || []).forEach((a, i) => {
    if(!a || !["lethal", "major", "minor"].includes(a.severity)) errs.push("audit[" + i + "] severity 必须是 lethal/major/minor");
  });
  if(!Array.isArray(d.endogenous) || !d.endogenous.length) errs.push("缺 endogenous（内生变量）");
  return errs;
}

function hasBaseline(d){
  return d && d.type === "D" && d.baseline && Array.isArray(d.baseline.facts) && d.baseline.facts.length > 0;
}

/* 置信度定级（运行时确定性规则，量化依据） */
function gradeRecord(record, runtime){
  const lethal = record.audit.filter(a => a.severity === "lethal").length;
  const major  = record.audit.filter(a => a.severity === "major").length;
  const minor  = record.audit.filter(a => a.severity === "minor").length;
  const n      = record.dags.length;
  const conv   = runtime.dags.filter(x => x.has_causal_path).length;
  const openTotal = runtime.dags.reduce((s, x) => s + x.backdoor_open, 0);
  const bdTotal   = runtime.dags.reduce((s, x) => s + x.backdoor_total, 0);

  let grade, reason;
  if(lethal > 0){
    grade = "C";
    reason = "存在 " + lethal + " 条致死级风险，按协议不得给出可信结论（置信度等级 C-低可信）";
  } else if(openTotal > 0){
    grade = "B";
    reason = "存在 " + openTotal + " 条未阻断后门路径（共 " + bdTotal + " 条），混杂未完全排除";
  } else if(major > 0){
    grade = "B";
    reason = "后门全部阻断，但存在 " + major + " 条重要级风险未消除";
  } else {
    grade = "A";
    reason = n + " 套候选图中 " + conv + " 套核心因果方向一致，后门路径 " + bdTotal + "/" + bdTotal + " 全部阻断，无致死/重要风险";
  }
  const basis = "量化依据：候选图 " + n + " 个；方向一致 " + conv + " 个；后门未阻断 " + openTotal + "/" + bdTotal + " 条；风险 致死 " + lethal + " / 重要 " + major + " / 次要 " + minor;
  return { grade, reason, basis, counts: { lethal, major, minor, openTotal, bdTotal, conv, n } };
}

/* ============ 协议编排（含修正回路） ============ */

async function orchestrate(cfg, input){
  const rounds = [];
  let issues = null, record = null;

  for(let round = 1; round <= MAX_ROUNDS; round++){
    const prompt = round === 1
      ? USER_MSG(input)
      : REVISE_SUFFIX(JSON.stringify(record), Array.isArray(issues) ? issues.join("；") : String(issues));

    const content = await callLLM(cfg, prompt, 3500, 0.3);

    let parsed, parseErr = null;
    try{ parsed = extractJSON(content); }catch(e){ parseErr = String(e.message || e); }

    if(parseErr){
      rounds.push({ round, trigger: "格式即协议：Schema 解析失败（" + parseErr.slice(0, 120) + "）", note: "打回重编译" });
      issues = ["上一轮输出不是合法 JSON 或缺少对象结构：" + parseErr];
      record = null;
      continue;
    }
    if(parsed.protocol_error){
      /* 协议性拒绝（数据缺失 / 无法判定）：按 Final Rule 不重试，直接转述 */
      rounds.push({ round, trigger: "编译器按协议拒绝", note: String(parsed.protocol_error).slice(0, 120) });
      return { refused: true, message: String(parsed.protocol_error), rounds };
    }
    if(parsed.type === "D" && !hasBaseline(parsed)){
      rounds.push({ round, trigger: "数据缺失协议：D 类问题缺少事实基线", note: "打回重编译" });
      issues = ["type=D 时必须输出非空 baseline（facts 至少 1 条），否则按协议只能输出 protocol_error。请先从输入中提取事实基线；输入确实未提供则输出 {\"protocol_error\":\"数据缺失协议：D类问题缺少事实基线\"}。"];
      record = null;
      continue;
    }
    const errs = validateRecord(parsed);
    if(errs.length){
      rounds.push({ round, trigger: "Schema 校验失败（" + errs.length + " 项）", note: "打回重编译" });
      issues = errs;
      record = null;
      continue;
    }

    record = parsed;
    /* 运行时确定推演 */
    const runtime = {
      dags: record.dags.map(analyzeDAG),
      findings: []
    };
    /* 运行时审计增强：检出未阻断后门 → 追加 major；自评强稳健与结构矛盾 → 降级标注 */
    runtime.dags.forEach(x => {
      if(x.backdoor_open > 0){
        runtime.findings.push({ severity: "major", risk: "运行时检出 DAG " + x.dag_id + " 有 " + x.backdoor_open + " 条未阻断后门路径（编译器未列出），混杂未排除", affects: "DAG " + x.dag_id });
      }
    });
    record.dags.forEach(dag => {
      const rt = runtime.dags.find(x => x.dag_id === dag.dag_id);
      if(rt && rt.backdoor_open > 0 && dag.robust === "强"){
        runtime.findings.push({ severity: "minor", risk: "DAG " + dag.dag_id + " 自评稳健=强，但存在未阻断后门，运行时降级为≤中", affects: "DAG " + dag.dag_id });
        dag.robust = "中（运行时降级）";
      }
    });
    runtime.findings.forEach(f => record.audit.push(f));

    const grade = gradeRecord(record, runtime);
    runtime.grade = grade;

    if(grade.counts.lethal > 0 && round < MAX_ROUNDS){
      rounds.push({ round, trigger: "审计发现 " + grade.counts.lethal + " 条致死级风险——回到第 2 层重编译", note: record.revision_note || "（等待重编译修复）" });
      issues = [
        "审计中存在致死级（lethal）风险，按协议不得带着致死缺陷定稿：",
        ...record.audit.filter(a => a.severity === "lethal").map(a => "- " + a.risk),
        "请修正 DAG 结构（增加阻断变量/改变混杂假设），或将该风险降级并给出充分理由；无法修复则输出 protocol_error。"
      ].join("\n");
      continue;
    }

    rounds.push({
      round,
      trigger: round === 1 ? "首次编译通过运行时校验" : "重编译通过运行时校验",
      note: (record.revision_note || "结构校验通过") + "；" + grade.basis
    });
    return { refused: false, record, runtime, rounds };
  }

  return {
    refused: true,
    message: "修正回路耗尽（" + MAX_ROUNDS + " 轮）仍未通过协议校验，按 Final Rule 拒绝给出推演记录，禁止幻觉补全。",
    rounds
  };
}

/* 经典格式（单次调用，观测推理） */
async function orchestrateClassic(cfg, input){
  const userMsg = [
    "目标：分析以下事件，并输出 SCLM 因果推理报告。",
    "背景输入：" + input,
    "",
    "边界：",
    "- 必须使用「SCLM 输出（观测推理）」结构。",
    "- 概率推断需要贴合行业黑话或生活情境。",
    "- 底部必须附带「数学层/计算层/认知论」原理解释。",
    "",
    "完成标准：只输出符合 System 指令 JSON 结构的一个 JSON 对象。"
  ].join("\n");
  const content = await callLLM(cfg, userMsg, 2200, 0.7, CLASSIC_PROMPT);
  const data = extractJSON(content);
  if(data.protocol_error) return { refused: true, message: String(data.protocol_error) };
  return { format: "classic", data };
}

/* ============ 计算引擎（编译器 + 计算器 + 沙盘） ============ */

const ENGINE_PROMPT = [
  "你是因果计算引擎的【编译器】。你只负责把场景编译为带结构方程的定量 SCM 候选模型；你被严禁计算任何结果数值——所有数字（效应、概率、区间）由外部 SCM 蒙特卡洛运行时计算。你输出一个数字都没有的模型规格，就是成功的编译。",
  "",
  "建模规则：",
  "1. 生成 2-3 个结构有实质差异的候选模型（不同的混杂假设 / 是否含中介 / 不同噪声设定）。",
  "2. 内生变量 id 用 v1..vn；外生变量（背景与噪声源）id 用 u1..un，各给分布。",
  "3. 每个内生变量恰好一条结构方程：target = link(coefs × parents) + noise。binary 用 logistic 链接，continuous 用 linear 链接。",
  "4. exposure 必须 binary，treatment 取值 0/1；outcome 是关注的结果变量（binary 或 continuous）。",
  "5. 系数取 [-3,3] 之间的合理量级（_int 为截距）。系数符号与量级体现你对机制强度的假设——这是你表达领域判断的唯一位置。",
  "6. 至少一个模型包含会制造「观测关联 ≠ 因果效应」的混淆结构（如 u 同时指向 exposure 与 outcome），允许其中一个模型是「天真版」作为对照。",
  "7. archetypes（沙盘智能体原型）2-3 个：不同人群基线差异，weight 之和为 1，exposure_shift 是该人群 exposure 方程截距的偏移量（[-2,2]）。",
  "8. 禁止输出 ATE、概率、效应量等任何结果数值。",
  "",
  "只输出以下 Schema 的 JSON（全中文，无多余文字）：",
  "{",
  "  \"context\": \"≤20字场景\",",
  "  \"models\": [",
  "    { \"model_id\": \"M1\", \"title\": \"≤14字结构差异说明\",",
  "      \"variables\": [ {\"id\":\"v1\",\"label\":\"≤8字\",\"type\":\"binary|continuous\",\"role\":\"exposure|outcome|mediator|confounder|other\"} ],",
   "      \"exogenous\": [ {\"id\":\"u1\",\"label\":\"≤8字\",\"observed\":true或false,\"dist\":{\"kind\":\"bernoulli\",\"p\":0.5} 或 {\"kind\":\"normal\",\"mean\":0,\"sd\":1}} ],",
  "      \"equations\": [ {\"target\":\"v1\",\"parents\":[\"u1\",\"u2\"],\"link\":\"logistic|linear\",\"coefs\":{\"u1\":1.0,\"u2\":-0.8,\"_int\":0.2},\"noise\":{\"kind\":\"normal\",\"sd\":1}} ],",
  "      \"treatment\": {\"var\":\"v1\",\"control\":0,\"treated\":1},",
  "      \"archetypes\": [ {\"label\":\"≤6字\",\"weight\":0.4,\"exposure_shift\":-0.4} ]",
  "    }",
  "  ]",
  "}"
].join("\n");

const NARRATE_PROMPT = [
  "你是因果计算引擎的【转述员】。你会收到 SCM 运行时已计算完成的结果 JSON。任务：用该领域老手的口吻把结果讲给人听。",
  "铁律：",
  "1. 数字必须逐字引用结果里的数值（包括小数与百分号形式），禁止四舍五入成别的数、禁止编造任何结果里没有的数字。",
  "2. 只解释，不推翻：不得改变效应方向与结论等级，不得删减风险。",
  "3. 每条 reading ≤ 110 字；overall ≤ 80 字；uncertainty ≤ 60 字。",
  "只输出 JSON：{\"models\":[{\"model_id\":\"M1\",\"reading\":\"...\"}],\"overall\":\"...\",\"uncertainty\":\"...\"}"
].join("\n");

/* ---- 内置演示模型（无 API Key 时的真实引擎演示） ---- */
function demoModels(){
  return [
    {
      model_id: "M1", title: "完整混杂：支持/压力双向混淆",
      variables: [
        { id: "v1", label: "辞职备考", type: "binary", role: "exposure" },
        { id: "v2", label: "焦虑水平", type: "continuous", role: "mediator" },
        { id: "v3", label: "上岸结果", type: "binary", role: "outcome" }
      ],
      exogenous: [
        { id: "u1", label: "家庭支持", observed: true, dist: { kind: "bernoulli", p: 0.5 } },
        { id: "u2", label: "存款压力", observed: true, dist: { kind: "normal", mean: 2, sd: 1 } },
        { id: "u3", label: "基础实力", observed: true, dist: { kind: "normal", mean: 0, sd: 1 } }
      ],
      equations: [
        { target: "v1", parents: ["u1", "u2"], link: "logistic", coefs: { u1: 1.1, u2: -0.9, _int: -0.3 } },
        { target: "v2", parents: ["v1", "u2"], link: "linear", coefs: { v1: -0.6, u2: 0.55, _int: 2.0 }, noise: { kind: "normal", sd: 1 } },
        { target: "v3", parents: ["v1", "v2", "u1", "u3"], link: "logistic", coefs: { v1: 0.9, v2: -0.35, u1: 0.5, u3: 0.7, _int: -0.2 } }
      ],
      treatment: { var: "v1", control: 0, treated: 1 },
      archetypes: [
        { label: "应届生", weight: 0.4, exposure_shift: 0.5 },
        { label: "在职党", weight: 0.35, exposure_shift: -0.9 },
        { label: "二战党", weight: 0.25, exposure_shift: 0.3 }
      ]
    },
    {
      model_id: "M2", title: "天真版：忽略家庭支持混淆",
      variables: [
        { id: "v1", label: "辞职备考", type: "binary", role: "exposure" },
        { id: "v2", label: "焦虑水平", type: "continuous", role: "mediator" },
        { id: "v3", label: "上岸结果", type: "binary", role: "outcome" }
      ],
      exogenous: [
        { id: "u1", label: "家庭支持", observed: true, dist: { kind: "bernoulli", p: 0.5 } },
        { id: "u2", label: "存款压力", observed: true, dist: { kind: "normal", mean: 2, sd: 1 } },
        { id: "u3", label: "基础实力", observed: true, dist: { kind: "normal", mean: 0, sd: 1 } }
      ],
      equations: [
        { target: "v1", parents: ["u1", "u2"], link: "logistic", coefs: { u1: 1.1, u2: -0.9, _int: -0.3 } },
        { target: "v2", parents: ["v1", "u2"], link: "linear", coefs: { v1: -0.6, u2: 0.55, _int: 2.0 }, noise: { kind: "normal", sd: 1 } },
        { target: "v3", parents: ["v1", "v2", "u3"], link: "logistic", coefs: { v1: 0.9, v2: -0.35, u3: 0.7, _int: 0.1 } }
      ],
      treatment: { var: "v1", control: 0, treated: 1 },
      archetypes: [
        { label: "应届生", weight: 0.4, exposure_shift: 0.5 },
        { label: "在职党", weight: 0.35, exposure_shift: -0.9 },
        { label: "二战党", weight: 0.25, exposure_shift: 0.3 }
      ]
    }
  ];
}

/* ---- RNG 与分布采样 ---- */
function hashSeed(str){
  let h = 2166136261;
  for(let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function makeRng(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampleDist(d, rng){
  const kind = (d && d.kind) || "normal";
  if(kind === "bernoulli") return rng() < (d.p == null ? 0.5 : d.p) ? 1 : 0;
  if(kind === "uniform") return (d.a == null ? 0 : d.a) + rng() * ((d.b == null ? 1 : d.b) - (d.a == null ? 0 : d.a));
  if(kind === "constant") return d.value == null ? 0 : d.value;
  let u = 0, v = 0;
  while(u === 0) u = rng();
  while(v === 0) v = rng();
  return (d.mean || 0) + (d.sd == null ? 1 : d.sd) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const r3 = v => Math.round(v * 1000) / 1000;
const sigmoid = z => 1 / (1 + Math.exp(-z));

/* ---- 模型校验与拓扑 ---- */
function engineModelErrors(m){
  const errs = [];
  const varIds = new Set((m.variables || []).map(v => v.id));
  const exoIds = new Set((m.exogenous || []).map(e => e.id));
  const all = new Set([...varIds, ...exoIds]);
  if(!m.treatment || !varIds.has(m.treatment.var)) errs.push("treatment.var 不在变量表中");
  const expo = (m.variables || []).find(v => v.role === "exposure");
  const outc = (m.variables || []).find(v => v.role === "outcome");
  if(!expo) errs.push("缺 role=exposure 的变量");
  if(!outc) errs.push("缺 role=outcome 的变量");
  if(expo && expo.type !== "binary") errs.push("exposure 必须 binary");
  (m.equations || []).forEach(eq => {
    if(!varIds.has(eq.target)) errs.push("方程 target " + eq.target + " 不在内生变量中");
    (eq.parents || []).forEach(p => { if(!all.has(p)) errs.push("方程 " + eq.target + " 引用未知节点 " + p); });
    Object.keys(eq.coefs || {}).forEach(k => { if(k !== "_int" && !all.has(k)) errs.push("系数 " + k + " 引用未知节点"); });
  });
  /* 每个内生变量恰一条方程 + 无环（Kahn） */
  if(!errs.length){
    const eqMap = {};
    (m.equations || []).forEach(eq => { if(eqMap[eq.target]) errs.push("变量 " + eq.target + " 有多条方程"); eqMap[eq.target] = eq; });
    varIds.forEach(id => { if(!eqMap[id]) errs.push("内生变量 " + id + " 缺结构方程"); });
    if(!errs.length){
      const indeg = {}, children = {};
      varIds.forEach(id => { indeg[id] = 0; children[id] = []; });
      Object.values(eqMap).forEach(eq => (eq.parents || []).forEach(p => { if(varIds.has(p)){ indeg[eq.target]++; children[p].push(eq.target); } }));
      const q = Object.keys(indeg).filter(id => indeg[id] === 0);
      let seen = 0, order = [];
      while(q.length){
        const n = q.shift(); seen++; order.push(n);
        children[n].forEach(t => { if(--indeg[t] === 0) q.push(t); });
      }
      if(seen !== varIds.size) errs.push("结构方程存在环");
      m.__topo = order; m.__eqMap = eqMap;
    }
  }
  return errs;
}

/* ---- 蒙特卡洛模拟器 ---- */
function simulate(m, n, doSpec, shift){
  const rng = makeRng(hashSeed(JSON.stringify(m.treatment) + m.model_id + ":" + (doSpec ? JSON.stringify(doSpec) + shift : "passive")));
  const vals = new Array(n);
  for(let i = 0; i < n; i++){
    const row = {};
    (m.exogenous || []).forEach(e => { row[e.id] = sampleDist(e.dist, rng); });
    (m.__topo || []).forEach(tid => {
      if(doSpec && doSpec.var === tid){ row[tid] = doSpec.value; return; }
      const eq = m.__eqMap[tid];
      let z = (eq.coefs && eq.coefs._int) || 0;
      if(tid === m.treatment.var && shift) z += shift;
      (eq.parents || []).forEach(p => { if(p !== tid) z += ((eq.coefs || {})[p] || 0) * row[p]; });
      if(eq.link === "logistic") row[tid] = sigmoid(z) > rng() ? 1 : 0;
      else row[tid] = z + sampleDist({ kind: "normal", mean: 0, sd: (eq.noise && eq.noise.sd) || 1 }, rng);
    });
    vals[i] = row;
  }
  return vals;
}
function meanBy(rows, yId, filter){
  let s = 0, c = 0;
  rows.forEach(r => { if(!filter || filter(r)){ s += r[yId]; c++; } });
  return c ? s / c : null;
}
function mean(arr){ return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function percentile(arr, p){
  if(!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[i];
}

/* ---- 后门识别（运行时自行计算，不信任编译器） ---- */
function backdoorIdentify(m){
  const X = m.treatment.var;
  const outc = (m.variables || []).find(v => v.role === "outcome");
  const Y = outc ? outc.id : null;
  const observed = new Set((m.variables || []).map(v => v.id));
  (m.exogenous || []).forEach(e => { if(e && e.observed) observed.add(e.id); });
  const directed = new Set();
  (m.__topo || []).forEach(tid => (m.__eqMap[tid].parents || []).forEach(p => { if(observed.has(tid)) directed.add(p + "|" + tid); }));
  const allNodes = new Set([...observed, ...(m.exogenous || []).map(e => e.id)]);
  const adj = {}; allNodes.forEach(n => adj[n] = new Set());
  directed.forEach(k => { const [a, b] = k.split("|"); adj[a].add(b); adj[b].add(a); });
  const children = {}; allNodes.forEach(n => children[n] = []);
  directed.forEach(k => { const [a, b] = k.split("|"); children[a].push(b); });

  /* 简单路径枚举 */
  const paths = [];
  const cur = [X], used = new Set([X]);
  (function dfs(node){
    if(node === Y){ paths.push([...cur]); return; }
    [...adj[node]].forEach(nb => { if(!used.has(nb)){ used.add(nb); cur.push(nb); dfs(nb); cur.pop(); used.delete(nb); } });
  })(X);

  function colliderOpen(nc, Z){
    if(Z.has(nc)) return true;
    const st = [...children[nc]], seen = new Set();
    while(st.length){ const x = st.pop(); if(Z.has(x)) return true; if(!seen.has(x)){ seen.add(x); children[x].forEach(c => st.push(c)); } }
    return false;
  }
  function openBackdoors(Zset){
    const out = [];
    paths.forEach(p => {
      if(!(directed.has(p[1] + "|" + p[0]))) return;        // 首边必须指向 X 才是后门
      let open = true;
      for(let i = 1; i < p.length - 1 && open; i++){
        const prev = p[i - 1], next = p[i + 1];
        const collider = directed.has(prev + "|" + p[i]) && directed.has(next + "|" + p[i]);
        if(collider){ if(!colliderOpen(p[i], Zset)) open = false; }
        else if(Zset.has(p[i])) open = false;
      }
      if(open) out.push(p);
    });
    return out;
  }
  /* Z 不得包含 X 的后代（否则阻断中介路径，估出来是直接效应而非总效应） */
  function isDescendantOfX(n){
    const st = [...children[X]], seen = new Set();
    while(st.length){ const x = st.pop(); if(x === n) return true; if(!seen.has(x)){ seen.add(x); children[x].forEach(c => st.push(c)); } }
    return false;
  }
  const Z0 = new Set([...observed].filter(id => id !== X && id !== Y && !isDescendantOfX(id)));
  const openAll = openBackdoors(Z0);
  /* 调整集：若全协变量已阻断则直接用之；否则取开放后门路径上的可观测节点 */
  let cand;
  if(openAll.length === 0){
    cand = new Set(Z0);
  } else {
    cand = new Set();
    openAll.forEach(p => p.forEach(n => { if(n !== X && n !== Y && observed.has(n) && !isDescendantOfX(n)) cand.add(n); }));
  }
  const finalOpen = openBackdoors(cand);
  const identified = finalOpen.length === 0;
  return {
    exposure: X, outcome: Y,
    backdoor_total: paths.filter(p => directed.has(p[1] + "|" + p[0])).length,
    adjustment_set: [...cand],
    identified: identified && finalOpen.length === 0,
    open_paths: finalOpen,
    unobserved_confounder: finalOpen.some(p => p.some(n => !observed.has(n) && n !== X && n !== Y))
  };
}

/* ---- 后门调整估计（分层） ---- */
function backdoorEstimate(rows, m, ident){
  const X = m.treatment.var, Y = ident.outcome;
  const Z = ident.adjustment_set.filter(z => rows.some(r => r[z] !== undefined));
  if(!Z.length || !ident.identified) return { value: null, note: "不可识别或无可用调整集" };
  const nB = 4;
  const bins = {};
  Z.forEach(z => {
    const vs = rows.map(r => r[z]).sort((a, b) => a - b);
    const qs = [0.25, 0.5, 0.75].map(q => percentile(vs, q));
    bins[z] = v => qs.reduce((acc, q, i) => acc + (v > q ? 1 : 0), 0);   // 0..3
  });
  const strata = {};
  rows.forEach(r => {
    const key = Z.map(z => bins[z](r[z])).join("|");
    (strata[key] = strata[key] || { n: 0, t: [], c: [] });
    strata[key].n++;
    if(r[X] === m.treatment.treated) strata[key].t.push(r[Y]);
    else if(r[X] === m.treatment.control) strata[key].c.push(r[Y]);
  });
  let num = 0, wsum = 0, usedStrata = 0;
  Object.values(strata).forEach(s => {
    if(s.t.length >= 5 && s.c.length >= 5){ num += s.n * (mean(s.t) - mean(s.c)); wsum += s.n; usedStrata++; }
  });
  return { value: wsum ? r3(num / wsum) : null, strata: usedStrata, note: usedStrata ? "后门调整（按 " + Z.join("/") + " 分层）" : "正性不足：分层后缺乏对照组" };
}

/* ---- 单模型完整计算 ---- */
function computeModel(m, input){
  const N = 1500;
  const X = m.treatment.var;
  const outc = (m.variables || []).find(v => v.role === "outcome");
  const Y = outc ? outc.id : null;
  const errs = engineModelErrors(m);
  if(errs.length) return { model_id: m.model_id, title: m.title, errors: errs };

  const treated = simulate(m, N, { var: X, value: m.treatment.treated }, 0);
  const control = simulate(m, N, { var: X, value: m.treatment.control }, 0);
  const yT = treated.map(r => r[Y]), yC = control.map(r => r[Y]);
  const ate = mean(yT) - mean(yC);
  /* bootstrap CI */
  const boots = [];
  for(let b = 0; b < 200; b++){
    const bt = [], bc = [];
    for(let i = 0; i < 300; i++){ bt.push(yT[(Math.random() * N) | 0]); bc.push(yC[(Math.random() * N) | 0]); }
    boots.push(mean(bt) - mean(bc));
  }
  const ci = [percentile(boots, 0.025), percentile(boots, 0.975)];

  const passive = simulate(m, N * 2, null, 0);
  const obsT = meanBy(passive, Y, r => r[X] === m.treatment.treated);
  const obsC = meanBy(passive, Y, r => r[X] === m.treatment.control);
  const obsContrast = (obsT != null && obsC != null) ? obsT - obsC : null;

  const ident = backdoorIdentify(m);
  const adj = backdoorEstimate(passive, m, ident);

  /* 反驳检验 */
  const placeboRows = simulate(m, N, { var: X, value: null, random: true }, 0);
  const placeboRows2 = simulate(m, N, { var: X, value: null, random: true }, 0.5);
  const placebo = mean(placeboRows.map(r => r[Y])) - mean(placeboRows2.map(r => r[Y]));
  const halfT = mean(yT.slice(0, N >> 1)) - mean(yC.slice(0, N >> 1));
  const m2 = JSON.parse(JSON.stringify(m)); m2.__topo = null; m2.__eqMap = null;
  engineModelErrors(m2);
  const yIdOld = Y;
  m2.__eqMap[yIdOld].noise = { kind: "normal", sd: ((m2.__eqMap[yIdOld].noise || {}).sd || 1) + 0.5 };
  const extraT = simulate(m2, 800, { var: X, value: m.treatment.treated }, 0);
  const extraC = simulate(m2, 800, { var: X, value: m.treatment.control }, 0);
  const ateNoisy = mean(extraT.map(r => r[Y])) - mean(extraC.map(r => r[Y]));

  const refuters = {
    placebo: { value: r3(placebo), pass: Math.abs(placebo) < 0.06, note: "伪处理效应应≈0" },
    subset: { value: r3(halfT), pass: halfT >= ci[0] - 0.02 && halfT <= ci[1] + 0.02, note: "半样本重估应落在置信区间内" },
    noise: { value: r3(ateNoisy), pass: Math.abs(ateNoisy - ate) < 0.04, note: "加噪声后效应应稳定" }
  };

  /* 沙盘：多智能体原型 */
  const archs = (m.archetypes && m.archetypes.length ? m.archetypes : [{ label: "总体", weight: 1, exposure_shift: 0 }]);
  const wsum = archs.reduce((s, a) => s + (a.weight || 0), 0) || 1;
  const sandbox = archs.map(a => {
    const na = Math.max(200, Math.round(N * (a.weight || 0) / wsum));
    const aT = simulate(m, na, { var: X, value: m.treatment.treated }, a.exposure_shift || 0);
    const aC = simulate(m, na, { var: X, value: m.treatment.control }, a.exposure_shift || 0);
    const ateA = mean(aT.map(r => r[Y])) - mean(aC.map(r => r[Y]));
    return {
      label: a.label, n: na * 2, exposure_shift: a.exposure_shift || 0,
      ate: r3(ateA),
      y_treated: outc.type === "binary" ? r3(mean(aT.map(r => r[Y]))) : r3(mean(aT.map(r => r[Y]))),
      y_control: r3(mean(aC.map(r => r[Y])))
    };
  });

  const hist = outc.type === "binary" ? null : (() => {
    const all = [...yT, ...yC];
    const lo = Math.min(...all), hi = Math.max(...all);
    const B = 12, w = (hi - lo) / B || 1;
    const bin = arr => { const h = new Array(B).fill(0); arr.forEach(v => h[Math.min(B - 1, Math.floor((v - lo) / w))]++); return h.map(c => r3(c / arr.length)); };
    return { bins: B, lo: r3(lo), w: r3(w), treated: bin(yT), control: bin(yC) };
  })();

  return {
    model_id: m.model_id, title: m.title,
    n_per_arm: N,
    outcome: Y, exposure: X, outcome_type: outc.type,
    labels: (() => { const L = {}; (m.variables || []).forEach(v => L[v.id] = v.label); (m.exogenous || []).forEach(e => L[e.id] = (e && e.label) || e.id); return L; })(),
    edges: (m.__topo || []).map(tid => ({ target: tid, parents: (m.__eqMap[tid].parents || []) })),
    identification: {
      adjustment_set: ident.adjustment_set,
      backdoor_total: ident.backdoor_total,
      identified: ident.identified,
      unobserved_confounder: ident.unobserved_confounder
    },
    ate: { value: r3(ate), ci: [r3(ci[0]), r3(ci[1])], y_treated: r3(mean(yT)), y_control: r3(mean(yC)) },
    observational: { contrast: obsContrast == null ? null : r3(obsContrast), bias: obsContrast == null ? null : r3(Math.abs(obsContrast - ate)) },
    adjustment_estimate: adj,
    refuters, sandbox, hist
  };
}

function numberSet(obj, out){
  if(typeof obj === "number"){ out.add(r3(obj)); out.add(Math.round(obj * 100)); return; }
  if(Array.isArray(obj)) obj.forEach(x => numberSet(x, out));
  else if(obj && typeof obj === "object") Object.values(obj).forEach(x => numberSet(x, out));
}

async function runEngine(cfg, input, res){
  const rounds = [];
  let spec = null;

  /* 无 Key → 内置演示模型，走同一套运行时 */
  if(!cfg.apiKey){
    const results = demoModels().map(m => computeModel(m, input));
    const cross = crossModel(results);
    const verdict = engineVerdict(results, cross);
    const narr = templateNarration(results, cross, verdict, input);
    return json(res, 200, { ok: true, model: "内置演示模型", degraded: true, format: "engine", demo: true,
      engine: { context: "内置演示：辞职备考场景", models: results, cross, verdict, narration: narr },
      rounds: [{ round: 1, trigger: "未配置 API Key：使用内置演示模型（同一套蒙特卡洛运行时）", note: "配置 Key 后由 LLM 针对你的输入编译定量 SCM" }] });
  }

  /* 编译（含修正回路） */
  for(let round = 1; round <= 3; round++){
    const issuesTxt = round === 1 ? "" : ("\n上一轮问题：\n" + spec.__issues.join("\n"));
    const userMsg = "目标：把以下事件编译为 2-3 个带结构方程的定量 SCM 候选模型。\n背景输入：" + input + "\n" + (round === 1 ? "" : "\n上一轮被运行时拒绝的模型规格：\n" + JSON.stringify(spec.__prev) + issuesTxt + "\n\n请修复后重新输出完整 JSON。");
    const content = await callLLM(cfg, userMsg, 3000, 0.4, ENGINE_PROMPT);
    let parsed;
    try{ parsed = extractJSON(content); }
    catch(e){
      rounds.push({ round, trigger: "Schema 解析失败", note: String(e.message || e).slice(0, 100) });
      spec = { __issues: ["输出必须是单个合法 JSON 对象：" + e.message], __prev: null };
      continue;
    }
    const errs = [];
    if(!parsed || !Array.isArray(parsed.models) || parsed.models.length < 2) errs.push("models 至少 2 个候选");
    (parsed.models || []).forEach(m => engineModelErrors(m).forEach(e => errs.push(m.model_id + ": " + e)));
    if(errs.length){
      rounds.push({ round, trigger: "模型规格校验失败（" + errs.length + " 项）", note: errs[0] });
      spec = { __issues: errs, __prev: parsed };
      continue;
    }
    spec = parsed;
    rounds.push({ round, trigger: "编译通过运行时校验", note: parsed.models.length + " 个候选模型进入蒙特卡洛计算" });
    break;
  }
  if(!spec || !spec.models){
    return json(res, 200, { ok: true, model: cfg.model, degraded: true, format: "engine", refused: true,
      message: "修正回路耗尽（3 轮）仍编译失败，按 Final Rule 拒绝输出。", rounds });
  }

  /* 计算器 + 沙盘 */
  const results = spec.models.map(m => computeModel(m, input));
  const cross = crossModel(results);
  const verdict = engineVerdict(results, cross);

  /* 转述（数字核验） */
  let narration;
  try{
    const facts = numberFacts(results, cross, verdict);
    const narrRaw = await callLLM(cfg, "运行时计算结果：\n" + JSON.stringify({ results, cross, verdict }) + "\n\n可引用的数字清单（只允许引用这些）：\n" + facts.join("、") + "\n\n请转述。", 1200, 0.5, NARRATE_PROMPT);
    let narr = extractJSON(narrRaw);
    const bad = checkNarrationNumbers(narr, facts);
    if(bad.length){
      narrRaw.__retry = true;
      const retry = await callLLM(cfg, "你上一轮转述引用了结果中不存在的数字：" + bad.join("、") + "\n请重新转述，只引用允许清单中的数字。\n\n运行时计算结果：\n" + JSON.stringify({ results, cross, verdict }), 1200, 0.3, NARRATE_PROMPT);
      narr = extractJSON(retry);
      const bad2 = checkNarrationNumbers(narr, facts);
      if(bad2.length) throw new Error("数字核验未通过：" + bad2.join("、"));
    }
    narration = narr;
  }catch(e){
    narration = templateNarration(results, cross, verdict, input);
    narration.fallback_note = "LLM 转述未通过数字核验，已回退为运行时模板转述（" + String(e.message || e).slice(0, 80) + "）";
  }

  return json(res, 200, { ok: true, model: cfg.model, degraded: true, format: "engine", demo: false,
    engine: { context: spec.context, models: results, cross, verdict, narration }, rounds });
}

function numberFacts(results, cross, verdict){
  const set = new Set();
  numberSet({ results, cross, verdict }, set);
  set.add(1500); set.add(3000); set.add(200); set.add(800); set.add(12); set.add(1); set.add(0); set.add(2); set.add(3);
  return [...set].map(v => String(v));
}
function checkNarrationNumbers(narr, facts){
  const allowed = new Set(facts.map(Number));
  const bad = [];
  const texts = [];
  (narr.models || []).forEach(m => texts.push(m.reading || ""));
  texts.push(narr.overall || "", narr.uncertainty || "");
  texts.forEach(t => {
    (String(t).match(/-?\d+(\.\d+)?/g) || []).forEach(tok => {
      const x = Number(tok);
      const ok = [...allowed].some(a => Math.abs(a - x) < 0.006 || Math.abs(a - x * 100) < 0.6 || Math.abs(a * 100 - x) < 0.6);
      if(!ok) bad.push(tok);
    });
  });
  return [...new Set(bad)];
}
function crossModel(results){
  const ok = results.filter(r => !r.errors && r.ate);
  const ates = ok.map(r => r.ate.value);
  const spread = ates.length ? r3(Math.max(...ates) - Math.min(...ates)) : null;
  const sameSign = ates.every(a => a >= 0) || ates.every(a => a <= 0);
  return { ate_values: ates, spread, same_sign: sameSign, converged: sameSign && spread != null && spread < 0.1 };
}
function engineVerdict(results, cross){
  const allRef = results.filter(r => !r.errors);
  const refPass = allRef.every(r => Object.values(r.refuters || {}).every(x => x.pass));
  const identOK = allRef.every(r => (r.identification || {}).identified);
  let grade, reason;
  if(!identOK){ grade = "C"; reason = "存在不可观测混杂导致的不可识别结构，因果解释受限"; }
  else if(!refPass){ grade = "C"; reason = "反驳检验未全部通过，效应不稳健"; }
  else if(cross.converged){ grade = "A"; reason = "跨模型 ATE 同号且极差 " + cross.spread + "，反驳检验全部通过，后门全部阻断"; }
  else { grade = "B"; reason = "反驳检验通过，但候选模型间 ATE 极差 " + cross.spread + "（结构假设分歧）"; }
  return { grade, reason, basis: "量化依据：候选模型 " + results.length + " 个；ATE 极差 " + cross.spread + "；同号 " + cross.same_sign + "；反驳检验 " + (refPass ? "全部通过" : "存在失败") + "；可识别 " + (identOK ? "是" : "否") };
}
function templateNarration(results, cross, verdict, input){
  return {
    models: results.filter(r => !r.errors).map(r => ({
      model_id: r.model_id,
      reading: "运行时计算 " + r.exposure + "→" + r.outcome + " 的因果效应 ATE = " + r.ate.value + "（95% CI [" + r.ate.ci[0] + ", " + r.ate.ci[1] + "]）；观测对比 " + (r.observational.contrast == null ? "不可估" : r.observational.contrast) + "，混杂偏差 " + (r.observational.bias == null ? "—" : r.observational.bias) + "；后门调整估计 " + (r.adjustment_estimate.value == null ? "不可识别" : r.adjustment_estimate.value) + "。"
    })),
    overall: verdict.grade + " 级：" + verdict.reason,
    uncertainty: "全部数值来自蒙特卡洛模拟（每臂 1500 智能体），无实证数据拟合，标注为非因果假设。"
  };
}

/* ============ API 处理器 ============ */

async function handleInfer(req, res){
  try{
    const body = JSON.parse((await readBody(req)) || "{}");
    const cfg = resolveCfg(body);
    const fmt = body.format === "protocol" ? "protocol" : body.format === "engine" ? "engine" : "classic";

    if(!cfg.apiKey && fmt !== "engine"){
      return json(res, 400, { error: "no_api_key", message: "未配置 API Key：请在页面「⚙ API 设置」中填写，或设置环境变量 LLM_API_KEY（计算引擎版支持无 Key 的内置演示模型）" });
    }
    const input = String(body.input || "").trim().slice(0, 4000);
    if(!input) return json(res, 400, { error: "empty_input", message: "输入为空" });

    if(fmt === "engine") return runEngine(cfg, input, res);
    if(fmt === "classic"){
      const out = await orchestrateClassic(cfg, input);
      return json(res, 200, { ok: true, model: cfg.model, degraded: true, ...out });
    }

    const out = await orchestrate(cfg, input);
    return json(res, 200, { ok: true, model: cfg.model, degraded: true, format: "protocol", ...out });
  }catch(e){
    return json(res, 502, { error: "llm_failed", message: String(e && e.message || e) });
  }
}

async function handleTest(req, res){
  try{
    const body = JSON.parse((await readBody(req)) || "{}");
    const cfg = resolveCfg(body);
    if(!cfg.apiKey) return json(res, 400, { ok: false, message: "未填写 API Key" });
    const content = await callLLM(cfg, "只回复两个字：正常", 20, 0);
    return json(res, 200, { ok: true, message: "连接正常 · 模型 " + cfg.model + " · 回复：" + String(content).slice(0, 20) });
  }catch(e){
    return json(res, 502, { ok: false, message: String(e && e.message || e) });
  }
}

/* ============ 启动 ============ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if(req.method === "POST" && url.pathname === "/api/infer") return handleInfer(req, res);
  if(req.method === "POST" && url.pathname === "/api/test")  return handleTest(req, res);
  if(req.method === "GET")   return serveStatic(url.pathname, res);
  res.writeHead(405); res.end("Method Not Allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("SCLM 协议引擎 running at http://127.0.0.1:" + PORT);
  console.log("架构：LLM=编译器（第1-4层） | 本文件=SCM结构运行时（校验/后门枚举/d-分离/定级/修正回路，最多 " + MAX_ROUNDS + " 轮）");
});
