/* SEO/GEO 사이트 전체 분석 서버
 * 실행: npm install && npm start → http://localhost:3000
 * Node.js 18 이상 필요 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { analyze, scoreKeyword } = require("./analyzer");

const PORT = process.env.PORT || 3000;
const CONCURRENCY = 5;
const FETCH_TIMEOUT = 15000;
const UA = "Mozilla/5.0 (compatible; SEO-GEO-Analyzer/1.0)";

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|zip|gz|rar|7z|mp3|mp4|webm|avi|mov|woff2?|ttf|eot|otf|doc|docx|xls|xlsx|ppt|pptx|exe|dmg|apk)(\?|#|$)/i;

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml,text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  });
  return r;
}

function normalizeUrl(raw, ignoreQuery) {
  const u = new URL(raw);
  u.hash = "";
  if (ignoreQuery) u.search = "";
  let href = u.href;
  if (u.pathname !== "/" && href.endsWith("/")) href = href.slice(0, -1);
  return href;
}

function sameSite(a, b) {
  const ha = new URL(a).hostname.replace(/^www\./, "");
  const hb = new URL(b).hostname.replace(/^www\./, "");
  return ha === hb;
}

/* robots.txt의 User-agent: * Disallow 규칙 파싱 */
function parseDisallow(robots) {
  if (!robots) return [];
  const rules = [];
  let applies = false;
  for (const line of robots.split(/\r?\n/)) {
    const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === "user-agent") applies = m[2].trim() === "*";
    else if (applies && m[2].trim()) rules.push(m[2].trim());
  }
  return rules;
}
function isDisallowed(url, rules) {
  const p = new URL(url).pathname;
  return rules.some(r => p.startsWith(r.replace(/\*$/, "")));
}

/* 사이트맵에서 URL 수집 (sitemapindex 재귀) */
async function collectSitemapUrls(sitemapUrl, depth, acc, seen) {
  if (depth > 3 || seen.has(sitemapUrl) || acc.length >= 50000) return;
  seen.add(sitemapUrl);
  try {
    const r = await fetchText(sitemapUrl);
    if (!r.ok) return;
    const xml = await r.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].trim());
    if (/<sitemapindex/i.test(xml)) {
      for (const loc of locs) await collectSitemapUrls(loc, depth + 1, acc, seen);
    } else {
      acc.push(...locs);
    }
  } catch (e) { /* sitemap 접근 실패는 무시 */ }
}

