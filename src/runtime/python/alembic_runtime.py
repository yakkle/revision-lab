from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import base64
import datetime
import decimal
import uuid
import traceback
from typing import Any

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, MetaData, Table, select


WORKSPACES = Path("/workspaces")
TEXT_SUFFIXES = {".ini", ".mako", ".py", ".sql", ".txt"}
MAX_FILE_BYTES = 1024 * 1024
DATABASE_MODE = "sqlite"

ENV_TEMPLATE = '''from logging.config import fileConfig
from pathlib import Path
import runpy
import sys

from alembic import context
from sqlalchemy import engine_from_config

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

workspace_root = Path(__file__).resolve().parents[1]
if str(workspace_root) not in sys.path:
    sys.path.insert(0, str(workspace_root))

model_namespace = runpy.run_path(str(workspace_root / "models.py"))
target_metadata = model_namespace["metadata"]


def run_migrations_offline():
    raise RuntimeError("Offline SQL mode is not supported by Revision Lab")


def run_migrations_online():
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
    )
    try:
        with connectable.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                render_as_batch=connection.dialect.name == "sqlite",
                compare_type=True,
            )
            with context.begin_transaction():
                context.run_migrations()
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
'''

MODELS_TEMPLATE = '''from sqlalchemy import MetaData

# 빈 metadata는 manual revision 실습을 그대로 시작할 수 있게 유지합니다.
metadata = MetaData()

# 자유 실습용 SQLAlchemy 2.x 모델 예제
#
# User 테이블로 autogenerate를 연습하려면 위 import와 metadata 두 줄을 지우고,
# 아래 예제 각 줄의 "# "를 제거한 뒤 파일을 저장하세요.
#
# from datetime import datetime
#
# from sqlalchemy import DateTime, MetaData, String, func
# from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
#
# NAMING_CONVENTION = {
#     "ix": "ix_%(column_0_label)s",
#     "uq": "uq_%(table_name)s_%(column_0_name)s",
#     "pk": "pk_%(table_name)s",
# }
#
# class Base(DeclarativeBase):
#     metadata = MetaData(naming_convention=NAMING_CONVENTION)
#
# class User(Base):
#     __tablename__ = "users"
#
#     id: Mapped[int] = mapped_column(primary_key=True)
#     email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
#     display_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
#     created_at: Mapped[datetime] = mapped_column(
#         DateTime(timezone=True),
#         server_default=func.now(),
#         nullable=False,
#     )
#
# metadata = Base.metadata
'''


