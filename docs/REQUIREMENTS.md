# Revision Lab MVP 요구사항

## 1. 목적과 사용자

Revision Lab은 Alembic의 명령을 외우게 하는 도구가 아니라, migration 파일·revision DAG·실제 DB 상태 사이의 관계를 직접 실험하게 하는 브라우저 기반 학습 환경이다.

주 사용자는 다음과 같다.

- Alembic을 처음 도입하는 Python 백엔드 개발자
- upgrade/downgrade와 `alembic_version`의 관계가 모호한 개발자
- autogenerate 결과를 그대로 적용하면 안 되는 이유를 배우려는 개발자
- 협업 중 multiple heads와 merge revision을 재현해 보고 싶은 팀

UI 설명은 한국어로 제공하고, 파일명·코드·Alembic 명령·오류 원문은 실제 환경과 동일한 영어 표현을 유지한다.

## 2. MVP 완료 조건

사용자는 서버 요청 없이 최신 데스크톱 브라우저에서 다음을 완료할 수 있어야 한다.

1. SQLite 또는 PostgreSQL workspace를 생성한다.
2. 실제 Alembic 환경과 revision 파일을 만든다.
3. revision을 upgrade/downgrade하고 실제 DB schema 변화를 확인한다.
4. SQLAlchemy metadata 변경으로 autogenerate revision을 만든 뒤 내용을 검토하고 적용한다.
5. 두 개의 독립 branch를 만들고 multiple heads 오류를 확인한 뒤 merge revision으로 해결한다.
6. 각 단계에서 revision graph, `alembic_version`, schema snapshot과 diff가 실제 런타임 결과와 일치한다.
7. 새로고침 또는 Worker 재시작 후 마지막 성공 체크포인트를 복원한다.

SQLite와 PostgreSQL 모드는 위 기능에 대해 동등한 사용자 경험을 제공해야 한다. 엔진별 DDL 및 transaction 차이는 숨기지 않고 학습 설명으로 보여준다.

## 3. 기능 요구사항

### 3.1 Workspace와 DB 모드

- `sqlite`와 `postgresql` 중 하나를 선택해 독립 workspace를 만든다.
- 서로 다른 DB 모드의 파일과 DB 상태를 암묵적으로 공유하지 않는다.
- workspace를 초기 상태로 reset할 수 있다.
- 마지막 성공 명령과 편집 상태를 IndexedDB 체크포인트로 저장한다.
- workspace 파일, DB snapshot, 학습 진행도를 버전 지정 ZIP으로 export/import한다.
- import한 Python 파일은 사용자가 내용을 확인하기 전 자동 실행하지 않는다.

### 3.2 파일과 편집기

- Alembic 프로젝트에 필요한 디렉터리와 텍스트 파일을 탐색한다.
- Python, INI, SQL 파일을 CodeMirror에서 편집하고 저장한다.
- 명령 실행 후 생성·수정·삭제된 파일을 표시한다.
- revision 파일의 `revision`, `down_revision`, `branch_labels`, `depends_on`을 Alembic 자체 API로 읽는다. UI가 Python 소스를 임의 정규식으로 해석하지 않는다.

### 3.3 Alembic 터미널

- 실제 OS shell 대신 명령 문자열을 argv로 파싱해 Alembic 공개 Command API를 호출한다.
- MVP 허용 명령은 `init`, `revision`, `upgrade`, `downgrade`, `current`, `history`, `heads`, `branches`, `show`, `merge`다.
- `revision --autogenerate`를 지원한다.
- shell redirection, pipe, 명령 치환, 외부 실행 파일 호출은 지원하지 않는다.
- stdout, stderr, traceback과 초보자용 설명을 분리해서 함께 표시한다.
- 명령 실행 중 같은 workspace에 중복 명령을 실행하지 않는다.

### 3.4 Revision graph와 현재 상태

- Alembic `ScriptDirectory`가 반환한 revision 관계로 DAG를 만든다.
- base, branch point, head, merge point, 현재 DB revision을 서로 다른 상태로 표현한다.
- 여러 head가 생긴 경우 이를 정상적인 DAG 상태로 보여주되, 모호한 `upgrade head`가 실패하는 이유를 설명한다.
- merge revision의 복수 `down_revision`을 파일과 graph에서 연결해 보여준다.

### 3.5 DB schema와 diff

- 테이블, 컬럼, nullable, default, primary key, foreign key, unique/check constraint, index를 정규화한다.
- `alembic_version`의 실제 행을 별도 표시한다.
- 명령 실행 전후 snapshot을 비교해 추가·삭제·변경을 보여준다.
- engine 고유 타입과 DDL 결과를 지나치게 공통화하지 않고 raw dialect 표현을 함께 보존한다.
- migration 실패 시 예상 상태가 아니라 실패 후 실제 DB 상태를 다시 읽어 표시한다.

### 3.6 학습 모드

- 가이드 모드와 자유 실습 모드는 같은 실제 runtime을 사용한다.
- 가이드 단계는 파일, revision graph, DB snapshot을 검사해 완료 여부를 판단한다.
- 사용자가 다른 방법으로 올바른 상태에 도달한 경우 특정 문자열 일치만으로 실패 처리하지 않는다.
- 다음 다섯 개 실습을 SQLite와 PostgreSQL에서 제공한다.
  1. init과 프로젝트 구조
  2. 수동 revision
  3. upgrade/downgrade
  4. autogenerate와 결과 검토
  5. Alice/Bob branch와 merge

### 3.7 협업 시뮬레이션

- Alice와 Bob workspace를 동일한 base에서 복제한다.
- 각 actor가 실제 revision을 생성한다.
- “PR 합치기” 동작은 두 revision 파일을 integration workspace에 병합해 실제 multiple-head 상태를 만든다.
- 실제 `heads`, 실패하는 `upgrade head`, `merge`, 성공하는 upgrade 순서를 실행한다.
- 실제 Git, 원격 저장소, 네트워크 동기화, 동시 편집은 구현하지 않는다.

## 4. 비기능 요구사항

- UI main thread에서 Pyodide 또는 PGlite 쿼리를 실행하지 않는다.
- runtime 패키지와 WASM은 버전을 고정하고 동일 출처 정적 자산으로 제공한다.
- PostgreSQL 모드는 `crossOriginIsolated === true`일 때만 활성화한다.
- 개별 PostgreSQL DB RPC는 15초, 전체 Alembic 명령은 30초 안에 완료하거나 timeout으로 종료한다.
- timeout 또는 Worker crash 후 마지막 성공 체크포인트로 복원 가능해야 한다.
- 사용자 파일과 DB는 기본적으로 브라우저 밖으로 전송하지 않는다.
- 최신 데스크톱 Chromium, Firefox, WebKit을 E2E 대상으로 한다. 모바일은 MVP 지원 대상이 아니다.
- 키보드만으로 DB 모드 선택, 파일 선택, 명령 실행, 주요 패널 전환이 가능해야 한다.

## 5. MVP 제외 범위

- 로그인, 계정, 클라우드 동기화, 공유 링크
- 실제 다중 사용자 협업 및 Git provider 연결
- 원격 PostgreSQL 연결
- MySQL 또는 기타 DB dialect
- arbitrary shell, `pip install`, `npm install`
- PostgreSQL COPY, server-side cursor, 복수 동시 connection
- 운영 DB의 네트워크 지연, 권한 체계, lock 경쟁, 대용량 데이터 성능 재현
- import한 프로젝트의 무확인 자동 실행

