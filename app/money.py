"""Small currency formatter for server-written text (Zoho Lead descriptions)."""

from __future__ import annotations

SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "AUD": "A$", "CAD": "CA$", "NZD": "NZ$", "PHP": "₱", "INR": "₹", "SGD": "S$", "AED": "AED "}


def money(amount: float | int, currency: str) -> str:
    return f"{SYMBOLS.get(currency, currency + ' ')}{round(amount):,}"
