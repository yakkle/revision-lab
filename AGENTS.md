# AGENTS.md

이 문서는 Revision Lab 저장소에서 작업하는 모든 코딩 에이전트에게 적용된다.

## 1. 먼저 읽을 문서

작업 전 다음 문서를 순서대로 읽는다.

1. `docs/REQUIREMENTS.md`
2. `docs/CONCEPTS.md`
3. `docs/SPEC.md`

문서가 충돌하면 사용자 최신 지시, `docs/SPEC.md`, `docs/REQUIREMENTS.md`, 나머지 문서 순으로 따른다. 계약을 변경해야 한다면 코드만 우회하지 말고 관련 문서와 테스트를 같은 태스크에서 갱신한다.

## 2. 승인 게이트

- 한 번에 태스크 하나만 수행한다.
- 사용자가 현재 태스크를 승인하기 전에는 구현을 시작하지 않는다.
- 승인된 태스크 범위 밖의 선행 구현이나 다음 태스크 작업을 함께 하지 않는다.
- 완료 시 변경 파일, 테스트와 결과, 잔여 위험을 보고하고 멈춘다.
- 다음 태스크는 별도 승인을 받은 뒤 시작한다.
- 중요한 전제가 깨지거나 중단 조건을 만나면 임의 대안으로 전환하지 말고 증거와 선택지를 보고한다.
- commit, push, package publish, 외부 서비스 생성, Cloudflare 배포는 사용자가 해당 외부 변경을 명시적으로 요청한 경우에만 한다.
- 태스크 완료 후 작업 내용을 읽기 쉬운 한 줄 commit 메시지로 작성한다.

## 3. 고정 아키텍처 원칙

- 제품명은 `Revision Lab`, 패키지 식별자는 `revision-lab`이다.
- 브라우저 전용 정적 SPA이며 애플리케이션 백엔드를 추가하지 않는다.
- SQLite와 PostgreSQL 모두 실제 Alembic online migration을 사용한다.
- PostgreSQL은 PGlite JavaScript 패키지를 전용 Worker에서 실행한다.
- `py-pglite`를 의존성으로 추가하지 않는다.
- PostgreSQL 연결은 `pglite_dbapi`와 `postgresql+pglite` dialect, SharedArrayBuffer/Atomics Worker RPC로 구현한다.
- PostgreSQL 경로를 offline SQL simulation으로 조용히 대체하지 않는다.
- Pyodide와 PGlite 작업을 main thread에서 실행하지 않는다.
- UI가 revision graph나 DB 성공 상태를 추측하지 않는다. Worker의 Alembic/Inspector 결과를 사용한다.
- 브라우저 터미널에서 OS shell을 실행하거나 shell처럼 보이는 임의 명령 실행기를 만들지 않는다.

## 4. 구현 규칙

- 프로젝트 명령은 `mise.toml`이 선택한 Node와 pnpm 환경에서 실행한다.
- TypeScript는 strict mode를 유지하고 protocol에는 discriminated union을 사용한다.
- Worker 경계의 입력은 runtime validation을 거친다.
- request마다 protocol version, request ID, workspace ID를 유지한다.
- Python/TypeScript 값 변환은 명시적인 tagged codec을 사용하고 손실 가능한 암묵 변환을 피한다.
- 파일 경로는 workspace root 내부로 정규화하고 traversal을 거절한다.
- 실패한 migration 뒤에는 예상 rollback 상태가 아니라 실제 DB를 다시 inspect한다.
- 사용자가 볼 오류에는 안정적인 code와 원본 message/traceback을 모두 보존한다.
- 새 dependency를 추가할 때 브라우저 Worker 호환성, license, bundle 크기, 동일 출처 제공 가능성을 확인한다.
- 관련 없는 사용자 변경을 되돌리거나 정리하지 않는다.

## 5. 테스트와 완료 보고

- behavior 변경에는 해당 계층의 자동화 테스트를 포함한다.
- Worker RPC는 성공뿐 아니라 timeout, stale sequence, oversized response, Worker 종료를 테스트한다.
- DBAPI는 transaction과 exception mapping을 테스트한다.
- 두 DB 모드에서 revision graph, schema snapshot, `alembic_version` 일치를 검증한다.
- UI E2E는 Chromium, Firefox, WebKit을 대상으로 한다.
- formatter나 code generator가 승인 범위 밖 파일을 변경하지 않는지 확인한다.
- 태스크 완료 보고에는 다음을 포함한다.
  - 구현한 결과
  - 변경 파일
  - 실행한 검증 명령과 결과
  - 알려진 한계 또는 다음 태스크에 남긴 항목

## 6. 금지 사항

- 승인 없이 다음 태스크 시작
- `py-pglite` 사용
- 가짜 DB 결과 또는 미리 정한 migration 성공 애니메이션
- runtime에서 CDN/PyPI/npm의 최신 패키지를 즉석 설치
- main thread에서 `Atomics.wait()` 호출
- 사용자 확인 없이 import archive의 Python 실행
- 승인 없는 git history 변경, commit, push 또는 배포
