"""Single-instance SQLite storage; atomic CAS prevents lost draft updates."""
import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class Conflict(Exception):
    pass


class Store:
    def __init__(self, root: Path, database_path: Path | None = None):
        root.mkdir(parents=True, exist_ok=True)
        self.path = database_path if database_path is not None else root / "qor.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connection(self):
        con = sqlite3.connect(self.path, timeout=20)
        con.row_factory = sqlite3.Row
        try:
            with con:
                yield con
        finally:
            con.close()

    def init(self):
        with self.connection() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript("""
                CREATE TABLE IF NOT EXISTS objects (
                    kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL,
                    version INTEGER NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(kind,id));
                CREATE INDEX IF NOT EXISTS object_owner ON objects(kind,owner);
                CREATE TABLE IF NOT EXISTS sessions (
                    hash TEXT PRIMARY KEY, id TEXT NOT NULL, expires REAL NOT NULL);
            """)

    def create_session(self, hours):
        token = secrets.token_urlsafe(32)
        session_id = secrets.token_hex(16)
        expires = time.time() + hours * 3600
        with self.connection() as c:
            c.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            c.execute("INSERT INTO sessions VALUES (?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), session_id, expires))
        return token, session_id, expires

    def session(self, token):
        with self.connection() as c:
            row = c.execute("SELECT id FROM sessions WHERE hash=? AND expires>?", (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return row["id"] if row else None

    def put(self, kind, key, owner, payload, expected=None):
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        with self.connection() as c:
            if expected is None:
                c.execute("INSERT INTO objects VALUES (?,?,?,?,?)", (kind, key, owner, 1, encoded))
                return 1
            result = c.execute("UPDATE objects SET payload=?,version=version+1 WHERE kind=? AND id=? AND owner=? AND version=?", (encoded, kind, key, owner, expected))
            if result.rowcount != 1:
                raise Conflict()
        return expected + 1

    def get(self, kind, key, owner):
        with self.connection() as c:
            row = c.execute("SELECT * FROM objects WHERE kind=? AND id=? AND (owner=? OR owner='public')", (kind, key, owner)).fetchone()
        return self.decode(row) if row else None

    def list(self, kind, owner):
        with self.connection() as c:
            rows = c.execute("SELECT * FROM objects WHERE kind=? AND (owner=? OR owner='public') ORDER BY rowid DESC", (kind, owner)).fetchall()
        return [self.decode(row) for row in rows]

    @staticmethod
    def decode(row):
        return {"id": row["id"], "owner": row["owner"], "version": row["version"], "payload": json.loads(row["payload"])}

    def interrupt_imports(self):
        with self.connection() as c:
            rows = c.execute("SELECT * FROM objects WHERE kind='import'").fetchall()
            for row in rows:
                p = json.loads(row["payload"])
                if p["status"] in ("queued", "running"):
                    p.update(status="interrupted", error="Процесс перезапущен. Загрузите тот же комплект повторно.")
                    c.execute("UPDATE objects SET payload=?,version=version+1 WHERE kind='import' AND id=?", (json.dumps(p, ensure_ascii=False), row["id"]))
