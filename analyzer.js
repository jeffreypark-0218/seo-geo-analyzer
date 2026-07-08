/* SEO/GEO 페이지 분석 로직 (jsdom 기반)
 * 채점 근거: Aggarwal et al. GEO(arXiv 2311.09735) · OtterlyAI GEO Guide ·
 * Context Institute SSRN 6546718 · 구글 검색 센터 · 네이버 서치어드바이저/C-Rank/D.I.A */
"use strict";
const { JSDOM } = require("jsdom");

const AXES = {
  google: { name: "구글 SEO", desc: "Google 검색 센터 기준", color: "#4285f4" },
  naver:  { name: "네이버 SEO", desc: "서치어드바이저·C-Rank·D.I.A", color: "#03c75a" },
  geo:    { name: "AI 검색 (GEO)", desc: "ChatGPT·AI Overview 인용 최적화", color: "#7c3aed" },
  tech:   { name: "기술 기반", desc: "크롤링·렌더링·모바일", color: "#f59e0b" }
};
const VAL = { pass: 1, warn: 0.5, fail: 0 };

function scoreAxis(checks, axis) {
  const list = checks.filter(c => c.axis === axis && c.status !== "info");
  const max = list.reduce((s, c) => s + c.weight, 0);
  const got = list.reduce((s, c) => s + c.weight * VAL[c.status], 0);
  return max ? Math.round(got / max * 100) : 0;
}

function parseJsonLd(doc, rawOut) {
  const types = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    if (rawOut) rawOut.push(s.textContent || "");
    try {
      const collect = o => {
        if (!o) return;
        if (Array.isArray(o)) return o.forEach(collect);
        if (typeof o === "object") {
          if (o["@type"]) types.push(...[].concat(o["@type"]));
          if (o["@graph"]) collect(o["@graph"]);
        }
      };
      collect(JSON.parse(s.textContent));
    } catch (e) { /* invalid json-ld ignored */ }
  });
  return types;
}

function bodyText(doc) {
  const clone = doc.body ? doc.body.cloneNode(true) : doc.createElement("body");
  clone.querySelectorAll("script,style,noscript,svg").forEach(n => n.remove());
  return (clone.textContent || "").replace(/\s+/g, " ").trim();
}

