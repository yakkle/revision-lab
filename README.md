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
- [T6 Lab UI 작업 기록](docs/T6.md)
- [T7 교육 흐름과 협업 시뮬레이션 작업 기록](docs/T7.md)
- [T8 저장, 복구 및 완성도 작업 기록](docs/T8.md)

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

현재 두 DB 모드의 실제 Alembic 실행기를 편집기·터미널·revision graph·schema/data·diff·로그 패널과 상태 기반 학습 가이드에 연결했다.

## Lab 사용

1. 첫 화면 또는 **Workspace 관리**에서 **SQLite workspace 만들기**나 **PostgreSQL workspace 만들기**를 누른다.
2. 터미널에서 `alembic init migrations`를 실행한다.
3. `alembic revision -m "create users"`로 빈 파일을 생성하고, 가이드 예제로 `users(id, name)`의 `upgrade()`와 `downgrade()`를 작성해 저장한다.
4. `alembic upgrade head`, `alembic downgrade -1`, 다시 `alembic upgrade head`를 실행하며 실제 schema와 DB current 이동을 확인한다.
5. `models.py`에서 `email` 한 줄의 주석을 제거한 뒤 `alembic revision --autogenerate -m "add email"`로 기존 테이블의 변경 후보를 만든다.

**학습 가이드 열기**를 선택하면 다섯 lesson의 완료 여부를 실제 revision graph와 DB snapshot으로 확인한다. 협업 lesson은 하나의 current head를 공통 base로 준비한 뒤 Alice, Bob, Integration workspace를 실제 파일·DB 상태에서 복제한다. Alice와 Bob의 revision 파일을 합치면 integration에서 실제 multiple-head 오류를 확인하고 merge revision으로 해결할 수 있다.

Graph 노드와 DB current revision을 선택하면 해당 migration 파일이 열린다. DB에 적용되지 않은 head migration은 확인 후 삭제할 수 있으며 적용된 파일이나 자식이 있는 파일은 먼저 downgrade 또는 graph 정리가 필요하다. Ctrl/⌘+S로 파일을 저장하고, 터미널의 위·아래 방향키로 명령 기록을 불러올 수 있다. 가이드의 명령은 터미널 입력창에만 채워지며 **명령 실행**을 눌러야 실제 실행된다. 편집기는 앱 작업면 안에서 최대화할 수 있고 Escape로 복원한다. Workspace 관리와 명령 예시는 바깥을 클릭하거나 Escape를 눌러 닫을 수 있다.

동시에 최대 4개 workspace를 유지한다. 성공한 명령과 저장한 파일, lesson 진행도, 조절한 터미널 높이는 브라우저 IndexedDB의 마지막 성공 체크포인트와 session에 보관되며 새로고침이나 Worker 중단 후 자동 복원된다. 저장하지 않은 편집은 체크포인트 대상이 아니다. **Workspace 관리**의 내보내기로 SQLite/PGlite DB와 파일을 ZIP으로 저장하고, 가져오기에서 Python 파일을 검토한 뒤 별도 workspace로 열 수 있다. 초기화는 파일·DB·체크포인트를 지운 뒤 같은 모드의 새 workspace를 만들고, 삭제는 대체 workspace 없이 완전히 제거한다. 협업 그룹의 초기화·삭제는 연결된 네 workspace를 함께 처리한다.