/* ===== 공용 크롤 엔진 ===== */
async function crawlSite(start, ignoreQuery, isAborted, onEvent, keepResults) {
  const t0 = Date.now();
  let robots = null, llms = null;
  try { const r = await fetchText(start.origin + "/robots.txt"); robots = r.ok ? await r.text() : ""; } catch (e) { robots = null; }
  try { const r = await fetchText(start.origin + "/llms.txt"); llms = r.ok ? await r.text() : ""; } catch (e) { llms = null; }
  if (llms && /<html/i.test(llms.slice(0, 300))) llms = "";
  const disallow = parseDisallow(robots);
  const extras = { robots, llms };

  const sitemapSeeds = [];
  const smSeen = new Set();
  const declared = robots ? [...robots.matchAll(/sitemap:\s*(\S+)/gi)].map(m => m[1]) : [];
  if (!declared.length) declared.push(start.origin + "/sitemap.xml");
  for (const sm of declared) await collectSitemapUrls(sm, 0, sitemapSeeds, smSeen);
  onEvent("init", { robots: robots !== null && robots !== "", sitemapUrls: sitemapSeeds.length });

  const visited = new Set();
  const queue = [];
  const enqueue = raw => {
    try {
      const n = normalizeUrl(raw, ignoreQuery);
      if (visited.has(n) || !sameSite(n, start.href) || SKIP_EXT.test(n)) return;
      if (isDisallowed(n, disallow)) return;
      visited.add(n);
      queue.push(n);
    } catch (e) { /* skip invalid */ }
  };
  enqueue(start.href);
  sitemapSeeds.forEach(enqueue);

  let analyzed = 0, failed = 0;
  const results = [];

  async function worker() {
    while (!isAborted()) {
      const url = queue.shift();
      if (url === undefined) return;
      try {
        const r = await fetchText(url);
        const ct = r.headers.get("content-type") || "";
        if (!r.ok) { failed++; onEvent("pageError", { url, error: "HTTP " + r.status }); continue; }
        if (!ct.includes("text/html")) continue;
        const html = await r.text();
        const result = analyze(html, r.url || url, extras);
        analyzed++;
        result.internalUrls.forEach(enqueue);
        if (keepResults) results.push(result);
        onEvent("page", {
          url: result.url, title: result.title, scores: result.scores, checks: keepResults ? undefined : result.checks,
          analyzed, discovered: visited.size, queued: queue.length
        });
      } catch (e) {
        failed++;
        onEvent("pageError", { url, error: e.name === "TimeoutError" ? "시간 초과" : e.message });
      }
    }
  }

  while (!isAborted() && queue.length) {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  return { analyzed, failed, discovered: visited.size, elapsedSec: Math.round((Date.now() - t0) / 1000), results, extras, disallow };
}

/* ===== 검색 실측 (네이버/구글) ===== */
function hostMatch(link, host) {
  try {
    const h = new URL(link).hostname.replace(/^www\./, "");
    return h === host || h.endsWith("." + host);
  } catch (e) { return false; }
}

async function naverRank(kw, host, id, secret, postUrl) {
  try {
    const r = await fetch("https://openapi.naver.com/v1/search/webkr.json?display=30&query=" + encodeURIComponent(kw), {
      headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return { error: "네이버 API 오류 (HTTP " + r.status + ") — 키 확인 필요" };
    const j = await r.json();
    const items = j.items || [];
    const idx = items.findIndex(it => hostMatch(it.link, host));
    const pIdx = postUrl ? items.findIndex(it => samePost(it.link, postUrl)) : -1;
    return { rank: idx === -1 ? null : idx + 1, postRank: pIdx === -1 ? null : pIdx + 1, checked: items.length, top: items.slice(0, 3).map(it => ({ title: (it.title || "").replace(/<[^>]+>/g, ""), link: it.link })) };
  } catch (e) { return { error: "네이버 API 호출 실패: " + e.message }; }
}

async function googleRank(kw, host, key, cx, postUrl) {
  try {
    const r = await fetch("https://www.googleapis.com/customsearch/v1?key=" + encodeURIComponent(key) + "&cx=" + encodeURIComponent(cx) + "&num=10&q=" + encodeURIComponent(kw), {
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return { error: "구글 API 오류 (HTTP " + r.status + ") — 키/CX 확인 필요" };
    const j = await r.json();
    const items = j.items || [];
    const idx = items.findIndex(it => hostMatch(it.link, host));
    const pIdx = postUrl ? items.findIndex(it => samePost(it.link, postUrl)) : -1;
    return { rank: idx === -1 ? null : idx + 1, postRank: pIdx === -1 ? null : pIdx + 1, checked: items.length, top: items.slice(0, 3).map(it => ({ title: it.title, link: it.link })) };
  } catch (e) { return { error: "구글 API 호출 실패: " + e.message }; }
}

/* 글 단위 URL 일치 (경로 기준, 네이버 블로그는 logNo 기준) */
function samePost(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    const ha = ua.hostname.replace(/^(www|m)\./, ""), hb = ub.hostname.replace(/^(www|m)\./, "");
    if (ha.includes("blog.naver.com") && hb.includes("blog.naver.com")) {
      const la = (a.match(/(\d{9,})/) || [])[1], lb = (b.match(/(\d{9,})/) || [])[1];
      return !!la && la === lb;
    }
    const pa = ua.pathname.replace(/\/$/, ""), pb = ub.pathname.replace(/\/$/, "");
    return ha === hb && pa === pb;
  } catch (e) { return false; }
}

/* 네이버 블로그 iframe 구조 → 실제 본문(PostView) URL 변환 */
function convertNaverBlog(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^m\./, "");
    if (host !== "blog.naver.com") return { fetchUrl: raw, isNaverBlog: false };
    if (/PostView/i.test(u.pathname)) return { fetchUrl: raw, isNaverBlog: true };
    const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
    if (m) return { fetchUrl: `https://blog.naver.com/PostView.naver?blogId=${m[1]}&logNo=${m[2]}`, isNaverBlog: true };
    return { fetchUrl: raw, isNaverBlog: true };
  } catch (e) { return { fetchUrl: raw, isNaverBlog: false }; }
}

function computeAiBlocked(robots) {
  const AI_BOTS = ["gptbot", "oai-searchbot", "chatgpt-user", "perplexitybot", "claudebot", "google-extended", "ccbot"];
  const blocked = [];
  if (robots) {
    const blocks = robots.toLowerCase().split(/(?=user-agent:)/);
    for (const b of blocks) {
      const ua = (b.match(/user-agent:\s*(\S+)/) || [])[1] || "";
      if (AI_BOTS.some(bot => ua.includes(bot)) && /disallow:\s*\/\s*$/m.test(b)) blocked.push(ua);
    }
  }
  return blocked;
}

/* ===== 블로그 글 1개 키워드 분석 ===== */
async function handleKeywordSingle(req, res, query) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let input = (query.get("url") || "").trim();
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;
  let target;
  try { target = new URL(input); } catch (e) { return json(400, { error: "올바른 URL 형식이 아닙니다." }); }
  const keywords = (query.get("keywords") || "").split(",").map(t => t.trim()).filter(Boolean).slice(0, 10);
  if (!keywords.length) return json(400, { error: "키워드를 1개 이상 입력하세요." });
  const nid = query.get("nid") || "", nsec = query.get("nsec") || "";
  const gkey = query.get("gkey") || "", gcx = query.get("gcx") || "";

  const conv = convertNaverBlog(input);
  let robots = null, llms = null;
  const origin = new URL(conv.fetchUrl).origin;
  try { const r = await fetchText(origin + "/robots.txt"); robots = r.ok ? await r.text() : ""; } catch (e) { robots = null; }
  try { const r = await fetchText(origin + "/llms.txt"); llms = r.ok ? await r.text() : ""; } catch (e) { llms = null; }
  if (llms && /<html/i.test(llms.slice(0, 300))) llms = "";

  let html;
  try {
    const r = await fetchText(conv.fetchUrl);
    if (!r.ok) return json(502, { error: "글을 가져오지 못했습니다 (HTTP " + r.status + ")" });
    html = await r.text();
  } catch (e) {
    return json(502, { error: "글을 가져오지 못했습니다: " + (e.name === "TimeoutError" ? "시간 초과" : e.message) });
  }

  const result = analyze(html, input, { robots, llms });
  const kwExtras = { robots, aiBlocked: computeAiBlocked(robots) };
  const host = target.hostname.replace(/^(www|m)\./, "");

  const results = [];
  for (const kw of keywords) {
    const scored = scoreKeyword(result, kw, kwExtras);
    const [naver, google] = await Promise.all([
      nid && nsec ? naverRank(kw, host, nid, nsec, input) : Promise.resolve(null),
      gkey && gcx ? googleRank(kw, host, gkey, gcx, input) : Promise.resolve(null)
    ]);
    results.push({ keyword: kw, scores: scored.scores, checks: scored.checks, naver, google });
  }

  json(200, { page: { url: input, title: result.title }, isNaverBlog: conv.isNaverBlog, results });
}

/* ===== 키워드 분석 핸들러 ===== */
async function handleKeywordAnalyze(req, res, query) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  let aborted = false;
  req.on("close", () => { aborted = true; });

  let start;
  try {
    let input = (query.get("url") || "").trim();
    if (!/^https?:\/\//i.test(input)) input = "https://" + input;
    start = new URL(input);
  } catch (e) {
    send("fatal", { message: "올바른 URL 형식이 아닙니다." });
    return res.end();
  }
  const keywords = (query.get("keywords") || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 10);
  if (!keywords.length) {
    send("fatal", { message: "키워드를 1개 이상 입력하세요." });
    return res.end();
  }
  const nid = query.get("nid") || "", nsec = query.get("nsec") || "";
  const gkey = query.get("gkey") || "", gcx = query.get("gcx") || "";
  const host = start.hostname.replace(/^www\./, "");

  const crawl = await crawlSite(start, query.get("ignoreQuery") !== "0", () => aborted, send, true);
  if (aborted) return res.end();

  // AI 크롤러 차단 정보 (사이트 단위)
  const AI_BOTS = ["gptbot", "oai-searchbot", "chatgpt-user", "perplexitybot", "claudebot", "google-extended", "ccbot"];
  const aiBlocked = [];
  if (crawl.extras.robots) {
    const blocks = crawl.extras.robots.toLowerCase().split(/(?=user-agent:)/);
    for (const b of blocks) {
      const ua = (b.match(/user-agent:\s*(\S+)/) || [])[1] || "";
      if (AI_BOTS.some(bot => ua.includes(bot)) && /disallow:\s*\/\s*$/m.test(b)) aiBlocked.push(ua);
    }
  }
  const kwExtras = { robots: crawl.extras.robots, aiBlocked };

  for (const kw of keywords) {
    if (aborted) break;
    send("keywordStart", { keyword: kw });

    const scored = crawl.results.map(r => scoreKeyword(r, kw, kwExtras))
      .sort((a, b) => b.scores.total - a.scores.total || b.scores.relevance - a.scores.relevance);
    const top = scored.slice(0, 5);
    const best = top[0] || null;
    const coverage = scored.filter(s => s.scores.relevance >= 40).length;

    const [naver, google] = await Promise.all([
      nid && nsec ? naverRank(kw, host, nid, nsec) : Promise.resolve(null),
      gkey && gcx ? googleRank(kw, host, gkey, gcx) : Promise.resolve(null)
    ]);

    send("keywordResult", {
      keyword: kw,
      best: best ? { url: best.url, title: best.title, scores: best.scores, checks: best.checks } : null,
      top: top.map(t => ({ url: t.url, title: t.title, scores: t.scores })),
      coverage,
      totalPages: crawl.results.length,
      naver, google
    });
  }

  send("done", { analyzed: crawl.analyzed, elapsedSec: crawl.elapsedSec });
  res.end();
}

/* SSE 크롤 핸들러 */
async function handleCrawl(req, res, query) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  let aborted = false;
  req.on("close", () => { aborted = true; });

  let start;
  try {
    let input = (query.get("url") || "").trim();
    if (!/^https?:\/\//i.test(input)) input = "https://" + input;
    start = new URL(input);
  } catch (e) {
    send("fatal", { message: "올바른 URL 형식이 아닙니다." });
    return res.end();
  }
  const crawl = await crawlSite(start, query.get("ignoreQuery") !== "0", () => aborted, send, false);
  if (aborted) return res.end();
  send("done", { analyzed: crawl.analyzed, failed: crawl.failed, discovered: crawl.discovered, elapsedSec: crawl.elapsedSec });
  res.end();
}

/* 정적 파일 + 라우팅 */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/crawl") return handleCrawl(req, res, u.searchParams);
  if (u.pathname === "/api/keyword-analyze") return handleKeywordAnalyze(req, res, u.searchParams);
  if (u.pathname === "/api/keyword-single") return handleKeywordSingle(req, res, u.searchParams);
  if (u.pathname === "/" || u.pathname === "/index.html") {
    const f = fs.existsSync(path.join(__dirname, "index.html"))
      ? path.join(__dirname, "index.html")
      : path.join(__dirname, "public", "index.html");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(f).pipe(res);
  }
  res.writeHead(404); res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`SEO/GEO 분석 서버 실행 중: http://localhost:${PORT}`);
});