function analyze(rawHtml, url, extras) {
  const doc = new JSDOM(rawHtml).window.document;
  const u = new URL(url);
  const meta = name => { const el = doc.querySelector('meta[name="' + name + '"]'); return el ? (el.getAttribute("content") || "").trim() : ""; };
  const prop = p => { const el = doc.querySelector('meta[property="' + p + '"]'); return el ? (el.getAttribute("content") || "").trim() : ""; };

  const title = (doc.querySelector("title") ? doc.querySelector("title").textContent : "").trim();
  const desc = meta("description");
  const robotsMeta = meta("robots").toLowerCase();
  const canonical = doc.querySelector('link[rel="canonical"]');
  const h1s = doc.querySelectorAll("h1");
  const headings = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const imgs = [...doc.querySelectorAll("img")];
  const imgsAlt = imgs.filter(i => (i.getAttribute("alt") || "").trim().length > 0);
  const links = [...doc.querySelectorAll("a[href]")];
  const internal = links.filter(a => { try { return new URL(a.getAttribute("href"), url).hostname === u.hostname; } catch (e) { return false; } });
  const external = links.filter(a => { try { const h = new URL(a.getAttribute("href"), url); return h.protocol.startsWith("http") && h.hostname !== u.hostname; } catch (e) { return false; } });
  const ldRawArr = [];
  const ldTypes = parseJsonLd(doc, ldRawArr);
  const text = bodyText(doc);
  const textLen = text.length;
  const ogT = prop("og:title"), ogD = prop("og:description"), ogI = prop("og:image");
  const naverVerify = meta("naver-site-verification");
  const pubTime = prop("article:published_time") || (rawHtml.match(/"datePublished"\s*:\s*"([^"]+)"/) || [])[1] || "";
  const modTime = prop("article:modified_time") || (rawHtml.match(/"dateModified"\s*:\s*"([^"]+)"/) || [])[1] || "";
  const author = meta("author") || (rawHtml.match(/"author"\s*:/) ? "schema" : "") || (doc.querySelector('[rel="author"], .author, .byline') ? "markup" : "");
  const lists = doc.querySelectorAll("ul,ol").length;
  const tables = doc.querySelectorAll("table").length;
  const semantic = ["main", "article", "section", "header", "footer", "nav"].filter(t => doc.querySelector(t));
  const questionHeads = headings.filter(h => /\?|무엇|어떻게|왜|방법|언제|어디|이유|what|how|why|when/i.test(h.textContent)).length;
  const statCount = (text.match(/\d+(\.\d+)?\s*(%|퍼센트|억|만|천|배|년|개|명|원|kg|km|시간|분)/g) || []).length;
  const paras = [...doc.querySelectorAll("p")].filter(p => (p.textContent || "").trim().length > 40);
  const firstPara = paras.length ? paras[0].textContent.trim() : "";
  let firstParaPos = 1;
  if (paras.length && doc.body) {
    const idx = rawHtml.indexOf(firstPara.slice(0, 60));
    if (idx > -1) firstParaPos = idx / rawHtml.length;
  }
  const headScripts = [...doc.querySelectorAll("head script[src]")].filter(s => !s.hasAttribute("async") && !s.hasAttribute("defer")).length;
  const lazyImgs = imgs.filter(i => i.getAttribute("loading") === "lazy").length;
  const deprecated = doc.querySelectorAll("font,center,marquee,blink").length;
  const favicon = doc.querySelector('link[rel*="icon"]');
  const htmlKB = Math.round(rawHtml.length / 1024);
  const hasSchemaOf = (...names) => names.some(n => ldTypes.some(t => String(t).toLowerCase() === n.toLowerCase()));

  let hierarchyOk = true, prev = 0;
  for (const h of headings) {
    const lv = +h.tagName[1];
    if (prev && lv > prev + 1) { hierarchyOk = false; break; }
    prev = lv;
  }

  const titleWords = title.replace(/[^\w가-힣\s]/g, " ").split(/\s+/).filter(w => w.length >= 2).slice(0, 6);
  const matchedWords = titleWords.filter(w => text.includes(w));
  const consistency = titleWords.length ? matchedWords.length / titleWords.length : 0;

  /* GEO 논문 기반 지표 계산 */
  const quotations = doc.querySelectorAll("blockquote,q,cite").length + ((text.match(/[“”"']{1}[^“”"']{15,}[“”"']{1}/g) || []).length > 2 ? 1 : 0);
  const sentences = text.split(/[.!?。]\s|[.!?。]$|다\.\s/).filter(s => s.trim().length > 5);
  const avgSentLen = sentences.length ? Math.round(textLen / sentences.length) : 0;
  const words = text.toLowerCase().replace(/[^\w가-힣\s]/g, " ").split(/\s+/).filter(w => w.length >= 2);
  const freq = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);
  const topFreq = words.length > 50 ? Math.max(...Object.values(freq)) / words.length : 0;
  const allScripts = doc.querySelectorAll("script").length;
  const h23 = doc.querySelectorAll("h2,h3").length;
  const paraLens = paras.map(p => p.textContent.trim().length);
  const atomicParas = paraLens.filter(l => l >= 80 && l <= 600).length;
  const atomicRatio = paraLens.length ? atomicParas / paraLens.length : 0;

  /* FAQ 콘텐츠(질문-답변 형식) 감지 휴리스틱 — 스키마 코드 유무와 별개 */
  let faqPairs = 0;
  for (const h of doc.querySelectorAll("h2,h3,h4")) {
    const ht = (h.textContent || "").trim();
    if (!/\?$|나요\??$|인가요\??$|까요\??$|을까\??$|할까\??$|무엇|어떻게|어떤|왜/.test(ht)) continue;
    let sib = h.nextElementSibling, hop = 0;
    while (sib && hop < 3) {
      if (/^H[1-6]$/.test(sib.tagName)) break;
      if (/^(P|DIV|UL|OL|DL)$/.test(sib.tagName) && (sib.textContent || "").trim().length > 20) { faqPairs++; break; }
      sib = sib.nextElementSibling; hop++;
    }
  }
  const qMarkers = (text.match(/Q\d*\s*[.)]|질문\s*[:：]/g) || []).length;
  const hasFaqContent = faqPairs >= 2 || qMarkers >= 2;

  /* 제목-H1 중복 여부 (C-1) */
  const h1Text = h1s.length ? (h1s[0].textContent || "").trim() : "";
  const normTxt = s => (s || "").replace(/[^\w가-힣]/g, "").toLowerCase();
  const tN = normTxt(title), h1N = normTxt(h1Text);
  const titleH1Same = !!tN && !!h1N && (tN === h1N || (tN.includes(h1N) && h1N.length >= 8) || (h1N.includes(tN) && tN.length >= 8));

  // robots.txt에서 AI 크롤러 차단 여부 (OtterlyAI 가이드)
  const AI_BOTS = ["gptbot", "oai-searchbot", "chatgpt-user", "perplexitybot", "claudebot", "google-extended", "ccbot", "bingbot"];
  const blockedBots = [];
  if (extras.robots) {
    const blocks = extras.robots.toLowerCase().split(/(?=user-agent:)/);
    for (const b of blocks) {
      const ua = (b.match(/user-agent:\s*(\S+)/) || [])[1] || "";
      if (AI_BOTS.some(bot => ua.includes(bot)) && /disallow:\s*\/\s*$/m.test(b)) blockedBots.push(ua);
    }
  }

  const C = [];
  const add = (axis, label, weight, status, detail, advice, src) => C.push({ axis, label, weight, status, detail, advice: status === "pass" ? "" : advice, src: src || "" });

  /* ===== 구글 SEO ===== */
  add("google", "타이틀 태그", 3,
    !title ? "fail" : (title.length >= 20 && title.length <= 60 ? "pass" : "warn"),
    title ? `"${title.slice(0, 70)}" (${title.length}자)` : "타이틀 태그가 없습니다",
    !title ? "<title> 태그를 추가하세요. 핵심 키워드를 앞쪽에 배치한 20~60자 제목이 이상적입니다."
           : "구글 검색결과에 잘리지 않도록 20~60자 사이로 조정하고 핵심 키워드를 앞에 배치하세요.");
  add("google", "메타 디스크립션", 3,
    !desc ? "fail" : (desc.length >= 70 && desc.length <= 160 ? "pass" : "warn"),
    desc ? `${desc.length}자` : "메타 디스크립션이 없습니다",
    !desc ? '<meta name="description">을 추가하세요. 클릭을 유도하는 70~160자 요약이 CTR을 높입니다.'
          : "70~160자 사이로 조정하세요. 너무 짧으면 정보 부족, 길면 잘려서 표시됩니다.");
  add("google", "H1 헤딩", 2,
    h1s.length === 1 ? "pass" : (h1s.length === 0 ? "fail" : "warn"),
    `H1 태그 ${h1s.length}개`,
    h1s.length === 0 ? "페이지 주제를 나타내는 H1을 1개 추가하세요." : "H1은 페이지당 1개만 사용하고 나머지는 H2~H3으로 변경하세요.");
  add("google", "헤딩 계층 구조", 2,
    headings.length === 0 ? "fail" : (hierarchyOk ? "pass" : "warn"),
    `헤딩 ${headings.length}개, 계층 ${hierarchyOk ? "정상" : "건너뜀 발견"}`,
    headings.length === 0 ? "H1→H2→H3 순서의 헤딩 구조를 만드세요. 검색엔진이 콘텐츠 구조를 파악하는 핵심 신호입니다."
                          : "헤딩 레벨을 건너뛰지 말고 H1→H2→H3 순서로 사용하세요.");
  add("google", "캐노니컬 URL", 2,
    canonical ? "pass" : "warn",
    canonical ? String(canonical.getAttribute("href")) : "canonical 링크 없음",
    '<link rel="canonical">을 설정해 중복 콘텐츠로 인한 순위 분산을 방지하세요.');
  add("google", "이미지 대체 텍스트", 2,
    imgs.length === 0 ? "info" : (imgsAlt.length / imgs.length >= 0.8 ? "pass" : (imgsAlt.length / imgs.length >= 0.4 ? "warn" : "fail")),
    `이미지 ${imgs.length}개 중 ${imgsAlt.length}개에 alt 존재`,
    "모든 의미 있는 이미지에 내용을 설명하는 alt 속성을 추가하세요. 이미지 검색 노출에도 필수입니다.");
  add("google", "색인 허용 (noindex 없음)", 3,
    robotsMeta.includes("noindex") ? "fail" : "pass",
    robotsMeta ? `robots: ${robotsMeta}` : "robots 메타 제한 없음",
    "noindex가 설정되어 있어 구글에 색인되지 않습니다. 의도한 것이 아니라면 제거하세요.");
  add("google", "언어 선언 (lang)", 1,
    doc.documentElement.getAttribute("lang") ? "pass" : "warn",
    "html lang=" + (doc.documentElement.getAttribute("lang") || "없음"),
    '<html lang="ko">처럼 페이지 언어를 선언하세요.');
  add("google", "구조화 데이터 (JSON-LD)", 2,
    ldTypes.length ? "pass" : "fail",
    ldTypes.length ? "스키마 발견: " + [...new Set(ldTypes)].slice(0, 6).join(", ") : "JSON-LD 구조화 데이터 없음",
    "Organization, Article, BreadcrumbList 등 JSON-LD 스키마를 추가하세요. 검색엔진·AI가 페이지 구조를 이해하는 데 도움이 됩니다(FAQ 리치 결과 표시는 구글에서 종료됨). 표시 효과보다 기계 가독성·지식그래프 편입 관점의 가치입니다.");
  add("google", "내부 링크", 1,
    internal.length >= 5 ? "pass" : (internal.length >= 1 ? "warn" : "fail"),
    `내부 링크 ${internal.length}개`,
    "관련 페이지로 연결되는 내부 링크를 늘려 크롤링 경로와 페이지 권위 전달을 개선하세요.");
  add("google", "제목-H1 차별화", 1,
    !h1Text ? "info" : (titleH1Same ? "warn" : "pass"),
    !h1Text ? "H1 없음" : (titleH1Same ? `제목과 H1이 사실상 동일: "${h1Text.slice(0, 40)}"` : "제목과 H1이 서로 다름"),
    "제목과 H1을 완전히 똑같이 쓰면 커버리지가 좁아집니다. H1에는 보조 키워드를 넣어 제목과 다르게 작성하면 노출 폭이 넓어집니다.");
  add("google", "robots.txt / 사이트맵", 2,
    extras.robots === null ? "info" : (extras.robots && /sitemap/i.test(extras.robots) ? "pass" : (extras.robots ? "warn" : "fail")),
    extras.robots === null ? "확인 불가" : (extras.robots ? (/sitemap/i.test(extras.robots) ? "robots.txt 존재, Sitemap 선언됨" : "robots.txt는 있으나 Sitemap 선언 없음") : "robots.txt 없음"),
    "robots.txt를 만들고 그 안에 Sitemap: https://도메인/sitemap.xml 을 선언하세요. 구글·네이버 크롤러 모두 참조합니다.");
  add("google", "콘텐츠 분량", 2,
    textLen >= 1500 ? "pass" : (textLen >= 500 ? "warn" : "fail"),
    `본문 텍스트 약 ${textLen.toLocaleString()}자`,
    "본문이 빈약하면 얇은 콘텐츠(thin content)로 평가됩니다. 주제를 충분히 다루는 1,500자 이상을 권장합니다.");

  /* ===== 네이버 SEO ===== */
  add("naver", "타이틀 길이 (네이버 표시 기준)", 3,
    !title ? "fail" : (title.length <= 35 ? "pass" : "warn"),
    title ? `${title.length}자` : "타이틀 없음",
    "네이버 검색결과는 제목이 짧게 잘려 표시됩니다. 핵심 키워드를 포함해 35자 이내로 앞쪽에 배치하세요.");
  add("naver", "메타 디스크립션", 2,
    desc ? "pass" : "fail",
    desc ? "설정됨" : "없음",
    "네이버는 description을 검색결과에 직접 표시합니다. 페이지 내용을 정확히 반영한 고유 문구를 넣으세요.");
  add("naver", "og:title", 2, ogT ? "pass" : "fail", ogT ? "설정됨" : "없음",
    "네이버는 오픈그래프 태그를 적극 활용합니다. og:title을 추가하세요.");
  add("naver", "og:description", 2, ogD ? "pass" : "fail", ogD ? "설정됨" : "없음",
    "og:description을 추가하세요. 네이버 검색·공유 시 노출 품질이 올라갑니다.");
  add("naver", "og:image", 2, ogI ? "pass" : "fail", ogI ? "설정됨" : "없음",
    "og:image를 추가하세요. 썸네일이 있으면 클릭률이 크게 상승합니다.");
  add("naver", "H1 중복 없음", 2,
    h1s.length <= 1 ? (h1s.length === 1 ? "pass" : "warn") : "fail",
    `H1 ${h1s.length}개`,
    "네이버 서치어드바이저는 H1 중복을 오류로 진단합니다. 페이지당 1개만 사용하세요.");
  add("naver", "서치어드바이저 소유 확인", 2,
    naverVerify ? "pass" : "warn",
    naverVerify ? "naver-site-verification 메타 존재" : "확인 메타 없음",
    "네이버 서치어드바이저(searchadvisor.naver.com)에 사이트를 등록하고 사이트맵·RSS를 제출하세요. 네이버 노출의 첫 단계입니다.");
  add("naver", "콘텐츠 충실성 (D.I.A.)", 3,
    textLen >= 2000 ? "pass" : (textLen >= 800 ? "warn" : "fail"),
    `본문 약 ${textLen.toLocaleString()}자`,
    "네이버 D.I.A.는 정보의 충실성(포괄성)에 가산점을 줍니다. 주제 관련 내용을 빠짐없이 깊게 다루세요.");
  add("naver", "제목-본문 일관성", 2,
    consistency >= 0.7 ? "pass" : (consistency >= 0.4 ? "warn" : "fail"),
    `제목 키워드 ${titleWords.length}개 중 ${matchedWords.length}개가 본문에 등장`,
    "제목의 핵심 키워드가 본문에 자연스럽게 반복되어야 합니다. 제목과 무관한 본문은 C-Rank 신뢰도를 떨어뜨립니다.");
  add("naver", "최신성 신호", 2,
    modTime || pubTime ? "pass" : "warn",
    modTime ? `수정일: ${modTime.slice(0, 10)}` : (pubTime ? `발행일: ${pubTime.slice(0, 10)}` : "발행/수정일 메타 없음"),
    "article:published_time / modified_time 메타 또는 스키마의 datePublished를 추가하세요. 네이버·AI 모두 최신성을 중시합니다.");

  /* ===== AI 검색 (GEO) — 4개 문서 근거 기반 ===== */
  add("geo", "출처 인용 (Cite Sources)", 3,
    external.length >= 3 && external.length <= 15 ? "pass" : (external.length >= 1 ? "warn" : "fail"),
    `외부 출처 링크 ${external.length}개`,
    "신뢰할 수 있는 외부 출처 인용을 추가하세요. GEO 논문에서 가장 효과가 큰 3대 기법 중 하나로, 가시성을 최대 30~40% 높였습니다. 출처는 5~6개 수준이 자연스럽습니다(OtterlyAI).",
    "Aggarwal et al. (GEO) · OtterlyAI");
  add("geo", "통계·수치 포함 (Statistics Addition)", 3,
    statCount >= 5 ? "pass" : (statCount >= 2 ? "warn" : "fail"),
    `수치·통계 표현 약 ${statCount}건`,
    "정성적 서술을 정량적 통계로 바꾸세요. GEO 논문에서 Statistics Addition은 가시성 30~40% 향상으로 최상위 기법이었습니다.",
    "Aggarwal et al. (GEO)");
  add("geo", "인용문 사용 (Quotation Addition)", 2,
    quotations >= 2 ? "pass" : (quotations >= 1 ? "warn" : "fail"),
    `인용 요소(blockquote/q/cite 등) ${quotations}개`,
    "권위 있는 출처의 의미 있는 직접 인용문을 blockquote 등으로 추가하세요. GEO 논문의 3대 최상위 기법 중 하나입니다.",
    "Aggarwal et al. (GEO) · OtterlyAI");
  add("geo", "유창성·가독성 (Fluency / Easy-to-Understand)", 2,
    avgSentLen > 0 && avgSentLen <= 150 ? "pass" : (avgSentLen <= 250 ? "warn" : "fail"),
    `평균 문장 길이 약 ${avgSentLen}자 (문장 ${sentences.length}개)`,
    "문장을 짧고 명확하게 다듬으세요. 유창성 개선과 쉬운 표현만으로도 AI 응답 가시성이 15~30% 상승했습니다.",
    "Aggarwal et al. (GEO)");
  add("geo", "키워드 스터핑 없음", 2,
    topFreq === 0 ? "info" : (topFreq <= 0.05 ? "pass" : (topFreq <= 0.08 ? "warn" : "fail")),
    topFreq ? `최다 반복 단어 비율 ${(topFreq * 100).toFixed(1)}%` : "본문 부족으로 측정 불가",
    "특정 키워드의 과도한 반복을 줄이세요. GEO 논문에서 키워드 스터핑은 AI 검색 가시성에 효과가 없거나 역효과였습니다.",
    "Aggarwal et al. (GEO) · OtterlyAI");
  add("geo", "AI 크롤러 접근 허용 (robots.txt)", 3,
    extras.robots === null ? "info" : (blockedBots.length === 0 ? "pass" : "fail"),
    extras.robots === null ? "확인 불가" : (blockedBots.length ? "차단된 AI 봇: " + blockedBots.join(", ") : "GPTBot·PerplexityBot·ClaudeBot 등 차단 없음"),
    "robots.txt에서 GPTBot, PerplexityBot, ClaudeBot, Google-Extended 등 AI 크롤러 차단을 해제하세요. 차단하면 AI 검색 인용 자체가 불가능합니다.",
    "OtterlyAI (Technical GEO)");
  add("geo", "정적 HTML 콘텐츠 (JS 의존도)", 3,
    textLen >= 500 ? "pass" : (allScripts >= 10 ? "fail" : "warn"),
    `본문 ${textLen.toLocaleString()}자 / script ${allScripts}개 — ${textLen < 500 && allScripts >= 10 ? "JS 렌더링 의존 의심" : "정적 텍스트 확인"}`,
    "AI 크롤러(ChatGPT, Perplexity 등)는 JavaScript를 실행하지 못해 동적 렌더링 콘텐츠를 읽지 못합니다. 핵심 콘텐츠를 순수 HTML로 제공하세요(SSR/프리렌더링).",
    "OtterlyAI (Technical GEO)");
  add("geo", "핵심 스키마 마크업 (JSON-LD)", 3,
    hasSchemaOf("Organization", "Product", "Article", "NewsArticle", "BlogPosting", "Review", "FAQPage", "HowTo") ? "pass" : (ldTypes.length ? "warn" : "fail"),
    ldTypes.length ? "발견: " + [...new Set(ldTypes)].slice(0, 6).join(", ") : "JSON-LD 없음",
    "콘텐츠 유형에 맞는 스키마를 JSON-LD로 추가하세요. 블로그 글 → Article/BlogPosting + (Q&A가 있으면) FAQPage. HowTo는 단계별 절차 글에만, QAPage는 커뮤니티 게시판(다수 답변)에만 사용합니다. 스키마는 AI에게 페이지 내용을 요약해주는 '치트시트' 역할을 하며 지식그래프 편입의 기반입니다.",
    "OtterlyAI (Schema.org for AI Search)");
  add("geo", "프래그먼트 품질 (자기완결적 문단)", 2,
    atomicRatio >= 0.5 && paraLens.length >= 3 ? "pass" : (paraLens.length ? "warn" : "fail"),
    paraLens.length ? `실질 문단 ${paraLens.length}개 중 ${atomicParas}개가 적정 길이(80~600자)` : "실질적인 문단 없음",
    "AI는 페이지가 아니라 '조각(fragment)' 단위로 콘텐츠를 추출합니다. 하나의 완결된 주장+근거+개체명을 담은 자기완결적 문단으로 작성하세요.",
    "Context Institute (Fragment Quality)");
  add("geo", "주제 포괄성 (Query Coverage)", 2,
    h23 >= 5 ? "pass" : (h23 >= 2 ? "warn" : "fail"),
    `하위 주제 헤딩(H2/H3) ${h23}개, 질문형 ${questionHeads}개`,
    "AI는 하나의 질문을 여러 하위 질문으로 확장(fan-out)해 검색합니다. 핵심 질문과 인접 하위 질문들을 H2/H3로 폭넓게 다루세요.",
    "Context Institute (Query Coverage)");
  add("geo", "답변 우선 구조 (정의형 도입부)", 2,
    firstPara && firstPara.length >= 50 && firstPara.length <= 400 && firstParaPos <= 0.5 ? "pass" : (firstPara ? "warn" : "fail"),
    firstPara ? `첫 문단 ${firstPara.length}자, 문서의 약 ${Math.round(firstParaPos * 100)}% 지점` : "실질적인 첫 문단을 찾지 못함",
    "첫 문단에서 핵심 질문에 바로 답하는 정의형 문장으로 시작하고 핵심 답변을 상단에 배치하세요. AI 요약 단계에서 도입부의 비중이 가장 큽니다.",
    "Aggarwal et al. (GEO) · Context Institute");
  add("geo", "작성자·신뢰 신호 (Citation Reliability)", 2,
    author && (modTime || pubTime) ? "pass" : (author || modTime || pubTime ? "warn" : "fail"),
    (author ? "작성자 신호 있음" : "작성자 정보 없음") + " · " + (modTime || pubTime ? "날짜: " + (modTime || pubTime).slice(0, 10) : "발행/수정일 없음"),
    "작성자 정보와 발행·수정일을 명시하세요. AI는 안정적이고 신뢰할 수 있어 보이는 출처를 인용 대상으로 우선 선택합니다.",
    "Context Institute (Citation Reliability)");
  add("geo", "목록·표 활용", 2,
    lists + tables >= 3 ? "pass" : (lists + tables >= 1 ? "warn" : "fail"),
    `목록 ${lists}개, 표 ${tables}개`,
    "핵심 정보를 목록(ul/ol)과 표로 구조화하세요. 구조화된 블록은 AI의 조각 선택(chunk selection)에서 살아남을 확률이 높습니다.",
    "Context Institute · OtterlyAI");
  add("geo", "시맨틱 HTML", 2,
    semantic.length >= 3 ? "pass" : (semantic.length >= 1 ? "warn" : "fail"),
    "사용 중: " + (semantic.join(", ") || "없음"),
    "main, article, section 등 시맨틱 태그로 본문 영역을 명확히 하세요. 검색·크롤링 시스템이 파싱 가능한(parseable) 형태가 검색 자격(Retrieval Eligibility)의 전제입니다.",
    "Context Institute (Retrieval Eligibility)");
  add("geo", "llms.txt (참고)", 1,
    "info",
    extras.llms === null ? "확인 불가" : (extras.llms ? "llms.txt 존재" : "llms.txt 없음"),
    "OtterlyAI 조사 기준, 현재 AI 검색이 llms.txt를 실제로 활용한 사례는 확인되지 않았습니다. 우선순위를 두지 않아도 됩니다 (점수 미반영).",
    "OtterlyAI");

  /* ===== 기술 기반 ===== */
  add("tech", "HTTPS", 3, u.protocol === "https:" ? "pass" : "fail", u.protocol,
    "HTTPS를 적용하세요. 구글·네이버 모두 보안 연결을 랭킹 신호로 사용합니다.");
  add("tech", "모바일 뷰포트", 2,
    doc.querySelector('meta[name="viewport"]') ? "pass" : "fail",
    doc.querySelector('meta[name="viewport"]') ? "viewport 메타 존재" : "없음",
    '<meta name="viewport" content="width=device-width, initial-scale=1">을 추가하세요. 모바일 우선 색인의 기본 요건입니다.');
  add("tech", "문자 인코딩", 1,
    doc.querySelector("meta[charset]") || /charset/i.test(rawHtml.slice(0, 2000)) ? "pass" : "warn",
    "charset " + (doc.querySelector("meta[charset]") ? "선언됨" : "미확인"),
    '<meta charset="UTF-8">을 head 최상단에 선언하세요.');
  add("tech", "DOCTYPE", 1,
    /^\s*<!doctype html/i.test(rawHtml) ? "pass" : "warn",
    /^\s*<!doctype html/i.test(rawHtml) ? "HTML5 doctype" : "doctype 누락/비표준",
    "<!DOCTYPE html>로 시작하도록 수정하세요.");
  add("tech", "파비콘", 1, favicon ? "pass" : "warn",
    favicon ? "설정됨" : "링크 없음",
    "파비콘을 설정하세요. 검색결과와 브라우저 탭에서 브랜드 인지도를 높입니다.");
  add("tech", "HTML 문서 크기", 2,
    htmlKB <= 150 ? "pass" : (htmlKB <= 400 ? "warn" : "fail"),
    `약 ${htmlKB}KB`,
    "HTML이 무거우면 크롤링·렌더링 속도가 저하됩니다. 불필요한 인라인 스크립트/스타일을 정리하세요.");
  add("tech", "렌더링 차단 스크립트", 2,
    headScripts === 0 ? "pass" : (headScripts <= 3 ? "warn" : "fail"),
    `head 내 동기 스크립트 ${headScripts}개`,
    "head의 외부 스크립트에 defer 또는 async를 추가해 초기 렌더링 차단을 줄이세요.");
  add("tech", "이미지 지연 로딩", 1,
    imgs.length < 4 ? "info" : (lazyImgs > 0 ? "pass" : "warn"),
    `이미지 ${imgs.length}개 중 lazy ${lazyImgs}개`,
    '스크롤 아래 이미지에 loading="lazy"를 적용해 초기 로딩 속도를 개선하세요.');
  add("tech", "구식 태그 미사용", 1,
    deprecated === 0 ? "pass" : "fail",
    deprecated ? `font/center/marquee 등 ${deprecated}개 발견` : "발견 안 됨",
    "구식(deprecated) 태그를 CSS 기반 마크업으로 교체하세요.");
  add("tech", "트위터 카드 / 공유 메타", 1,
    meta("twitter:card") || (ogT && ogI) ? "pass" : "warn",
    meta("twitter:card") ? "twitter:card 존재" : (ogT && ogI ? "OG로 대체 가능" : "없음"),
    "twitter:card 메타를 추가하면 SNS 공유 시 미리보기가 최적화됩니다.");

  // 내부 링크 목록 (크롤러용)
  const internalUrls = [];
  for (const a of internal) {
    try {
      const abs = new URL(a.getAttribute("href"), url);
      if (abs.protocol.startsWith("http")) internalUrls.push(abs.href);
    } catch (e) { /* skip */ }
  }

  const scores = {};
  Object.keys(AXES).forEach(a => scores[a] = scoreAxis(C, a));
  scores.total = Math.round((scores.google + scores.naver + scores.geo + scores.tech) / 4);

  // 키워드 분석용 페이지 원자료
  const page = {
    titleText: title,
    metaDesc: desc,
    ogTitle: ogT,
    ogDesc: ogD,
    h1Texts: [...h1s].map(h => (h.textContent || "").trim()),
    h23Texts: [...doc.querySelectorAll("h2,h3")].map(h => (h.textContent || "").trim()),
    questionHeadTexts: headings.filter(h => /\?|무엇|어떻게|왜|방법|언제|어디|이유|what|how|why|when/i.test(h.textContent)).map(h => (h.textContent || "").trim()),
    text: text.slice(0, 80000),
    paras: paras.slice(0, 300).map(p => (p.textContent || "").trim()),
    ldRaw: ldRawArr.join(" ").slice(0, 30000),
    ldTypes: [...new Set(ldTypes)],
    hasFaqSchema: hasSchemaOf("FAQPage", "HowTo", "QAPage"),
    hasFaqContent,
    statCount, quotations,
    externalCount: external.length,
    internalCount: internal.length,
    hasAuthor: !!author,
    hasDate: !!(modTime || pubTime),
    textLen, allScripts,
    noindex: robotsMeta.includes("noindex"),
    https: u.protocol === "https:",
    listsTables: lists + tables
  };

  return { url, title, checks: C, scores, internalUrls, page };
}

