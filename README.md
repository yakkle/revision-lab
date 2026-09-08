# Revision Lab

> Alembic Migration Playground

Revision Lab은 Alembic을 어렵게 느끼는 Python 백엔드 개발자가 브라우저에서 migration을 직접 실행하고, revision graph와 실제 데이터베이스 변화를 함께 관찰할 수 있는 교육용 실습 도구다.

백엔드 서버 없이 브라우저 안에서 다음 두 실행 환경을 제공하는 것을 MVP 목표로 한다.

- SQLite: Pyodide에서 Alembic과 SQLAlchemy가 SQLite 파일에 직접 연결한다.
- PostgreSQL: Pyodide의 동기 DBAPI가 Worker RPC를 통해 PGlite에 연결한다.

두 모드는 실제 Alembic `upgrade`, `downgrade`, `autogenerate`, branch/merge 동작을 동일한 학습 화면에서 제공한다.

## MVP 학습 경험

한 화면에서 다음 상태를 서로 연결해 보여준다.

1. Alembic 환경과 revision 파일
2. revision DAG와 현재 head
3. 실제 DB schema와 `alembic_version`
4. 명령 실행 전후의 schema diff와 원본 로그

기본 실습은 다음과 같다.

1. `alembic init`과 파일 구조 이해
2. 수동 revision 생성 및 `upgrade()`/`downgrade()` 편집
3. upgrade/downgrade와 실제 DB 변화 확인
4. SQLAlchemy 모델 변경과 autogenerate 검토
5. Alice/Bob 분기, multiple heads 오류 재현, merge revision 해결

## 문서

- [MVP 요구사항](docs/REQUIREMENTS.md)
- [핵심 개념과 학습 모델](docs/CONCEPTS.md)
- [기술 명세](docs/SPEC.md)
- [T5 PostgreSQL Alembic 기능 동등성 검증](docs/T5.md)

- [에이전트 작업 규칙](AGENTS.md)

## 결정된 기술 방향

- React + TypeScript + Vite 정적 SPA
- Pyodide Web Worker + Alembic + SQLAlchemy
- PGlite 전용 Worker
- `SharedArrayBuffer`와 `Atomics`를 사용하는 동기 DBAPI Worker RPC
- IndexedDB workspace 체크포인트
- Cloudflare Pages 정적 호스팅
- 애플리케이션 백엔드, 인증, 서버 DB 없음

버전, 프로토콜, 실패 처리 및 브라우저 제약은 [기술 명세](docs/SPEC.md)를 단일 기준으로 삼는다.

## 로컬 개발

Node와 pnpm은 프로젝트의 `mise.toml`에 고정되어 있다.

```bash
mise trust
mise install
pnpm install --frozen-lockfile
pnpm dev
```

`dev`와 `build`는 lockfile에 고정된 Pyodide 및 PGlite 런타임 파일을 `public/runtime`에 준비한 뒤 Vite를 실행한다.

주요 검증 명령은 다음과 같다.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

배포 환경별 격리 헤더와 PostgreSQL capability 차이는 [배포 환경](docs/DEPLOYMENT.md)을 참고한다.

현재 두 DB 모드의 Alembic 실행·schema 조회 API까지 구현되어 있다. 시작 화면은 capability 진단 화면이며, 편집기·터미널·revision graph를 갖춘 Lab UI는 T6에서 연결한다.
