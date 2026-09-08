"""SQLAlchemy PostgreSQL dialect for the browser PGlite DBAPI."""

from __future__ import annotations

from sqlalchemy.dialects import registry
from sqlalchemy.dialects.postgresql.base import PGDialect
from sqlalchemy.pool import StaticPool

import pglite_dbapi


class PGliteDialect(PGDialect):
    driver = "pglite"
    default_paramstyle = "numeric_dollar"
    supports_statement_cache = True
    supports_server_side_cursors = False

    @classmethod
    def import_dbapi(cls):
        return pglite_dbapi

    @classmethod
    def get_pool_class(cls, url):
        return StaticPool

    def create_connect_args(self, url):
        if url.host or url.port or url.username or url.password or url.database:
            raise pglite_dbapi.NotSupportedError(
                "postgresql+pglite URLs cannot contain network connection arguments",
                code="DBAPI_NOT_SUPPORTED",
            )
        return ([], {})

    def get_isolation_level_values(self, dbapi_connection):
        return ("AUTOCOMMIT", "SERIALIZABLE", "READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ")

    def get_isolation_level(self, dbapi_connection):
        return "AUTOCOMMIT" if dbapi_connection.autocommit else dbapi_connection.isolation_level

    def set_isolation_level(self, dbapi_connection, level):
        normalized = level.replace("_", " ").upper()
        if normalized == "AUTOCOMMIT":
            dbapi_connection.autocommit = True
            return
        dbapi_connection.autocommit = False
        dbapi_connection.isolation_level = normalized

    def do_ping(self, dbapi_connection):
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("SELECT 1")
            return cursor.fetchone() == (1,)
        finally:
            cursor.close()
            dbapi_connection.rollback()

    def is_disconnect(self, error, connection, cursor):
        return getattr(error, "code", None) in {
            "RPC_CONNECTION_BROKEN",
            "RPC_PROTOCOL_ERROR",
            "RPC_TIMEOUT",
            "RPC_WORKER_TERMINATED",
        }


def register() -> None:
    registry.register("postgresql.pglite", __name__, "PGliteDialect")


register()
