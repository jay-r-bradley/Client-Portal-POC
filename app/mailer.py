"""Outgoing email: one-time sign-in codes and account notices.

Providers: console (development: printed to the server log), smtp (any SMTP
server: Zoho Mail, ZeptoMail SMTP, Amazon SES...), zeptomail (Zoho ZeptoMail
HTTP API)."""

from __future__ import annotations

import asyncio
import html
import logging
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage

import httpx

from .config import MailSettings

log = logging.getLogger("portal.mail")


class MailError(Exception):
    pass


@dataclass
class Email:
    to: str
    subject: str
    text: str
    html: str


@dataclass
class Mailer:
    settings: MailSettings
    outbox: list[Email] = field(default_factory=list)  # console provider only, for demos and tests

    async def send(self, email: Email) -> None:
        provider = self.settings.provider
        if provider == "console":
            self.outbox.append(email)
            del self.outbox[:-50]
            log.warning("[console mailer] To %s — %s\n%s", email.to, email.subject, email.text)
        elif provider == "smtp":
            await asyncio.to_thread(self._send_smtp, email)
        elif provider == "zeptomail":
            await self._send_zeptomail(email)
        else:
            raise MailError(f"Unknown MAIL_PROVIDER {provider!r}")

    def _send_smtp(self, email: Email) -> None:
        s = self.settings
        msg = EmailMessage()
        msg["From"] = f"{s.from_name} <{s.from_address}>"
        msg["To"] = email.to
        msg["Subject"] = email.subject
        msg.set_content(email.text)
        msg.add_alternative(email.html, subtype="html")
        try:
            with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=s.timeout_seconds) as smtp:
                smtp.starttls(context=ssl.create_default_context())
                if s.smtp_username:
                    smtp.login(s.smtp_username, s.smtp_password or "")
                smtp.send_message(msg)
        except (OSError, smtplib.SMTPException) as err:
            raise MailError(f"SMTP send failed: {type(err).__name__}") from err

    async def _send_zeptomail(self, email: Email) -> None:
        s = self.settings
        try:
            async with httpx.AsyncClient(timeout=s.timeout_seconds) as http:
                res = await http.post(s.zeptomail_url, headers={"Authorization": f"Zoho-enczapikey {s.zeptomail_token}"}, json={
                    "from": {"address": s.from_address, "name": s.from_name},
                    "to": [{"email_address": {"address": email.to}}],
                    "subject": email.subject, "htmlbody": email.html, "textbody": email.text,
                })
        except httpx.HTTPError as err:
            raise MailError(f"ZeptoMail request failed: {type(err).__name__}") from err
        if res.status_code >= 400:
            raise MailError(f"ZeptoMail returned {res.status_code}")


PURPOSE_TEXT = {
    "login": ("Your sign-in code", "Use this code to finish signing in"),
    "signup": ("Confirm your email", "Use this code to confirm your email and create your account"),
    "password_reset": ("Reset your password", "Use this code to reset your password"),
}


def otp_email(*, to: str, code: str, purpose: str, brand: str, minutes: int) -> Email:
    subject, lead = PURPOSE_TEXT[purpose]
    text = (f"{lead} on {brand}:\n\n    {code}\n\nThe code expires in {minutes} minutes. "
            "If you didn't request it, you can ignore this email; your account is safe. Never share this code with anyone, "
            "including our staff.")
    body = (f"<p>{html.escape(lead)} on {html.escape(brand)}:</p>"
            f"<p style=\"font-size:28px;font-weight:700;letter-spacing:6px\">{code}</p>"
            f"<p>The code expires in {minutes} minutes. If you didn't request it, you can ignore this email; your account is safe. "
            "Never share this code with anyone, including our staff.</p>")
    return Email(to=to, subject=f"{brand}: {subject}", text=text, html=body)
