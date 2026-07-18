import os

# Settings() is instantiated at import time in app.config, so these must
# be set before any `app.*` module is imported anywhere in the test run.
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
os.environ.setdefault("ENCRYPTION_KEY", "a" * 64)
os.environ.setdefault("UPSTASH_REDIS_REST_URL", "https://example.upstash.io")
os.environ.setdefault("UPSTASH_REDIS_REST_TOKEN", "test-token")
os.environ.setdefault("PYTHON_SERVICE_API_KEY", "test-api-key")


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """One `supabase.table(x)....execute()` call. Records what it was
    asked to do so tests can assert on it, and answers `select` calls
    from FakeSupabase.select_responses — everything else (update/upsert/
    delete/insert) just gets recorded, since sync_service never reads
    their `.execute()` result.
    """

    def __init__(self, table: str, client: "FakeSupabase"):
        self.table_name = table
        self.client = client
        self.op = None
        self.columns = None
        self.values = None
        self.rows = None
        self.on_conflict = None
        self.filters: list[tuple] = []
        self._single = False
        self._maybe_single = False
        self._order = None

    def select(self, columns):
        self.op = "select"
        self.columns = columns
        return self

    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        return self

    def neq(self, col, val):
        self.filters.append(("neq", col, val))
        return self

    def limit(self, n):
        return self

    def update(self, values):
        self.op = "update"
        self.values = values
        return self

    def insert(self, values):
        self.op = "insert"
        self.values = values
        return self

    def upsert(self, rows, on_conflict=None):
        self.op = "upsert"
        self.rows = rows
        self.on_conflict = on_conflict
        return self

    def delete(self):
        self.op = "delete"
        return self

    def in_(self, col, vals):
        self.filters.append(("in_", col, vals))
        return self

    def single(self):
        self._single = True
        return self

    def maybe_single(self):
        # Real supabase-py's maybe_single differs from single() only in
        # not raising on zero rows — this fake's single() never raised on
        # zero rows to begin with, so behaviourally they're the same here.
        # Kept as a distinct flag (not aliased to _single) so a test
        # asserting on which one was called can still tell them apart.
        self._maybe_single = True
        return self

    def order(self, col, desc=False):
        self._order = (col, desc)
        return self

    def execute(self):
        self.client.calls.append(self)
        if self.op == "select":
            data = self.client.select_responses.get((self.table_name, self.columns), [])
            if self._single or self._maybe_single:
                return FakeResult(data[0] if data else None)
            return FakeResult(data)
        if self.op == "insert":
            responses = self.client.insert_responses
            if self.table_name in responses:
                return FakeResult(responses[self.table_name])
            # Auto-synthesize a row with a fake id so code doing
            # `.data[0]["id"]` after an insert works without needing
            # this configured per-test for the common case.
            rows = self.values if isinstance(self.values, list) else [self.values]
            synthesized = [{**row, "id": row.get("id", f"fake-id-{len(self.client.calls)}")} for row in rows]
            return FakeResult(synthesized)
        return FakeResult(None)


class FakeSupabase:
    """Stand-in for the real supabase-py Client. `select_responses` maps
    (table_name, columns_string) -> the `.data` a matching select should
    return; every call (select or otherwise) is appended to `calls` for
    assertions.
    """

    def __init__(self):
        self.calls: list[FakeQuery] = []
        self.select_responses: dict[tuple, list] = {}
        self.insert_responses: dict[str, list] = {}

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(name, self)

    def calls_for(self, table_name: str, op: str | None = None) -> list[FakeQuery]:
        return [c for c in self.calls if c.table_name == table_name and (op is None or c.op == op)]
