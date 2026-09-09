# 배포 환경

## 공통 빌드

프로젝트 도구는 `mise.toml`에 고정한다.

```bash
mise trust
mise install
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build`는 TypeScript 검사와 Vite build 후 `dist`의 모든 정적 파일이 각각 25MiB 미만인지 검사한다. 25MiB 이상인 파일이 하나라도 있으면 build와 CI가 실패한다.

## 로컬 production preview

```bash
pnpm preview
```

Vite preview는 다음 헤더를 제공한다.

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`

JS/MJS 모듈은 `Cache-Control: no-store`로 제공한다. WebKit 테스트에서 캐시된 Worker·모듈 응답이 COEP로 차단되면서 두 번째 workspace 생성이나 초기화가 실패하는 것을 확인했다. WASM/data/wheel 파일에는 이 캐시 제한을 적용하지 않는다. Vite 개발 서버는 모든 응답에 `no-store`를 사용한다.

브라우저 console에서 `crossOriginIsolated === true`인지 확인한다. PostgreSQL capability는 이 조건에서만 활성화된다.

## GitHub Pages 1차 배포

`.github/workflows/pages.yml`이 repository 이름을 Vite base path로 사용해 정적 사이트를 build하고 GitHub Pages artifact를 배포한다.

GitHub repository에서 다음 설정이 필요하다.

1. Settings → Pages → Source를 **GitHub Actions**로 선택한다.
2. main branch에 push하거나 `Deploy GitHub Pages` workflow를 수동 실행한다.
3. 배포 URL에서 화면과 정적 asset 경로를 확인한다.
4. GitHub Pages는 repository의 `_headers` 파일을 HTTP 응답 헤더로 적용하지 않으므로 PostgreSQL 모드가 비활성화되고 COOP/COEP 안내가 표시되는지 확인한다.

GitHub Pages 배포는 정적 SPA와 capability fallback을 검증하는 1차 production 환경이다. SharedArrayBuffer 기반 PostgreSQL runtime의 production 검증 환경은 아니다.

## Cloudflare Pages 이전

Cloudflare Pages는 `public/_headers`가 build 결과의 `_headers`로 복사되며 정적 응답에 COOP/COEP를 적용한다.

- Build command: `pnpm build`
- Build output directory: `dist`
- Root directory: repository root
- Environment: mise 또는 Node 24.11.0 / pnpm 11.19.0

배포 후 다음을 확인한다.

1. document와 Worker/WASM asset이 동일 출처에서 제공된다.
2. `crossOriginIsolated === true`다.
3. PostgreSQL capability가 활성화된다.
4. 모든 정적 파일이 25MiB 미만이다.
5. JS/MJS 응답에 `Cache-Control: no-store`가 적용되고, 동일 탭에서 workspace를 두 번 생성하거나 초기화해도 Worker가 정상 동작한다. `public/_headers`의 `/*.js`, `/*.mjs` 규칙이 이 정책을 정의한다.

실제 GitHub 또는 Cloudflare 프로젝트 생성과 배포는 별도 명시적 승인 후 수행한다.
