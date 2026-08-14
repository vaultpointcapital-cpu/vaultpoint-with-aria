"""Insert one broker_connections row into a STAGING Supabase project for
the deploy smoke test in RUNBOOK.md. Not part of the running service —
run this manually, once, against staging only.

Secrets (api key/secret/passphrase/MT password) are read from stdin via
getpass, never argv or an env var file, so they never land in shell
history, a process list (`ps aux`), or a log line. Only non-secret
metadata (user id, broker, label, MT login/server) is accepted as flags.

Usage:
    python scripts/staging_seed_connection.py --user-id <uuid> --broker bybit --label "Smoke test"
    python scripts/staging_seed_connection.py --user-id <uuid> --broker kucoin --label "Smoke test"
    python scripts/staging_seed_connection.py --user-id <uuid> --broker metatrader --label "Smoke test" \\
        --mt-login 12345678 --mt-server "Exness-MT5Real8" --mt-platform mt5

Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY in the
environment — the same staging values set in Railway, exported locally
just for this one run. Never write them to a file in this repo.
"""

import argparse
import getpass
import os
import sys
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from supabase import create_client

IV_LENGTH = 16  # bytes — matches src/lib/encryption/broker-keys.ts exactly


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"error: {name} is not set in the environment", file=sys.stderr)
        sys.exit(1)
    return value


def _encrypt(plaintext: str, key: bytes) -> tuple[str, str]:
    """Returns (ciphertext_hex, iv_hex), same shape as the Node encrypt()."""
    iv = os.urandom(IV_LENGTH)
    aesgcm = AESGCM(key)
    combined = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)  # ciphertext || tag
    return combined.hex(), iv.hex()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--user-id", required=True, help="staging users.id (uuid) this connection belongs to")
    parser.add_argument("--broker", required=True, choices=["bybit", "binance", "kucoin", "metatrader"])
    parser.add_argument("--label", default="Staging smoke test")
    parser.add_argument("--mt-login", help="required for --broker metatrader")
    parser.add_argument("--mt-server", help="required for --broker metatrader")
    parser.add_argument("--mt-platform", choices=["mt4", "mt5"], help="required for --broker metatrader")
    args = parser.parse_args()

    try:
        uuid.UUID(args.user_id)
    except ValueError:
        print("error: --user-id must be a valid uuid", file=sys.stderr)
        sys.exit(1)

    supabase_url = _require_env("SUPABASE_URL")
    supabase_key = _require_env("SUPABASE_SERVICE_ROLE_KEY")
    encryption_key_hex = _require_env("ENCRYPTION_KEY")
    if len(encryption_key_hex) != 64:
        print("error: ENCRYPTION_KEY must be exactly 64 hex characters", file=sys.stderr)
        sys.exit(1)
    encryption_key = bytes.fromhex(encryption_key_hex)

    if not supabase_url.rstrip("/").endswith(".supabase.co") and "localhost" not in supabase_url:
        print(f"warning: SUPABASE_URL doesn't look like a hosted project ({supabase_url}) — continuing anyway")
    print(f"Target Supabase project: {supabase_url}")
    print("Confirm this is your STAGING project, not production.")
    if input("Type 'staging' to continue: ").strip() != "staging":
        print("Aborted.")
        sys.exit(1)

    row: dict[str, object] = {
        "user_id": args.user_id,
        "broker": args.broker,
        "label": args.label,
        "is_read_only": True,
    }

    if args.broker == "metatrader":
        if not (args.mt_login and args.mt_server and args.mt_platform):
            print("error: --mt-login, --mt-server, --mt-platform are required for --broker metatrader", file=sys.stderr)
            sys.exit(1)
        mt_password = getpass.getpass("MT investor (read-only) password: ")
        ciphertext, iv = _encrypt(mt_password, encryption_key)
        row.update(
            {
                "mt_login": args.mt_login,
                "mt_server": args.mt_server,
                "mt_platform": args.mt_platform,
                "encrypted_mt_password": ciphertext,
                "mt_password_iv": iv,
            }
        )
    else:
        api_key = getpass.getpass("API key: ")
        api_secret = getpass.getpass("API secret: ")
        key_ciphertext, key_iv = _encrypt(api_key, encryption_key)
        secret_ciphertext, secret_iv = _encrypt(api_secret, encryption_key)
        row.update(
            {
                "encrypted_api_key": key_ciphertext,
                "api_key_iv": key_iv,
                "encrypted_api_secret": secret_ciphertext,
                "api_secret_iv": secret_iv,
            }
        )
        if args.broker == "kucoin":
            passphrase = getpass.getpass("API passphrase: ")
            passphrase_ciphertext, passphrase_iv = _encrypt(passphrase, encryption_key)
            row["encrypted_api_passphrase"] = passphrase_ciphertext
            row["api_passphrase_iv"] = passphrase_iv

    client = create_client(supabase_url, supabase_key)
    result = client.table("broker_connections").insert(row).execute()
    inserted_id = result.data[0]["id"]
    print(f"Inserted broker_connections row: {inserted_id} (broker={args.broker}, user_id={args.user_id})")


if __name__ == "__main__":
    main()
