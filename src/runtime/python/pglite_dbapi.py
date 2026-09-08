"""Small PEP 249 surface that forwards PostgreSQL work to the PGlite Worker."""

from __future__ import annotations

import base64
import datetime as _datetime
import decimal as _decimal
import math
from collections.abc import Mapping, Sequence
from typing import Any, Callable

apilevel = "2.0"
threadsafety = 1
paramstyle = "numeric_dollar"


class Warning(Exception):
    pass


class Error(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        sqlstate: str | None = None,
        detail: str | None = None,
        hint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.sqlstate = sqlstate
        self.pgcode = sqlstate
        self.detail = detail
        self.hint = hint


class InterfaceError(Error):
    pass


class DatabaseError(Error):
    pass


class DataError(DatabaseError):
    pass


class OperationalError(DatabaseError):
    pass


class IntegrityError(DatabaseError):
    pass


class InternalError(DatabaseError):
    pass


class ProgrammingError(DatabaseError):
    pass


class NotSupportedError(DatabaseError):
    pass


_query: Callable[[str, Sequence[Any]], dict[str, Any]] | None = None
_execute_many: Callable[[str, Sequence[Sequence[Any]]], dict[str, Any]] | None = None
_active_connection: Connection | None = None


def configure(
    query: Callable[[str, Sequence[Any]], dict[str, Any]],
    execute_many: Callable[[str, Sequence[Sequence[Any]]], dict[str, Any]],
) -> None:
    global _query, _execute_many
    _query = query
    _execute_many = execute_many


def _error_class(fault: Mapping[str, Any]) -> type[Error]:
    code = str(fault.get("code") or "")
    sqlstate = str(fault.get("sqlState") or "")
    if code == "UNSUPPORTED_VALUE_TYPE" or code.startswith("DBAPI_NOT_SUPPORTED"):
        return NotSupportedError
    if sqlstate.startswith("23"):
        return IntegrityError
    if sqlstate.startswith("22"):
        return DataError
    if sqlstate.startswith("42"):
        return ProgrammingError
    if sqlstate.startswith(("08", "40", "53", "57", "58")):
        return OperationalError
    if code.startswith("RPC_") or code == "PGLITE_DATABASE_ERROR":
        return OperationalError
    return DatabaseError


def _raise_fault(fault: Mapping[str, Any]) -> None:
    error_class = _error_class(fault)
    raise error_class(
        str(fault.get("message") or fault.get("code") or "PGlite request failed"),
        code=str(fault.get("code")) if fault.get("code") is not None else None,
        sqlstate=str(fault.get("sqlState")) if fault.get("sqlState") is not None else None,
        detail=str(fault.get("detail")) if fault.get("detail") is not None else None,
        hint=str(fault.get("hint")) if fault.get("hint") is not None else None,
    )


def _result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("ok") not in (True, False):
        raise InterfaceError("The PGlite Worker returned an invalid response", code="DBAPI_INVALID_RESPONSE")
    if value["ok"] is False:
        fault = value.get("error")
        if not isinstance(fault, dict):
            raise InterfaceError("The PGlite Worker returned an invalid error", code="DBAPI_INVALID_RESPONSE")
        _raise_fault(fault)
    return value


def _decode(value: Mapping[str, Any]) -> Any:
    tag = value.get("tag")
    if tag == "null":
        return None
    if tag in ("boolean", "number", "string"):
        return value.get("value")
    if tag == "bigint":
        return int(str(value.get("value")))
    if tag == "decimal":
        return _decimal.Decimal(str(value.get("value")))
    if tag == "date":
        return _datetime.date.fromisoformat(str(value.get("value")))
    if tag == "time":
        return _datetime.time.fromisoformat(str(value.get("value")).replace("Z", "+00:00"))
    if tag == "timestamp":
        return _datetime.datetime.fromisoformat(str(value.get("value")).replace("Z", "+00:00"))
    if tag == "bytea":
        return base64.b64decode(str(value.get("value")), validate=True)
    if tag == "array":
        items = value.get("value")
        if not isinstance(items, list):
            raise InterfaceError("Invalid tagged array", code="DBAPI_INVALID_RESPONSE")
        return [_decode(item) for item in items]
    if tag == "special-number":
        raw = value.get("value")
        return math.nan if raw == "NaN" else math.inf if raw == "Infinity" else -math.inf
    raise InterfaceError(f"Unsupported tagged value: {tag!r}", code="DBAPI_INVALID_RESPONSE")


def _parameters(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        if value:
            raise ProgrammingError("numeric_dollar parameters must be positional", code="DBAPI_INVALID_PARAMETERS")
        return []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    raise ProgrammingError("parameters must be a positional sequence", code="DBAPI_INVALID_PARAMETERS")


def _command(sql: str) -> str:
    return sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""


class Connection:
    def __init__(self) -> None:
        self._closed = False
        self._transaction_active = False
        self._autocommit = False
        self._isolation_level = "READ COMMITTED"

    def _check_open(self) -> None:
        if self._closed:
            raise InterfaceError("connection is closed", code="DBAPI_CONNECTION_CLOSED")

    def _direct(self, sql: str, parameters: Sequence[Any] = ()) -> dict[str, Any]:
        self._check_open()
        if _query is None:
            raise InterfaceError("pglite_dbapi is not configured", code="DBAPI_NOT_CONFIGURED")
        return _result(_query(sql, parameters))

    def _before_execute(self, sql: str) -> None:
        command = _command(sql)
        if not self._autocommit and not self._transaction_active and command not in ("BEGIN", "COMMIT", "ROLLBACK"):
            self._direct("BEGIN")
            self._transaction_active = True

    def _after_execute(self, sql: str) -> None:
        command = _command(sql)
        if command == "BEGIN":
            self._transaction_active = True
        elif command in ("COMMIT", "ROLLBACK"):
            self._transaction_active = False

    def cursor(self, *args: Any, **kwargs: Any) -> Cursor:
        self._check_open()
        if args or kwargs:
            raise NotSupportedError("server-side cursors are not supported", code="DBAPI_NOT_SUPPORTED")
        return Cursor(self)

    def commit(self) -> None:
        self._check_open()
        if self._transaction_active:
            self._direct("COMMIT")
            self._transaction_active = False

    def rollback(self) -> None:
        self._check_open()
        if self._transaction_active:
            self._direct("ROLLBACK")
            self._transaction_active = False

    def close(self) -> None:
        global _active_connection
        if self._closed:
            return
        try:
            if self._transaction_active:
                self.rollback()
        finally:
            self._closed = True
            if _active_connection is self:
                _active_connection = None

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def autocommit(self) -> bool:
        return self._autocommit

    @autocommit.setter
    def autocommit(self, value: bool) -> None:
        self._check_open()
        if self._transaction_active:
            raise ProgrammingError("autocommit cannot change during a transaction", code="DBAPI_TRANSACTION_ACTIVE")
        self._autocommit = bool(value)

    @property
    def isolation_level(self) -> str:
        return self._isolation_level

    @isolation_level.setter
    def isolation_level(self, value: str) -> None:
        normalized = value.replace("_", " ").upper()
        allowed = {"READ COMMITTED", "READ UNCOMMITTED", "REPEATABLE READ", "SERIALIZABLE"}
        if normalized not in allowed:
            raise NotSupportedError(f"unsupported isolation level: {value}", code="DBAPI_NOT_SUPPORTED")
        self._isolation_level = normalized

    def __enter__(self) -> Connection:
        self._check_open()
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        if exc_type is None:
            self.commit()
        else:
            self.rollback()

    def tpc_begin(self, *args: Any, **kwargs: Any) -> None:
        raise NotSupportedError("two-phase transactions are not supported", code="DBAPI_NOT_SUPPORTED")

    tpc_prepare = tpc_commit = tpc_rollback = tpc_recover = tpc_begin


class Cursor:
    arraysize = 1

    def __init__(self, connection: Connection) -> None:
        self.connection = connection
        self._closed = False
        self._rows: list[tuple[Any, ...]] = []
        self._offset = 0
        self.description: tuple[tuple[Any, ...], ...] | None = None
        self.rowcount = -1

    def _check_open(self) -> None:
        self.connection._check_open()
        if self._closed:
            raise InterfaceError("cursor is closed", code="DBAPI_CURSOR_CLOSED")

    def _apply(self, result: Mapping[str, Any]) -> None:
        fields = result.get("fields") or []
        rows = result.get("rows") or []
        self.description = tuple(
            (str(field["name"]), int(field["dataTypeId"]), None, None, None, None, None)
            for field in fields
        ) if fields else None
        self._rows = [tuple(_decode(value) for value in row) for row in rows]
        self._offset = 0
        self.rowcount = int(result.get("rowCount", -1))

    def execute(self, operation: str, parameters: Any = None) -> Cursor:
        self._check_open()
        if not isinstance(operation, str) or not operation.strip():
            raise ProgrammingError("operation must be non-empty SQL", code="DBAPI_INVALID_SQL")
        values = _parameters(parameters)
        self.connection._before_execute(operation)
        self._apply(self.connection._direct(operation, values))
        self.connection._after_execute(operation)
        return self

    def executemany(self, operation: str, seq_of_parameters: Any) -> Cursor:
        self._check_open()
        if not isinstance(operation, str) or not operation.strip():
            raise ProgrammingError("operation must be non-empty SQL", code="DBAPI_INVALID_SQL")
        if _execute_many is None:
            raise InterfaceError("pglite_dbapi is not configured", code="DBAPI_NOT_CONFIGURED")
        parameter_sets = [_parameters(parameters) for parameters in seq_of_parameters]
        self.connection._before_execute(operation)
        self._apply(_result(_execute_many(operation, parameter_sets)))
        self.connection._after_execute(operation)
        return self

    def fetchone(self) -> tuple[Any, ...] | None:
        self._check_open()
        if self.description is None:
            raise ProgrammingError("the last operation did not produce rows", code="DBAPI_NO_RESULT")
        if self._offset >= len(self._rows):
            return None
        row = self._rows[self._offset]
        self._offset += 1
        return row

    def fetchmany(self, size: int | None = None) -> list[tuple[Any, ...]]:
        limit = self.arraysize if size is None else size
        if limit < 0:
            raise ProgrammingError("fetch size cannot be negative", code="DBAPI_INVALID_FETCH_SIZE")
        rows = []
        for _ in range(limit):
            row = self.fetchone()
            if row is None:
                break
            rows.append(row)
        return rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        self._check_open()
        if self.description is None:
            raise ProgrammingError("the last operation did not produce rows", code="DBAPI_NO_RESULT")
        rows = self._rows[self._offset :]
        self._offset = len(self._rows)
        return rows

    def close(self) -> None:
        self._closed = True
        self._rows = []
        self.description = None

    def setinputsizes(self, sizes: Any) -> None:
        return None

    def setoutputsize(self, size: Any, column: Any = None) -> None:
        return None

    def callproc(self, procname: str, parameters: Any = None) -> None:
        raise NotSupportedError("stored procedure calls are not supported", code="DBAPI_NOT_SUPPORTED")

    def nextset(self) -> None:
        raise NotSupportedError("multiple result sets are not supported", code="DBAPI_NOT_SUPPORTED")

    def copy(self, *args: Any, **kwargs: Any) -> None:
        raise NotSupportedError("COPY is not supported", code="DBAPI_NOT_SUPPORTED")

    def __iter__(self) -> Cursor:
        return self

    def __next__(self) -> tuple[Any, ...]:
        row = self.fetchone()
        if row is None:
            raise StopIteration
        return row


def connect(*args: Any, **kwargs: Any) -> Connection:
    global _active_connection
    if args or kwargs:
        raise NotSupportedError("network connection arguments are not supported", code="DBAPI_NOT_SUPPORTED")
    if _active_connection is not None and not _active_connection.closed:
        raise InterfaceError("only one logical PGlite connection is supported", code="DBAPI_SINGLE_CONNECTION")
    _active_connection = Connection()
    return _active_connection
