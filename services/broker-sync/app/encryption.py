"""Mirrors src/lib/encryption/broker-keys.ts exactly:
AES-256-GCM, ciphertext = (encrypted bytes || 16-byte auth tag) hex-encoded
as one string, IV stored separately (also hex). cryptography's AESGCM
expects data = ciphertext || tag concatenated, which is exactly the shape
Node produced — no reassembly needed beyond the hex decode.

Decrypt only in memory, only when actively making a broker API call.
NEVER log the return value.
"""

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import settings


def _get_key() -> bytes:
    key_hex = settings.encryption_key
    if len(key_hex) != 64:
        raise ValueError(
            "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) — "
            "and must match the Next.js app's key exactly."
        )
    return bytes.fromhex(key_hex)


def decrypt(ciphertext_hex: str, iv_hex: str) -> str:
    key = _get_key()
    iv = bytes.fromhex(iv_hex)
    combined = bytes.fromhex(ciphertext_hex)  # ciphertext || auth_tag

    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, combined, None)
    return plaintext.decode("utf-8")
