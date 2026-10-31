"""Password hashing with scrypt (stdlib). Format: scrypt$<salt b64>$<key b64>,
the same format the earlier Node.js version wrote, so existing accounts keep working."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os

N, R, P, KEY_LEN = 16384, 8, 1, 64
MIN_PASSWORD_LENGTH = 10


def _scrypt(password: str, salt: bytes, length: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, dklen=length, maxmem=64 * 1024 * 1024)


async def hash_password(password: str) -> str:
    salt = os.urandom(16)
    key = await asyncio.to_thread(_scrypt, password, salt, KEY_LEN)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(key).decode()}"


async def verify_password(password: str, stored: str | None) -> bool:
    try:
        scheme, salt_b64, key_b64 = (stored or "").split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(key_b64)
        actual = await asyncio.to_thread(_scrypt, password, base64.b64decode(salt_b64), len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(expected, actual)


# Compared against when the email is unknown, so timing does not reveal which
# emails have accounts.
DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + base64.b64encode(bytes(64)).decode()


def password_problem(password: object, email: str) -> str | None:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters for your password."
    if len(password) > 200:
        return "That password is too long."
    if password.lower() == email.lower():
        return "Your password cannot be your email address."
    return None
