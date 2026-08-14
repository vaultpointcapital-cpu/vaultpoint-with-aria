from app import observability


def test_init_sentry_is_noop_without_dsn(monkeypatch):
    init_calls = []
    monkeypatch.setattr(observability.settings, "sentry_dsn", None)
    monkeypatch.setattr(observability.sentry_sdk, "init", lambda **kwargs: init_calls.append(kwargs))

    observability.init_sentry()

    assert init_calls == []


def test_init_sentry_initializes_when_dsn_set(monkeypatch):
    init_calls = []
    monkeypatch.setattr(observability.settings, "sentry_dsn", "https://example@sentry.io/1")
    monkeypatch.setattr(observability.sentry_sdk, "init", lambda **kwargs: init_calls.append(kwargs))
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "staging")
    monkeypatch.setenv("RAILWAY_GIT_COMMIT_SHA", "deadbeef")

    observability.init_sentry()

    assert len(init_calls) == 1
    call = init_calls[0]
    assert call["dsn"] == "https://example@sentry.io/1"
    assert call["traces_sample_rate"] == 0.0
    assert call["environment"] == "staging"
    assert call["release"] == "deadbeef"


def test_init_sentry_defaults_environment_outside_railway(monkeypatch):
    init_calls = []
    monkeypatch.setattr(observability.settings, "sentry_dsn", "https://example@sentry.io/1")
    monkeypatch.setattr(observability.sentry_sdk, "init", lambda **kwargs: init_calls.append(kwargs))
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_NAME", raising=False)

    observability.init_sentry()

    assert init_calls[0]["environment"] == "development"
