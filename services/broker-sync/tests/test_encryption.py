"""Cross-language compatibility check: this fixture was produced by the
real Node.js algorithm (same steps as src/lib/encryption/broker-keys.ts —
aes-256-gcm, IV||nothing separate, ciphertext = encrypted||authTag hex),
not reverse-engineered from the Python side. If this test passes, the
Python decrypt() is byte-for-byte compatible with what the Next.js app
actually writes to broker_connections.
"""

from app.encryption import decrypt

FIXTURE_KEY_HEX = "a" * 64
FIXTURE_PLAINTEXT = "test-api-key-12345"
FIXTURE_CIPHERTEXT_HEX = "9b42359fc7aca9ad0ebd017a70db1062a63046f92a09537b447088c50df631889f62"
FIXTURE_IV_HEX = "dcef0fb7fa26ca7c992d5809cb1586ba"


def test_decrypt_matches_node_generated_fixture(monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY", FIXTURE_KEY_HEX)
    from app.config import Settings

    monkeypatch.setattr("app.encryption.settings", Settings())

    result = decrypt(FIXTURE_CIPHERTEXT_HEX, FIXTURE_IV_HEX)
    assert result == FIXTURE_PLAINTEXT


def test_decrypt_raises_on_tampered_ciphertext(monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY", FIXTURE_KEY_HEX)
    from app.config import Settings

    monkeypatch.setattr("app.encryption.settings", Settings())

    tampered = "0" + FIXTURE_CIPHERTEXT_HEX[1:]
    try:
        decrypt(tampered, FIXTURE_IV_HEX)
        assert False, "expected decrypt to raise on a tampered ciphertext"
    except Exception:
        pass