/* ===== 키워드 적합도 채점 ===== */
function kwIn(str, kw) {
  if (!str) return 0;
  const s = String(str).toLowerCase();
  const k = kw.toLowerCase().trim();
  if (s.includes(k)) return 2; // 완전 일치
  const toks = k.split(/\s+/).filter(t => t.length >= 1);
  if (toks.length > 1 && toks.every(t => s.includes(t))) return 1; // 토큰 모두 포함
  return 0;
}

function countKw(text, kw) {
  const s = (text || "").toLowerCase();
  const k = kw.toLowerCase().trim();
  let n = 0, i = 0;
  while ((i = s.indexOf(k, i)) !== -1) { n++; i += k.length; }
  if (n === 0) {
    const toks = k.split(/\s+/).filter(t => t.length >= 2);
    if (toks.length > 1 && toks.every(t => s.includes(t))) n = 1;
  }
  return n;
}

const KW_AXES = {
  relevance:   { name: "콘텐츠 관련성", desc: "키워드가 제목·헤딩·본문에 배치되었는가" },
  answer:      { name: "답변 적합성", desc: "질문에 대한 직접 답변 구조가 있는가" },
  evidence:    { name: "근거·신뢰", desc: "통계·출처·작성자 등 인용 요건" },
  eligibility: { name: "검색 자격", desc: "색인·AI 크롤러·정적 HTML" }
};