class RuntimeRequestError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _workspace(workspace_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", workspace_id):
        raise RuntimeRequestError("INVALID_WORKSPACE_ID", "Workspace ID is invalid")
    return WORKSPACES / workspace_id


def _relative_path(root: Path, value: str, *, suffix_required: bool = True) -> Path:
    relative = PurePosixPath(value)
    if relative.is_absolute() or not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise RuntimeRequestError("INVALID_PATH", f"Path must stay inside the workspace: {value}")
    if suffix_required and relative.suffix.lower() not in TEXT_SUFFIXES:
        raise RuntimeRequestError("UNSUPPORTED_FILE_TYPE", f"Unsupported editable file type: {relative.suffix or '(none)'}")
    target = (root / Path(*relative.parts)).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as error:
        raise RuntimeRequestError("INVALID_PATH", f"Path must stay inside the workspace: {value}") from error
    return target


def _database_url(root: Path) -> str:
    if DATABASE_MODE == "postgresql":
        return "postgresql+pglite://"
    return f"sqlite:///{root / 'database.sqlite'}"


def _config(root: Path, stdout: io.StringIO | None = None) -> Config:
    ini = root / "alembic.ini"
    if not ini.exists():
        raise RuntimeRequestError("ALEMBIC_NOT_INITIALIZED", "Run 'alembic init' before this command")
    config = Config(str(ini), stdout=stdout or io.StringIO(), output_buffer=stdout or io.StringIO())
    config.set_main_option("sqlalchemy.url", _database_url(root).replace("%", "%%"))
    return config


def _editable_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(
        path for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES and "__pycache__" not in path.parts
    )


def _file_manifest(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in _editable_files(root)
    }


def _file_changes(before: dict[str, str], after: dict[str, str]) -> list[dict[str, str]]:
    changes: list[dict[str, str]] = []
    for path in sorted(before.keys() | after.keys()):
        if path not in before:
            change = "added"
        elif path not in after:
            change = "deleted"
        elif before[path] != after[path]:
            change = "modified"
        else:
            continue
        changes.append({"path": path, "change": change})
    return changes


def _version_rows(connection, inspector) -> list[str]:
    if not inspector.has_table("alembic_version"):
        return []
    return sorted(str(row[0]) for row in connection.exec_driver_sql("SELECT version_num FROM alembic_version"))


def _revision_graph(root: Path, current: set[str]) -> list[dict[str, Any]]:
    if not (root / "alembic.ini").exists():
        return []
    scripts = ScriptDirectory.from_config(_config(root))
    heads = set(scripts.get_heads())
    nodes: list[dict[str, Any]] = []
    for revision in scripts.walk_revisions(base="base", head="heads"):
        down = revision.down_revision
        down_revisions = list(down) if isinstance(down, tuple) else ([] if down is None else [down])
        dependencies = revision.dependencies
        depends_on = list(dependencies) if isinstance(dependencies, tuple) else ([] if dependencies is None else [dependencies])
        nodes.append({
            "revision": revision.revision,
            "path": Path(revision.path).resolve().relative_to(root.resolve()).as_posix(),
            "downRevisions": down_revisions,
            "branchLabels": sorted(revision.branch_labels or []),
            "dependsOn": depends_on,
            "isHead": revision.revision in heads,
            "isBranchPoint": len(revision.nextrev) > 1,
            "isMergePoint": len(down_revisions) > 1,
            "isCurrent": revision.revision in current,
        })
    return nodes


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return str(value)


def _schema(root: Path) -> dict[str, Any]:
    engine = create_engine(_database_url(root))
    connection = engine.connect()
    try:
        inspector = inspect(connection)
        tables: list[dict[str, Any]] = []
        for table_name in sorted(name for name in inspector.get_table_names() if name != "alembic_version"):
            pk = inspector.get_pk_constraint(table_name)
            pk_columns = list(pk.get("constrained_columns") or [])
            columns = []
            for column in inspector.get_columns(table_name):
                name = str(column["name"])
                columns.append({
                    "name": name,
                    "type": column["type"].compile(dialect=engine.dialect),
                    "nullable": bool(column.get("nullable", True)),
                    "default": None if column.get("default") is None else str(column["default"]),
                    "primaryKeyPosition": pk_columns.index(name) + 1 if name in pk_columns else 0,
                })
            foreign_keys = [{
                "name": item.get("name"),
                "columns": list(item.get("constrained_columns") or []),
                "referredTable": str(item.get("referred_table") or ""),
                "referredColumns": list(item.get("referred_columns") or []),
                "options": _json_value(item.get("options") or {}),
            } for item in inspector.get_foreign_keys(table_name)]
            unique_constraints = [{
                "name": item.get("name"),
                "columns": list(item.get("column_names") or []),
            } for item in inspector.get_unique_constraints(table_name)]
            check_constraints = [{
                "name": item.get("name"),
                "sqlText": str(item.get("sqltext") or ""),
            } for item in inspector.get_check_constraints(table_name)]
            indexes = [{
                "name": str(item.get("name") or ""),
                "columns": list(item.get("column_names") or []),
                "unique": bool(item.get("unique", False)),
            } for item in inspector.get_indexes(table_name)]
            tables.append({
                "name": table_name,
                "columns": columns,
                "primaryKey": {"name": pk.get("name"), "columns": pk_columns},
                "foreignKeys": foreign_keys,
                "uniqueConstraints": unique_constraints,
                "checkConstraints": check_constraints,
                "indexes": indexes,
            })
        return {"dialect": DATABASE_MODE, "tables": tables, "alembicVersion": _version_rows(connection, inspector)}
    finally:
        connection.close()
        engine.dispose()


def _state(root: Path) -> dict[str, Any]:
    files = list(_file_manifest(root))
    schema = _schema(root)
    return {
        "files": files,
        "revisions": _revision_graph(root, set(schema["alembicVersion"])),
        "schema": schema,
    }


def _named_items(items: list[dict[str, Any]], key) -> dict[str, dict[str, Any]]:
    return {key(item): item for item in items}


def _schema_diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    changes: list[dict[str, Any]] = []

    def compare(kind: str, table: str, before_items: dict[str, Any], after_items: dict[str, Any]) -> None:
        for name in sorted(before_items.keys() | after_items.keys()):
            old = before_items.get(name)
            new = after_items.get(name)
            if old is None:
                changes.append({"kind": kind, "table": table, "name": name, "change": "added", "after": new})
            elif new is None:
                changes.append({"kind": kind, "table": table, "name": name, "change": "deleted", "before": old})
            elif old != new:
                changes.append({"kind": kind, "table": table, "name": name, "change": "modified", "before": old, "after": new})

    before_tables = {table["name"]: table for table in before["tables"]}
    after_tables = {table["name"]: table for table in after["tables"]}
    for table_name in sorted(before_tables.keys() | after_tables.keys()):
        old_table = before_tables.get(table_name)
        new_table = after_tables.get(table_name)
        if old_table is None:
            changes.append({"kind": "table", "table": table_name, "name": table_name, "change": "added", "after": new_table})
            continue
        if new_table is None:
            changes.append({"kind": "table", "table": table_name, "name": table_name, "change": "deleted", "before": old_table})
            continue
        compare("column", table_name, _named_items(old_table["columns"], lambda item: item["name"]), _named_items(new_table["columns"], lambda item: item["name"]))
        compare("primaryKey", table_name, {"primary": old_table["primaryKey"]}, {"primary": new_table["primaryKey"]})
        compare("foreignKey", table_name, _named_items(old_table["foreignKeys"], lambda item: item["name"] or ",".join(item["columns"])), _named_items(new_table["foreignKeys"], lambda item: item["name"] or ",".join(item["columns"])))
        compare("uniqueConstraint", table_name, _named_items(old_table["uniqueConstraints"], lambda item: item["name"] or ",".join(item["columns"])), _named_items(new_table["uniqueConstraints"], lambda item: item["name"] or ",".join(item["columns"])))
        compare("checkConstraint", table_name, _named_items(old_table["checkConstraints"], lambda item: item["name"] or item["sqlText"]), _named_items(new_table["checkConstraints"], lambda item: item["name"] or item["sqlText"]))
        compare("index", table_name, _named_items(old_table["indexes"], lambda item: item["name"]), _named_items(new_table["indexes"], lambda item: item["name"]))
    return {
        "changes": changes,
        "alembicVersion": {"before": before["alembicVersion"], "after": after["alembicVersion"]},
    }


def _take_value(argv: list[str], index: int, option: str) -> tuple[str, int]:
    if index + 1 >= len(argv) or argv[index + 1].startswith("-"):
        raise RuntimeRequestError("INVALID_ALEMBIC_OPTIONS", f"Option {option} requires a value")
    return argv[index + 1], index + 2


def _parse_options(
    argv: list[str],
    value_options: dict[str, str],
    flag_options: dict[str, str],
    minimum_positionals: int,
    maximum_positionals: int | None,
) -> tuple[list[str], dict[str, Any]]:
    positionals: list[str] = []
    options: dict[str, Any] = {}
    index = 0
    while index < len(argv):
        item = argv[index]
        if item in value_options:
            value, index = _take_value(argv, index, item)
            destination = value_options[item]
            if destination in options:
                raise RuntimeRequestError("INVALID_ALEMBIC_OPTIONS", f"Option {item} may only be supplied once")
            options[destination] = value
        elif item in flag_options:
            destination = flag_options[item]
            if options.get(destination):
                raise RuntimeRequestError("INVALID_ALEMBIC_OPTIONS", f"Option {item} may only be supplied once")
            options[destination] = True
            index += 1
        elif item.startswith("-") and not re.fullmatch(r"-\d+", item):
            raise RuntimeRequestError("UNSUPPORTED_ALEMBIC_OPTION", f"Unsupported Alembic option: {item}")
        else:
            positionals.append(item)
            index += 1
    if len(positionals) < minimum_positionals or (maximum_positionals is not None and len(positionals) > maximum_positionals):
        maximum = "unbounded" if maximum_positionals is None else str(maximum_positionals)
        raise RuntimeRequestError(
            "INVALID_ALEMBIC_ARGUMENTS",
            f"Expected {minimum_positionals}..{maximum} positional arguments, received {len(positionals)}",
        )
    return positionals, options


def _prepare_initialized_workspace(root: Path, directory: str) -> None:
    ini = root / "alembic.ini"
    contents = ini.read_text(encoding="utf-8")
    contents, replacements = re.subn(
        r"(?m)^sqlalchemy\.url\s*=.*$",
        f"sqlalchemy.url = {_database_url(root)}",
        contents,
        count=1,
    )
    if replacements != 1:
        raise RuntimeError("Generated alembic.ini does not contain sqlalchemy.url")
    ini.write_text(contents, encoding="utf-8")
    script_root = _relative_path(root, directory, suffix_required=False)
    (script_root / "env.py").write_text(ENV_TEMPLATE, encoding="utf-8")
    models = root / "models.py"
    if not models.exists():
        models.write_text(MODELS_TEMPLATE, encoding="utf-8")


def _dispatch(root: Path, argv: list[str], stdout: io.StringIO) -> None:
    if not argv:
        raise RuntimeRequestError("INVALID_ALEMBIC_ARGUMENTS", "Alembic command is required")
    name, arguments = argv[0], argv[1:]
    previous = Path.cwd()
    os.chdir(root)
    try:
        if name == "init":
            positionals, options = _parse_options(arguments, {"-t": "template", "--template": "template"}, {"--package": "package"}, 0, 1)
            directory = positionals[0] if positionals else "alembic"
            _relative_path(root, directory, suffix_required=False)
            if not re.fullmatch(r"[A-Za-z0-9_-]+", directory):
                raise RuntimeRequestError("INVALID_PATH", "Alembic directory must be one workspace-root directory name")
            template = options.get("template", "generic")
            if template != "generic":
                raise RuntimeRequestError("UNSUPPORTED_ALEMBIC_OPTION", "Only the generic Alembic template is supported")
            config = Config(str(root / "alembic.ini"), stdout=stdout, output_buffer=stdout)
            command.init(config, directory, template=template, package=options.get("package", False))
            _prepare_initialized_workspace(root, directory)
            return

        config = _config(root, stdout)
        if name == "revision":
            positionals, options = _parse_options(
                arguments,
                {"-m": "message", "--message": "message", "--head": "head", "--branch-label": "branch_label", "--rev-id": "rev_id", "--depends-on": "depends_on"},
                {"--autogenerate": "autogenerate", "--splice": "splice"},
                0,
                0,
            )
            del positionals
            command.revision(config, **options)
        elif name in {"upgrade", "downgrade"}:
            positionals, options = _parse_options(arguments, {"--tag": "tag"}, {}, 1, 1)
            getattr(command, name)(config, positionals[0], **options)
        elif name == "current":
            positionals, options = _parse_options(arguments, {}, {"-v": "verbose", "--verbose": "verbose"}, 0, 0)
            del positionals
            command.current(config, **options)
        elif name == "history":
            positionals, options = _parse_options(
                arguments,
                {"-r": "rev_range", "--rev-range": "rev_range"},
                {"-v": "verbose", "--verbose": "verbose", "-i": "indicate_current", "--indicate-current": "indicate_current"},
                0,
                0,
            )
            del positionals
            command.history(config, **options)
        elif name == "heads":
            positionals, options = _parse_options(
                arguments,
                {},
                {"-v": "verbose", "--verbose": "verbose", "--resolve-dependencies": "resolve_dependencies"},
                0,
                0,
            )
            del positionals
            command.heads(config, **options)
        elif name == "branches":
            positionals, options = _parse_options(arguments, {}, {"-v": "verbose", "--verbose": "verbose"}, 0, 0)
            del positionals
            command.branches(config, **options)
        elif name == "show":
            positionals, options = _parse_options(arguments, {}, {}, 1, 1)
            del options
            command.show(config, positionals[0])
        elif name == "merge":
            positionals, options = _parse_options(
                arguments,
                {"-m": "message", "--message": "message", "--branch-label": "branch_label", "--rev-id": "rev_id"},
                {},
                2,
                None,
            )
            command.merge(config, positionals, **options)
        else:
            raise RuntimeRequestError("UNSUPPORTED_ALEMBIC_COMMAND", f"Unsupported Alembic command: {name}")
    finally:
        os.chdir(previous)


def _import_clone(root: Path, seed: dict[str, Any]) -> None:
    if not isinstance(seed, dict) or not isinstance(seed.get("files"), list) or len(seed["files"]) > 200:
        raise RuntimeRequestError("INVALID_CLONE_SEED", "Clone seed files are invalid")
    if root.exists() and any(root.iterdir()):
        raise RuntimeRequestError("WORKSPACE_ALREADY_EXISTS", "Clone target must be an empty workspace")
    root.mkdir(parents=True, exist_ok=True)
    for item in seed["files"]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("content"), str):
            raise RuntimeRequestError("INVALID_CLONE_SEED", "Clone seed file is invalid")
        content = item["content"]
        if len(content.encode("utf-8")) > MAX_FILE_BYTES:
            raise RuntimeRequestError("FILE_TOO_LARGE", "Clone seed file exceeds the 1 MiB limit")
        target = _relative_path(root, item["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    database = seed.get("sqliteDatabase")
    if DATABASE_MODE == "sqlite":
        if database is None:
            (root / "database.sqlite").touch(exist_ok=True)
        elif not isinstance(database, str):
            raise RuntimeRequestError("INVALID_CLONE_SEED", "SQLite clone database is invalid")
        else:
            try:
                payload = base64.b64decode(database, validate=True)
            except Exception as error:
                raise RuntimeRequestError("INVALID_CLONE_SEED", "SQLite clone database is not valid base64") from error
            if len(payload) > 32 * 1024 * 1024:
                raise RuntimeRequestError("CLONE_TOO_LARGE", "SQLite clone database exceeds 32 MiB")
            (root / "database.sqlite").write_bytes(payload)
    elif database is not None:
        raise RuntimeRequestError("INVALID_CLONE_SEED", "PostgreSQL clone must not include a SQLite database")


def _export_clone(root: Path) -> dict[str, Any]:
    files = []
    for path in _editable_files(root):
        if path.stat().st_size > MAX_FILE_BYTES:
            raise RuntimeRequestError("FILE_TOO_LARGE", "Clone source file exceeds the 1 MiB limit")
        files.append({"path": path.relative_to(root).as_posix(), "content": path.read_text(encoding="utf-8")})
    seed: dict[str, Any] = {"files": files}
    if DATABASE_MODE == "sqlite":
        database = root / "database.sqlite"
        payload = database.read_bytes() if database.exists() else b""
        if len(payload) > 32 * 1024 * 1024:
            raise RuntimeRequestError("CLONE_TOO_LARGE", "SQLite clone database exceeds 32 MiB")
        seed["sqliteDatabase"] = base64.b64encode(payload).decode("ascii")
    return seed


def _create_workspace(root: Path, seed: dict[str, Any] | None = None) -> dict[str, Any]:
    if seed is not None:
        _import_clone(root, seed)
        return _state(root)
    root.mkdir(parents=True, exist_ok=True)
    if DATABASE_MODE == "sqlite":
        (root / "database.sqlite").touch(exist_ok=True)
    return _state(root)


def _run_alembic(root: Path, argv: list[str]) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    before_manifest = _file_manifest(root)
    before = _state(root)
    stdout = io.StringIO()
    stderr = io.StringIO()
    error: dict[str, Any] | None = None
    trace: str | None = None
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            _dispatch(root, argv, stdout)
    except Exception as exception:
        trace = traceback.format_exc()
        error = {
            "code": exception.code if isinstance(exception, RuntimeRequestError) else "ALEMBIC_COMMAND_FAILED",
            "message": str(exception),
            "traceback": trace,
        }
        original = getattr(exception, "orig", exception)
        for attribute, key in (("sqlstate", "sqlState"), ("detail", "detail"), ("hint", "hint")):
            value = getattr(original, attribute, None)
            if value is not None:
                error[key] = value
    after_manifest = _file_manifest(root)
    after = _state(root)
    result: dict[str, Any] = {
        "success": error is None,
        "argv": argv,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "fileChanges": _file_changes(before_manifest, after_manifest),
        "schemaDiff": _schema_diff(before["schema"], after["schema"]),
        "before": before,
        "after": after,
    }
    if error is not None:
        result["error"] = error
        result["traceback"] = trace
    return result


def _data_tag(value):
    if value is None:
        return {"tag": "null"}
    if isinstance(value, bool):
        return {"tag": "boolean", "value": value}
    if isinstance(value, int):
        return {"tag": "bigint", "value": str(value)} if abs(value) > 9007199254740991 else {"tag": "number", "value": value}
    if isinstance(value, float):
        if value != value:
            return {"tag": "special-number", "value": "NaN"}
        if abs(value) == float("inf"):
            return {"tag": "special-number", "value": "Infinity" if value > 0 else "-Infinity"}
        return {"tag": "number", "value": value}
    if isinstance(value, str):
        return {"tag": "string", "value": value}
    if isinstance(value, decimal.Decimal):
        return {"tag": "decimal", "value": str(value)}
    if isinstance(value, uuid.UUID):
        return {"tag": "string", "value": str(value)}
    if isinstance(value, (bytes, memoryview)):
        return {"tag": "bytea", "value": base64.b64encode(value).decode("ascii")}
    if isinstance(value, datetime.datetime):
        return {"tag": "timestamp", "value": value.isoformat(), "dataTypeId": 1184 if value.tzinfo else 1114}
    if isinstance(value, datetime.date):
        return {"tag": "date", "value": value.isoformat(), "dataTypeId": 1082}
    if isinstance(value, datetime.time):
        return {"tag": "time", "value": value.isoformat(), "dataTypeId": 1083}
    if isinstance(value, (list, tuple)):
        return {"tag": "array", "value": [_data_tag(item) for item in value]}
    # JSON objects are explicitly encoded JSON text, never implicit repr().
    if isinstance(value, dict):
        return {"tag": "string", "value": json.dumps(value, ensure_ascii=False, allow_nan=False)}
    raise RuntimeRequestError("UNSUPPORTED_VALUE_TYPE", f"Cannot preview value of type {type(value).__name__}")


def _read_table(root: Path, name: str):
    engine = create_engine(_database_url(root))
    try:
        with engine.connect() as connection:
            if name not in inspect(connection).get_table_names():
                raise RuntimeRequestError("TABLE_NOT_FOUND", f"Table does not exist: {name}")
            table = Table(name, MetaData(), autoload_with=connection)
            statement = select(table).limit(51)
            if list(table.primary_key.columns):
                statement = statement.order_by(*table.primary_key.columns)
            rows = connection.execute(statement).fetchall()
            data = {"table": name, "columns": list(table.columns.keys()), "rows": [[_data_tag(cell) for cell in row] for row in rows[:50]], "truncated": len(rows) > 50}
            if len(json.dumps(data).encode("utf-8")) > 1024 * 1024:
                raise RuntimeRequestError("DATA_PREVIEW_TOO_LARGE", "Data preview exceeds 1 MiB")
            return data
    finally:
        engine.dispose()


def handle(request_json: str) -> str:
    request = json.loads(request_json)
    workspace_id = request.get("workspaceId")
    request_type = request.get("type")
    root = _workspace(workspace_id)

    if request_type == "CREATE_WORKSPACE":
        return json.dumps({"type": "WORKSPACE_CREATED", "state": _create_workspace(root, request.get("seed"))})
    if not root.exists():
        raise RuntimeRequestError("WORKSPACE_NOT_FOUND", "Create the workspace before using it")
    if request_type == "READ_TABLE":
        return json.dumps({"type": "TABLE_DATA", "data": _read_table(root, request["table"])})
    if request_type == "EXPORT_CLONE":
        return json.dumps({"type": "CLONE_EXPORTED", "seed": _export_clone(root)})
    if request_type == "RUN_COMMAND":
        try:
            source = request["command"]
            if any(token in source for token in ("|", ">", "<", ";", "`", "$(", "&&", "\n", "\r")):
                raise RuntimeRequestError("UNSUPPORTED_SHELL_SYNTAX", "Shell operators and command substitution are not supported")
            argv = shlex.split(source)
        except ValueError as error:
            raise RuntimeRequestError("INVALID_ALEMBIC_ARGUMENTS", str(error)) from error
        if not argv or argv[0] != "alembic":
            raise RuntimeRequestError("UNSUPPORTED_ALEMBIC_COMMAND", "Commands must start with alembic")
        argv = argv[1:]
        if len(argv) > 64 or any(len(item) > 4096 for item in argv):
            raise RuntimeRequestError("INVALID_ALEMBIC_ARGUMENTS", "Command arguments exceed runtime limits")
        return json.dumps({"type": "COMMAND_RESULT", "result": _run_alembic(root, argv)})
    if request_type == "RUN_ALEMBIC":
        argv = request.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(item, str) for item in argv):
            raise RuntimeRequestError("INVALID_ALEMBIC_ARGUMENTS", "argv must be a non-empty string array")
        return json.dumps({"type": "COMMAND_RESULT", "result": _run_alembic(root, argv)})
    if request_type == "READ_FILE":
        target = _relative_path(root, request.get("path", ""))
        if not target.is_file():
            raise RuntimeRequestError("FILE_NOT_FOUND", f"File does not exist: {request.get('path', '')}")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise RuntimeRequestError("FILE_TOO_LARGE", "File exceeds the 1 MiB editor limit")
        return json.dumps({"type": "FILE_CONTENT", "path": target.relative_to(root).as_posix(), "content": target.read_text(encoding="utf-8")})
    if request_type == "WRITE_FILE":
        target = _relative_path(root, request.get("path", ""))
        content = request.get("content")
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FILE_BYTES:
            raise RuntimeRequestError("FILE_TOO_LARGE", "File exceeds the 1 MiB editor limit")
        before = _file_manifest(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        after = _file_manifest(root)
        return json.dumps({"type": "FILE_WRITTEN", "state": _state(root), "fileChanges": _file_changes(before, after)})
    if request_type == "INSPECT":
        return json.dumps({"type": "STATE_SNAPSHOT", "state": _state(root)})
    raise RuntimeRequestError("RUNTIME_INVALID_REQUEST", f"Unsupported runtime request: {request_type}")


def handle_safely(request_json: str) -> str:
    try:
        return handle(request_json)
    except RuntimeRequestError as exception:
        return json.dumps({
            "type": "ERROR",
            "error": {"code": exception.code, "message": str(exception), "traceback": traceback.format_exc()},
        })
    except Exception as exception:
        return json.dumps({
            "type": "ERROR",
            "error": {"code": "ALEMBIC_RUNTIME_ERROR", "message": str(exception), "traceback": traceback.format_exc()},
        })
