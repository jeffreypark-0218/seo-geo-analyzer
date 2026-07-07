# SEO/GEO 사이트 전체 분석기

메인 주소만 입력하면 사이트맵과 내부 링크를 따라 사이트의 모든 페이지를 크롤링해
구글 SEO / 네이버 SEO / AI 검색(GEO) / 기술 기반 4개 축으로 채점하고 보완 제안을 제공합니다.
페이지 수 제한이 없습니다.

## 실행 방법

1. Node.js 18 이상 설치 (https://nodejs.org — LTS 버전 권장)
2. 이 폴더(site-analyzer)에서 터미널을 열고:

```
npm install
npm start
```

3. 브라우저에서 http://localhost:3000 접속
4. 분석할 사이트 메인 주소 입력 후 "전체 분석" 클릭

## 동작 방식

- robots.txt에 선언된 사이트맵(없으면 /sitemap.xml)에서 URL을 수집하고,
  분석한 페이지의 내부 링크를 따라가며 새 페이지를 계속 발견합니다.
- 동시에 5개 페이지씩 병렬 분석하며, 진행 상황이 실시간으로 표시됩니다.
- robots.txt의 Disallow 규칙(User-agent: *)을 준수하고, 이미지/PDF 등 비 HTML 리소스는 건너뜁니다.
- 쿼리스트링이 다른 URL은 기본적으로 같은 페이지로 취급합니다(화면에서 변경 가능).

## 결과 화면

- 사이트 종합 점수와 4개 축 평균 점수
- 사이트 공통 문제: 여러 페이지에서 반복되는 미충족 항목을 영향도 순으로 정렬
- 페이지별 점수표(낮은 순): 행 클릭 시 해당 페이지의 47개 항목 상세 진단

## 채점 근거

- Aggarwal et al., "GEO: Generative Engine Optimization" (arXiv:2311.09735) — 인용·인용문·통계 +30~40%, 유창성 +15~30%, 키워드 스터핑 무효
- OtterlyAI, "Generative Engine Optimization Guide" — JSON-LD 스키마, AI 크롤러 robots.txt, JS 렌더링 한계
- Sean Pan (Context Institute), SSRN 6546718 — 6대 GEO 프리미티브
- 구글 검색 센터 가이드라인 · 네이버 서치어드바이저 / C-Rank / D.I.A

백링크, 브랜드 언급량, Core Web Vitals 등 외부 데이터가 필요한 항목은 점수에 포함되지 않습니다.

## 참고

- 단일 페이지 간이 진단용으로는 상위 폴더의 `seo-geo-analyzer.html`(더블클릭 실행)을 계속 사용할 수 있습니다.
- 대상 사이트가 봇을 차단하면 일부 페이지에서 "가져오기 실패"가 표시될 수 있습니다.