function scoreKeyword(result, keyword, extras) {
  const p = result.page;
  const kw = keyword.trim();
  const C = [];
  const add = (axis, label, weight, status, detail, advice) => C.push({ axis, label, weight, status, detail, advice: status === "pass" ? "" : advice });

  /* 콘텐츠 관련성 */
  const inTitle = kwIn(p.titleText, kw);
  add("relevance", "타이틀에 키워드", 3,
    inTitle === 2 ? "pass" : (inTitle === 1 ? "warn" : "fail"),
    inTitle ? `"${p.titleText.slice(0, 50)}"` : "타이틀에 키워드 없음",
    `페이지 타이틀에 "${kw}"를 그대로, 가급적 앞쪽에 배치하세요. 검색·AI 모두 타이틀을 1순위 관련성 신호로 봅니다.`);
  const inH1 = Math.max(0, ...p.h1Texts.map(t => kwIn(t, kw)), 0);
  add("relevance", "H1에 키워드", 2,
    inH1 === 2 ? "pass" : (inH1 === 1 ? "warn" : "fail"),
    p.h1Texts.length ? `H1: "${(p.h1Texts[0] || "").slice(0, 50)}"` : "H1 없음",
    `H1 제목에 "${kw}"를 포함하세요.`);
  const inH23 = Math.max(0, ...p.h23Texts.map(t => kwIn(t, kw)), 0);
  add("relevance", "소제목(H2/H3)에 키워드", 2,
    inH23 === 2 ? "pass" : (inH23 === 1 ? "warn" : "fail"),
    `소제목 ${p.h23Texts.length}개 중 키워드 포함 ${p.h23Texts.filter(t => kwIn(t, kw) > 0).length}개`,
    `"${kw}" 관련 하위 주제를 H2/H3 소제목으로 다루세요. AI의 질문 확장(fan-out) 검색에 걸리는 지점입니다.`);
  const bodyCount = countKw(p.text, kw);
  add("relevance", "본문 등장 빈도", 2,
    bodyCount >= 3 ? "pass" : (bodyCount >= 1 ? "warn" : "fail"),
    `본문에 약 ${bodyCount}회 등장`,
    `본문에서 "${kw}"를 자연스럽게 3회 이상 다루세요. 다만 기계적 반복(스터핑)은 역효과입니다.`);
  const firstIdx = p.text.toLowerCase().indexOf(kw.toLowerCase());
  const posRatio = firstIdx === -1 ? 1 : (p.textLen ? firstIdx / Math.min(p.textLen, 80000) : 1);
  add("relevance", "본문 상단(30%) 배치", 2,
    firstIdx !== -1 && posRatio <= 0.3 ? "pass" : (firstIdx !== -1 && posRatio <= 0.6 ? "warn" : "fail"),
    firstIdx === -1 ? "본문에서 키워드 미발견" : `첫 등장 위치: 본문의 약 ${Math.round(posRatio * 100)}% 지점`,
    `"${kw}"에 대한 내용을 페이지 상단으로 올리세요. AI Overview 인용의 55%가 상위 30% 콘텐츠에서 나옵니다.`);
  add("relevance", "메타 설명·OG에 키워드", 1,
    kwIn(p.metaDesc, kw) || kwIn(p.ogTitle, kw) || kwIn(p.ogDesc, kw) ? "pass" : "fail",
    kwIn(p.metaDesc, kw) ? "메타 설명에 포함" : "메타·OG에 없음",
    `메타 디스크립션과 og:title에도 "${kw}"를 포함하세요.`);

  /* 답변 적합성 */
  const defRegex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*") + "\\s*(는|은|이란|란|이|가)?\\s*[^.!?다]{2,80}(이다|입니다|합니다|됩니다|다)\\s*[.!?]?", "i");
  const hasDef = defRegex.test(p.text);
  add("answer", "정의형 답변 문장", 3,
    hasDef ? "pass" : "fail",
    hasDef ? "정의형 문장 발견" : `"${kw}는 ~이다" 형태의 직접 답변 문장 없음`,
    `"${kw}는(란) ~입니다"처럼 질문에 바로 답하는 정의형 문장을 도입부에 넣으세요. AI가 추출하기 가장 좋은 형태입니다.`);
  const qHead = p.questionHeadTexts.some(t => kwIn(t, kw) > 0);
  add("answer", "질문형 헤딩 매칭", 2,
    qHead ? "pass" : (p.questionHeadTexts.length ? "warn" : "fail"),
    qHead ? "키워드 포함 질문형 헤딩 있음" : `질문형 헤딩 ${p.questionHeadTexts.length}개, 키워드 매칭 없음`,
    `"${kw}란 무엇인가?", "${kw} 어떻게 준비하나?" 같은 실제 검색 질문 형태의 소제목을 추가하세요.`);
  const kwPara = p.paras.find(t => kwIn(t, kw) > 0 && t.length >= 80 && t.length <= 600);
  add("answer", "자기완결적 답변 문단", 2,
    kwPara ? "pass" : (p.paras.some(t => kwIn(t, kw) > 0) ? "warn" : "fail"),
    kwPara ? `발견: "${kwPara.slice(0, 60)}..."` : "키워드를 다루는 적정 길이(80~600자) 문단 없음",
    `"${kw}"에 대한 주장+근거+개체명을 담은 80~600자 문단을 만드세요. AI는 문단 조각 단위로 인용합니다.`);
  const platform = (extras && extras.platform) || "generic";
  const noCodeInsert = platform === "naver" || platform === "brunch";
  let faqStatus, faqDetail, faqAdvice;
  if (p.hasFaqContent && p.hasFaqSchema) {
    faqStatus = "pass"; faqDetail = "질문-답변 콘텐츠와 FAQPage 스키마가 모두 있습니다"; faqAdvice = "";
  } else if (p.hasFaqContent && !p.hasFaqSchema) {
    faqStatus = "warn";
    faqDetail = "질문-답변 콘텐츠는 있으나 FAQPage 스키마(JSON-LD) 코드가 없습니다";
    faqAdvice = noCodeInsert
      ? "질문형 소제목 바로 아래 첫 문장에 결론(답변)을 배치하는 Q&A 구조로 정리하세요. 이 플랫폼은 스키마 코드 삽입이 어려우므로 글 구조 자체가 핵심입니다."
      : "이미 있는 Q&A를 FAQPage 스키마(JSON-LD)로 감싸면 기계 가독성이 올라갑니다. (구글 FAQ 리치 결과 표시는 종료되었으나, AI·검색엔진의 구조 이해에는 여전히 도움됩니다.)";
  } else {
    faqStatus = "fail";
    faqDetail = "질문-답변 형식 콘텐츠가 없습니다";
    faqAdvice = `"${kw}란?", "${kw} 어떻게 준비하나요?" 같은 질문형 소제목과 그에 대한 답변으로 Q&A 섹션부터 작성하세요.`;
  }
  add("answer", "FAQ 질문-답변 구조", 2, faqStatus, faqDetail, faqAdvice);
  add("answer", "목록·표 활용", 1,
    p.listsTables >= 3 ? "pass" : (p.listsTables >= 1 ? "warn" : "fail"),
    `목록·표 ${p.listsTables}개`,
    `"${kw}" 관련 정보를 목록·표로 구조화하면 AI 답변에 그대로 재사용되기 쉽습니다.`);

  /* 근거·신뢰 */
  add("evidence", "통계·수치", 2,
    p.statCount >= 5 ? "pass" : (p.statCount >= 2 ? "warn" : "fail"),
    `수치 표현 약 ${p.statCount}건`,
    `"${kw}" 관련 구체적 수치(비율, 비용, 기간 등)를 추가하세요. GEO 논문 기준 가시성 +30~40% 요인입니다.`);
  add("evidence", "외부 출처 인용", 2,
    p.externalCount >= 3 ? "pass" : (p.externalCount >= 1 ? "warn" : "fail"),
    `외부 링크 ${p.externalCount}개`,
    "신뢰할 수 있는 출처 링크를 3개 이상 추가하세요.");
  add("evidence", "인용문", 1,
    p.quotations >= 1 ? "pass" : "fail",
    `인용 요소 ${p.quotations}개`,
    "전문가·기관 인용문을 blockquote로 추가하세요.");
  add("evidence", "작성자 정보", 1,
    p.hasAuthor ? "pass" : "fail",
    p.hasAuthor ? "있음" : "없음",
    "이름만이 아니라 지도 분야·경력·검수 기준을 사실 범위에서 표기하세요. 예: '10년차 문예창작 지도, OO대 합격생 다수 배출'. AI는 신뢰 가능한 출처를 우선 인용합니다.");
  add("evidence", "발행·수정일", 1,
    p.hasDate ? "pass" : "fail",
    p.hasDate ? "있음" : "없음",
    "발행일/수정일 메타를 추가하고 최신으로 유지하세요.");

  /* B-2 내부 링크 (같은 사이트 다른 글) */
  add("evidence", "내부 링크", 1,
    p.internalCount >= 3 ? "pass" : (p.internalCount >= 1 ? "warn" : "fail"),
    `내부 링크 ${p.internalCount}개`,
    "관련 글(기출 분석, 후기 등)로 가는 내부 링크를 본문 중간에 3개 이상 넣으세요. 전문성 신호와 체류 시간에 모두 기여합니다.");

  /* C-2 수치의 기준 연도·출처 병기 */
  const statPat = /\d+(\.\d+)?\s*(%|퍼센트|억|만|천|배|개|명|원|시간|분|위|점|등급)/g;
  const txt = p.text || "";
  let statTotal = 0, statCited = 0, mm;
  while ((mm = statPat.exec(txt)) !== null) {
    statTotal++;
    const ctx = txt.slice(Math.max(0, mm.index - 40), Math.min(txt.length, mm.index + mm[0].length + 40));
    if (/20\d{2}\s*년?|\d{4}\s*학년도|출처|기준|모집요강|조사|자료|발표|통계/.test(ctx)) statCited++;
  }
  const citeRatio = statTotal ? statCited / statTotal : 0;
  let citeStatus, citeDetail;
  if (statTotal < 2) { citeStatus = "info"; citeDetail = `수치 표현이 ${statTotal}건으로 적어 출처 병기 여부를 측정하지 않았습니다`; }
  else { citeStatus = citeRatio >= 0.5 ? "pass" : (citeRatio >= 0.2 ? "warn" : "fail"); citeDetail = `수치 ${statTotal}건 중 ${statCited}건에 연도·출처가 함께 표기됨 (${Math.round(citeRatio * 100)}%)`; }
  add("evidence", "수치의 연도·출처 병기", 2, citeStatus, citeDetail,
    "수치마다 기준 연도와 출처를 병기하세요. 예: '2026학년도 모집요강 기준 실기 90%'. AI는 출처가 명시된 수치를 우선 인용합니다.");

  /* 검색 자격 */
  add("eligibility", "색인 허용", 3,
    p.noindex ? "fail" : "pass",
    p.noindex ? "noindex 설정됨" : "색인 가능",
    "noindex를 제거하지 않으면 이 페이지는 어떤 키워드로도 노출될 수 없습니다.");
  const robotsOk = extras && extras.robots !== null && extras.robots !== undefined;
  add("eligibility", "AI 크롤러 허용", 2,
    !robotsOk ? "info" : (extras.aiBlocked && extras.aiBlocked.length ? "fail" : "pass"),
    !robotsOk ? "확인 불가" : (extras.aiBlocked && extras.aiBlocked.length ? "차단: " + extras.aiBlocked.join(", ") : "차단 없음"),
    "robots.txt에서 GPTBot 등 AI 크롤러 차단을 해제하세요.");
  add("eligibility", "정적 HTML 콘텐츠", 2,
    p.textLen >= 500 ? "pass" : (p.allScripts >= 10 ? "fail" : "warn"),
    `본문 ${p.textLen.toLocaleString()}자`,
    "핵심 콘텐츠를 순수 HTML로 제공하세요. AI 크롤러는 JS를 실행하지 않습니다.");
  add("eligibility", "구조화 데이터", 1,
    noCodeInsert ? "info" : (p.ldTypes.length ? "pass" : "fail"),
    noCodeInsert ? "이 플랫폼은 JSON-LD 직접 삽입이 어려워 점수에서 제외" : (p.ldTypes.length ? p.ldTypes.slice(0, 4).join(", ") : "없음"),
    platform === "tistory"
      ? "티스토리는 스킨 편집 → HTML 편집에서 삽입 가능하나 난이도가 있습니다. 우선순위는 글 구조 개선입니다."
      : "JSON-LD 스키마를 추가하세요.");
  add("eligibility", "HTTPS", 1,
    p.https ? "pass" : "fail", p.https ? "적용됨" : "미적용",
    "HTTPS를 적용하세요.");

  const axisScore = axis => {
    const list = C.filter(c => c.axis === axis && c.status !== "info");
    const max = list.reduce((s, c) => s + c.weight, 0);
    const got = list.reduce((s, c) => s + c.weight * VAL[c.status], 0);
    return max ? Math.round(got / max * 100) : 0;
  };
  const scores = {
    relevance: axisScore("relevance"),
    answer: axisScore("answer"),
    evidence: axisScore("evidence"),
    eligibility: axisScore("eligibility")
  };
  scores.total = Math.round(scores.relevance * 0.3 + scores.answer * 0.3 + scores.evidence * 0.2 + scores.eligibility * 0.2);

  return { url: result.url, title: result.title, keyword: kw, scores, checks: C };
}

module.exports = { analyze, scoreAxis, scoreKeyword, AXES, KW_AXES };
