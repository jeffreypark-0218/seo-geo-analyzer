/* SEO/GEO 사이트 전체 분석 서버
 * 실행: npm install && npm start → http://localhost:3000
 * Node.js 18 이상 필요 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { analyze } = require("./analyzer");

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
  const ignoreQuery = query.get("ignoreQuery") !== "0";
  const t0 = Date.now();

  // 1. robots.txt / llms.txt
  let robots = null, llms = null;
  try { const r = await fetchText(start.origin + "/robots.txt"); robots = r.ok ? await r.text() : ""; } catch (e) { robots = null; }
  try { const r = await fetchText(start.origin + "/llms.txt"); llms = r.ok ? await r.text() : ""; } catch (e) { llms = null; }
  if (llms && /<html/i.test(llms.slice(0, 300))) llms = ""; // 404 페이지 오탐 방지
  const disallow = parseDisallow(robots);
  const extras = { robots, llms };

  // 2. 사이트맵 URL 수집
  const sitemapSeeds = [];
  const smSeen = new Set();
  const declared = robots ? [...robots.matchAll(/sitemap:\s*(\S+)/gi)].map(m => m[1]) : [];
  if (!declared.length) declared.push(start.origin + "/sitemap.xml");
  for (const sm of declared) await collectSitemapUrls(sm, 0, sitemapSeeds, smSeen);
  send("init", { robots: robots !== null && robots !== "", sitemapUrls: sitemapSeeds.length });

  // 3. 크롤 큐
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
  const pages = [];

  async function worker() {
    while (!aborted) {
      const url = queue.shift();
      if (url === undefined) return;
      try {
        const r = await fetchText(url);
        const ct = r.headers.get("content-type") || "";
        if (!r.ok) { failed++; send("pageError", { url, error: "HTTP " + r.status }); continue; }
        if (!ct.includes("text/html")) continue;
        const html = await r.text();
        const result = analyze(html, r.url || url, extras);
        analyzed++;
        result.internalUrls.forEach(enqueue);
        pages.push({ url: result.url, title: result.title, scores: result.scores });
        send("page", {
          url: result.url, title: result.title, scores: result.scores, checks: result.checks,
          analyzed, discovered: visited.size, queued: queue.length
        });
      } catch (e) {
        failed++;
        send("pageError", { url, error: e.name === "TimeoutError" ? "시간 초과" : e.message });
      }
    }
  }

  // 큐가 비어도 진행 중인 워커가 링크를 추가할 수 있으므로 라운드 반복
  while (!aborted && queue.length) {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  send("done", { analyzed, failed, discovered: visited.size, elapsedSec: Math.round((Date.now() - t0) / 1000) });
  res.end();
}

/* 정적 파일 + 라우팅 */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/crawl") return handleCrawl(req, res, u.searchParams);
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
