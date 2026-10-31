"""One-time codes: 6 random digits, stored only as a keyed hash."""

from __future__ import annotations

import hashlib
import hmac
import secrets


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_code(code: str, *, challenge_id: str, secret: str) -> str:
    # Keyed and bound to the challenge, so a leaked hash cannot be reused or brute-forced offline.
    return hmac.new(secret.encode(), f"{challenge_id}:{code}".encode(), hashlib.sha256).hexdigest()


def code_matches(code: str, *, challenge_id: str, secret: str, expected_hash: str) -> bool:
    if not code.isdigit() or len(code) != 6:
        return False
    return hmac.compare_digest(hash_code(code, challenge_id=challenge_id, secret=secret), expected_hash)


def mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}{'•' * max(1, len(local) - len(visible))}@{domain}"
