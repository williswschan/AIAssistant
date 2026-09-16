"""
Tech Cafe AI Helpdesk — Flask backend.

- Mints short-lived Azure Realtime credentials for browser WebRTC voice.
- Runs gpt-6-astra diagnostics when the Realtime agent calls consult_helpdesk_expert.
Permanent AZURE_OPENAI_API_KEY never leaves the server.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import ipaddress
import json
import logging
import os
import re
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_sock import Sock

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="[%(levelname)s] %(message)s",
)
logger = logging.getLogger("techcafe")

AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY", "").strip()
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
AZURE_OPENAI_REALTIME_DEPLOYMENT = os.getenv(
    "AZURE_OPENAI_REALTIME_DEPLOYMENT", "gpt-realtime-2.1"
).strip()
AZURE_OPENAI_CHAT_DEPLOYMENT = os.getenv(
    "AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-6-astra"
).strip()
AZURE_OPENAI_VOICE = os.getenv("AZURE_OPENAI_VOICE", "cedar").strip()
AZURE_REASONING_EFFORT = os.getenv("AZURE_REASONING_EFFORT", "high").strip()
AZURE_INTERRUPT_RESPONSE = os.getenv("AZURE_INTERRUPT_RESPONSE", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
AZURE_VAD_THRESHOLD = float(os.getenv("AZURE_VAD_THRESHOLD", "0.5"))
AZURE_VAD_PREFIX_MS = int(os.getenv("AZURE_VAD_PREFIX_MS", "300"))
AZURE_VAD_SILENCE_MS = int(os.getenv("AZURE_VAD_SILENCE_MS", "900"))
# Realtime prompt cache is automatic (in-memory) when Azure supports it for the
# deployment — unlike gpt-5.5 there is no prompt_cache_retention=24h on Realtime.
# retention_ratio < 1 truncates in larger chunks so long calls bust the cache less often.
try:
    REALTIME_TRUNCATION_RETENTION_RATIO = float(
        os.getenv("REALTIME_TRUNCATION_RETENTION_RATIO", "0.8")
    )
except ValueError:
    REALTIME_TRUNCATION_RETENTION_RATIO = 0.8
REALTIME_TRUNCATION_RETENTION_RATIO = max(
    0.0, min(1.0, REALTIME_TRUNCATION_RETENTION_RATIO)
)
PROMPT_CACHE_RETENTION = os.getenv("PROMPT_CACHE_RETENTION", "24h").strip() or "24h"
PROMPT_CACHE_WARMUP = os.getenv("PROMPT_CACHE_WARMUP", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
# Troubleshooting only — set false in production so call text is not written to disk.
TRANSCRIPT_LOGGING = os.getenv("TRANSCRIPT_LOGGING", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
# Optional Azure deployment for user-speech ASR (e.g. whisper / gpt-4o-transcribe).
# Assistant speech transcripts work without this; user text needs a transcription deployment.
AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT = os.getenv(
    "AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT", ""
).strip()
PROMPT_PATH = BASE_DIR / "techcafe_prompt.txt"
LOGS_DIR = BASE_DIR / "logs"
TRANSCRIPTS_DIR = LOGS_DIR / "transcripts"
TICKETS_DIR = LOGS_DIR / "tickets"
CLIENT_EVENTS_PATH = LOGS_DIR / "client-events.log"
_TRANSCRIPT_LOCK = threading.Lock()
_CLIENT_EVENT_LOCK = threading.Lock()
_TICKET_LOCK = threading.Lock()
_CALL_SESSIONS: dict[str, dict] = {}
_EXPERT_JOBS: dict[str, dict] = {}
_EXPERT_JOBS_LOCK = threading.Lock()
TICKET_CSV_FIELDS = [
    "caller_name",
    "ticket_creation_time",
    "started_at",
    "ended_at",
    "problem_summary",
    "solution_summary",
    "resolved",
]


def _append_client_event(event: str, detail: str = "") -> None:
    """Always-on breadcrumb log (works even when transcript logging is off)."""
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {event}"
    if detail:
        line += f" | {detail}"
    with _CLIENT_EVENT_LOCK:
        with CLIENT_EVENTS_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    logger.info("Client event %s %s", event, detail or "")


def _decode_b64url_json(raw: str) -> dict:
    """Decode URL-safe base64 JSON from a query string."""
    text = _as_text(raw)
    if not text:
        return {}
    pad = "=" * (-len(text) % 4)
    try:
        decoded = base64.urlsafe_b64decode(text + pad)
        parsed = json.loads(decoded.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid base64 JSON payload: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Payload must be a JSON object.")
    return parsed


def _as_text(value: object) -> str:
    """Coerce tool/JSON values to a safe stripped string."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False).strip()
        except Exception:
            return str(value).strip()
    return str(value).strip()


DIAGNOSE_TOOL = {
    "type": "function",
    "name": "consult_helpdesk_expert",
    "description": (
        "Consult the senior IT Help Desk diagnostic model (gpt-6-astra) for triage "
        "and next-step guidance. Use after you have the caller's name and a clear "
        "issue description. Use for non-trivial troubleshooting, Path A/B/C routing, "
        "Outlook/Teams/VPN/password/generic sign-in problems, and before recommending "
        "ServiceNow or Tech Cafe when the path is unclear. For a clear AD/account lockout, "
        "prefer offering simulated ServiceNow immediately rather than delaying the caller. "
        "Always pass known_facts and already_tried with everything the caller already confirmed "
        "so the specialist does not re-ask settled questions."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "caller_name": {
                "type": "string",
                "description": "Confirmed caller name, if known.",
            },
            "issue_summary": {
                "type": "string",
                "description": "Short summary of the reported IT problem.",
            },
            "symptoms": {
                "type": "string",
                "description": "Error messages, timing, scope, and environment details.",
            },
            "already_tried": {
                "type": "string",
                "description": (
                    "Steps the caller already attempted, plus troubleshooting already done "
                    "on this call (even if the caller did not 'try' them before calling)."
                ),
            },
            "known_facts": {
                "type": "string",
                "description": (
                    "Facts already confirmed on this call that must NOT be re-asked, e.g. "
                    "office vs remote, exact error text already stated, intranet works, "
                    "logged into Windows, VPN connected, device type. Comma-separated or short sentences."
                ),
            },
            "caller_language": {
                "type": "string",
                "description": (
                    "Language of the caller's latest spoken CONTENT — ignore English/"
                    "romanized personal names. Examples: English, Japanese, "
                    "Chinese (Mandarin), or Chinese (Cantonese)."
                ),
            },
        },
        "required": ["issue_summary"],
        "additionalProperties": False,
    },
}

END_CALL_TOOL = {
    "type": "function",
    "name": "end_call",
    "description": (
        "Hang up the Tech Cafe phone UI only AFTER you have spoken a complete "
        "polite goodbye that includes an explicit farewell word such as "
        "'Goodbye', 'さようなら', '再见', or '再見'. Never call this silently. "
        "Never skip goodbye. "
        "Do not call after only 'I'll book that' or 'let me set that up'. "
        "Use when the conversation is finished (resolved, caller done, "
        "or simulated booking/ticket closed). Speak farewell first, then call "
        "end_call. Always include call-outcome fields for the ticket CSV: "
        "caller_name, problem_summary, solution_summary, and resolved. "
        "Set resolved=false whenever the outcome is escalation "
        "(simulated ServiceNow ticket, Tech Cafe session/booking, or any "
        "handoff the caller still needs). Set resolved=true only when the "
        "issue was fixed on this call."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": (
                    "Short reason, e.g. resolved, caller_done, goodbye, "
                    "simulated_booking_complete, escalated_servicenow, "
                    "escalated_techcafe."
                ),
            },
            "caller_name": {
                "type": "string",
                "description": "Caller's confirmed name, or unknown if never collected.",
            },
            "problem_summary": {
                "type": "string",
                "description": "Short summary of the reported IT problem.",
            },
            "solution_summary": {
                "type": "string",
                "description": (
                    "What fixed the issue, OR the alternative provided "
                    "(e.g. simulated ServiceNow ticket, Tech Cafe session booking). "
                    "Always fill this even when resolved=false."
                ),
            },
            "resolved": {
                "type": "boolean",
                "description": (
                    "true only if the issue was solved on this call. "
                    "false if escalated to ServiceNow, Tech Cafe session, "
                    "or any other follow-up the caller still needs."
                ),
            },
        },
        "required": [
            "reason",
            "caller_name",
            "problem_summary",
            "solution_summary",
            "resolved",
        ],
        "additionalProperties": False,
    },
}

app = Flask(__name__)
sock = Sock(app)


def get_azure_resource_root() -> str:
    """Normalize endpoint to https://{resource}.openai.azure.com"""
    endpoint = AZURE_OPENAI_ENDPOINT.rstrip("/")
    if not endpoint:
        raise ValueError("AZURE_OPENAI_ENDPOINT is not configured.")
    lowered = endpoint.lower()
    if lowered.endswith("/openai/v1"):
        return endpoint[: -len("/openai/v1")]
    if lowered.endswith("/openai"):
        return endpoint[: -len("/openai")]
    return endpoint


def load_helpdesk_prompt() -> str:
    if not PROMPT_PATH.exists():
        raise FileNotFoundError(f"Missing prompt file: {PROMPT_PATH}")
    text = PROMPT_PATH.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("techcafe_prompt.txt is empty.")
    return text


def build_session_config(instructions: str) -> dict:
    """GA Realtime session payload for Azure client_secrets."""
    audio_input: dict = {
        "turn_detection": None,  # browser enables VAD after greeting playback
    }
    # User ASR is optional; requires a separate Azure transcription deployment name.
    if TRANSCRIPT_LOGGING and AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT:
        audio_input["transcription"] = {
            "model": AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT,
        }
    # Cache-friendly truncation: drop a larger chunk when the context fills so
    # the stable instructions/tools prefix stays cacheable across more turns.
    truncation: dict | str
    if REALTIME_TRUNCATION_RETENTION_RATIO >= 0.999:
        truncation = "auto"
    else:
        truncation = {
            "type": "retention_ratio",
            "retention_ratio": REALTIME_TRUNCATION_RETENTION_RATIO,
        }
    return {
        "session": {
            "type": "realtime",
            "model": AZURE_OPENAI_REALTIME_DEPLOYMENT,
            "instructions": instructions,
            "tools": [DIAGNOSE_TOOL, END_CALL_TOOL],
            "tool_choice": "auto",
            "truncation": truncation,
            "reasoning": {
                "effort": AZURE_REASONING_EFFORT,
            },
            "audio": {
                "input": audio_input,
                "output": {
                    "voice": AZURE_OPENAI_VOICE,
                },
            },
        }
    }


def ensure_transcript_dirs() -> None:
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)


def ensure_ticket_dirs() -> None:
    TICKETS_DIR.mkdir(parents=True, exist_ok=True)


def _new_call_id() -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"call-{stamp}-{os.urandom(2).hex()}"


def register_call_session(call_id: str | None = None) -> str:
    """Track server-side started_at for the upcoming call ticket CSV."""
    ensure_ticket_dirs()
    session_id = (call_id or "").strip() or _new_call_id()
    started = datetime.now().isoformat(timespec="seconds")
    with _TICKET_LOCK:
        _CALL_SESSIONS[session_id] = {
            "started_at": started,
            "caller_name": "",
            "problem_summary": "",
            "solution_summary": "",
            "resolved": None,
            "ticket_file": None,
            "written": False,
        }
    logger.info("Call session registered call_id=%s started_at=%s", session_id, started)
    return session_id


def _coerce_resolved(value: object) -> str:
    """Normalize resolved to CSV True/False; blank if unknown."""
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return "True" if value else "False"
    text = str(value).strip().lower()
    if text in ("true", "1", "yes", "y"):
        return "True"
    if text in ("false", "0", "no", "n"):
        return "False"
    return ""


def infer_ticket_fields_from_transcript(transcript_id: str) -> dict:
    """
    Best-effort fill when the model only put a narrative in end_call.reason.
    Reads consult tool args + end_call reason + booking/escalation cues.
    """
    inferred: dict = {}
    try:
        path = transcript_path_for_id(transcript_id)
    except ValueError:
        return inferred
    if not path.exists():
        return inferred
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not read transcript for ticket backfill: %s", exc)
        return inferred

    for match in re.finditer(
        r"TOOL \(consult_helpdesk_expert\):\s*(\{.*\})",
        text,
    ):
        try:
            data = json.loads(match.group(1))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        if _as_text(data.get("caller_name")):
            inferred["caller_name"] = _as_text(data.get("caller_name"))
        if _as_text(data.get("issue_summary")):
            inferred["problem_summary"] = _as_text(data.get("issue_summary"))

    end_reasons: list[str] = []
    for match in re.finditer(r"TOOL \(end_call\):\s*(.+)", text):
        raw = match.group(1).strip()
        if not raw:
            continue
        if raw.startswith("{"):
            try:
                data = json.loads(raw)
                if isinstance(data, dict):
                    if _as_text(data.get("caller_name")):
                        inferred["caller_name"] = _as_text(data.get("caller_name"))
                    if _as_text(data.get("problem_summary")):
                        inferred["problem_summary"] = _as_text(
                            data.get("problem_summary")
                        )
                    if _as_text(data.get("solution_summary")):
                        inferred["solution_summary"] = _as_text(
                            data.get("solution_summary")
                        )
                    if "resolved" in data and data.get("resolved") is not None:
                        inferred["resolved"] = data.get("resolved")
                    if _as_text(data.get("reason")):
                        end_reasons.append(_as_text(data.get("reason")))
                    continue
            except Exception:
                pass
        end_reasons.append(raw)

    if end_reasons and not inferred.get("solution_summary"):
        inferred["solution_summary"] = end_reasons[-1]

    lowered = text.lower()
    escalated = (
        "servicenow" in lowered
        or "tech cafe booking" in lowered
        or "tech cafe session" in lowered
        or "simulated tech cafe" in lowered
        or "not resolved" in lowered
        or "escalat" in lowered
    )
    if inferred.get("resolved") is None and escalated:
        inferred["resolved"] = False
    return inferred


def update_call_ticket_fields(call_id: str, payload: dict) -> dict:
    """Merge agent-provided outcome fields into the in-memory call session."""
    session_id = (call_id or "").strip()
    if not session_id:
        raise ValueError("call_id is required")
    with _TICKET_LOCK:
        session = _CALL_SESSIONS.get(session_id)
        if session is None:
            session = {
                "started_at": datetime.now().isoformat(timespec="seconds"),
                "caller_name": "",
                "problem_summary": "",
                "solution_summary": "",
                "resolved": None,
                "ticket_file": None,
                "written": False,
            }
            _CALL_SESSIONS[session_id] = session
        if "caller_name" in payload and _as_text(payload.get("caller_name")):
            session["caller_name"] = _as_text(payload.get("caller_name"))
        if "problem_summary" in payload and _as_text(payload.get("problem_summary")):
            session["problem_summary"] = _as_text(payload.get("problem_summary"))
        if "solution_summary" in payload and _as_text(payload.get("solution_summary")):
            session["solution_summary"] = _as_text(payload.get("solution_summary"))
        if "resolved" in payload and payload.get("resolved") is not None:
            session["resolved"] = payload.get("resolved")
        return dict(session)


def write_call_ticket_csv(call_id: str, payload: dict | None = None) -> dict:
    """
    Write one timestamped ticket CSV under logs/tickets/.
    Idempotent per call_id when content is already present; empty tickets can be rewritten.
    Server fills ticket_creation_time, started_at, and ended_at.
    """
    ensure_ticket_dirs()
    session_id = (call_id or "").strip()
    if not session_id:
        raise ValueError("call_id is required")
    if payload:
        update_call_ticket_fields(session_id, payload)

    # Backfill from transcript when the model omitted structured end_call fields.
    try:
        inferred = infer_ticket_fields_from_transcript(session_id)
        if inferred:
            update_call_ticket_fields(session_id, inferred)
    except Exception as exc:
        logger.warning("Ticket transcript backfill skipped: %s", exc)

    with _TICKET_LOCK:
        session = _CALL_SESSIONS.get(session_id)
        if session is None:
            session = {
                "started_at": datetime.now().isoformat(timespec="seconds"),
                "caller_name": "",
                "problem_summary": "",
                "solution_summary": "",
                "resolved": None,
                "ticket_file": None,
                "written": False,
            }
            _CALL_SESSIONS[session_id] = session

        has_content = bool(
            session.get("caller_name")
            or session.get("problem_summary")
            or session.get("solution_summary")
            or session.get("resolved") is not None
        )
        if session.get("written") and session.get("ticket_file"):
            existing_path = TICKETS_DIR / str(session["ticket_file"])
            file_has_content = False
            if existing_path.exists():
                try:
                    with existing_path.open("r", encoding="utf-8", newline="") as handle:
                        rows = list(csv.DictReader(handle))
                    if rows:
                        row0 = rows[0]
                        file_has_content = bool(
                            (row0.get("caller_name") or "").strip()
                            or (row0.get("problem_summary") or "").strip()
                            or (row0.get("solution_summary") or "").strip()
                            or (row0.get("resolved") or "").strip()
                        )
                except Exception:
                    file_has_content = False
            if file_has_content:
                return {
                    "ok": True,
                    "call_id": session_id,
                    "ticket_file": session["ticket_file"],
                    "already_written": True,
                }
            # Empty prior CSV: fall through and rewrite when we now have fields.
            if not has_content:
                return {
                    "ok": True,
                    "call_id": session_id,
                    "ticket_file": session["ticket_file"],
                    "already_written": True,
                }

        ended_at = datetime.now().isoformat(timespec="seconds")
        created_at = ended_at
        if session.get("ticket_file"):
            filename = session["ticket_file"]
            path = TICKETS_DIR / filename
        else:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            filename = f"ticket-{stamp}-{os.urandom(2).hex()}.csv"
            path = TICKETS_DIR / filename
        row = {
            "caller_name": session.get("caller_name") or "",
            "ticket_creation_time": created_at,
            "started_at": session.get("started_at") or created_at,
            "ended_at": ended_at,
            "problem_summary": session.get("problem_summary") or "",
            "solution_summary": session.get("solution_summary") or "",
            "resolved": _coerce_resolved(session.get("resolved")),
        }
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=TICKET_CSV_FIELDS)
            writer.writeheader()
            writer.writerow(row)
        session["written"] = True
        session["ticket_file"] = filename
        session["ended_at"] = ended_at

    logger.info("Ticket CSV written file=%s call_id=%s", filename, session_id)
    return {
        "ok": True,
        "call_id": session_id,
        "ticket_file": filename,
        "already_written": False,
        "row": row,
    }


def transcript_path_for_id(transcript_id: str) -> Path:
    """Resolve a safe transcript file path under logs/transcripts only."""
    safe_id = Path(str(transcript_id or "")).name
    if not safe_id or safe_id != transcript_id or ".." in safe_id:
        raise ValueError("Invalid transcript_id")
    if not safe_id.startswith("call-") or not safe_id.endswith(".txt"):
        raise ValueError("Invalid transcript_id")
    path = (TRANSCRIPTS_DIR / safe_id).resolve()
    if path.parent != TRANSCRIPTS_DIR.resolve():
        raise ValueError("Invalid transcript_id")
    return path


def create_transcript_file() -> dict:
    ensure_transcript_dirs()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # Short suffix avoids same-second collisions.
    suffix = os.urandom(2).hex()
    filename = f"call-{stamp}-{suffix}.txt"
    path = TRANSCRIPTS_DIR / filename
    started = datetime.now().isoformat(timespec="seconds")
    header = (
        "=== Tech Cafe AI Helpdesk call transcript ===\n"
        f"started: {started}\n"
        f"realtime: {AZURE_OPENAI_REALTIME_DEPLOYMENT}\n"
        f"chat: {AZURE_OPENAI_CHAT_DEPLOYMENT}\n"
        f"voice: {AZURE_OPENAI_VOICE}\n"
        f"user_asr: {AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT or 'disabled'}\n"
        "---\n"
    )
    path.write_text(header, encoding="utf-8")
    logger.info("Transcript started file=%s", filename)
    return {"transcript_id": filename, "path": str(path)}


def append_transcript_line(transcript_id: str, role: str, text: str, event: str = "") -> None:
    path = transcript_path_for_id(transcript_id)
    if not path.exists():
        raise FileNotFoundError(f"Transcript not found: {transcript_id}")
    stamp = datetime.now().strftime("%H:%M:%S")
    role_label = (role or "SYSTEM").strip().upper()
    body = (text or "").replace("\r\n", "\n").strip()
    if len(body) > 4000:
        body = body[:4000] + " …[truncated]"
    event_bit = f" ({event})" if event else ""
    line = f"[{stamp}] {role_label}{event_bit}: {body}\n" if body else f"[{stamp}] {role_label}{event_bit}\n"
    with _TRANSCRIPT_LOCK:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)


def close_transcript_file(transcript_id: str) -> None:
    path = transcript_path_for_id(transcript_id)
    if not path.exists():
        return
    ended = datetime.now().isoformat(timespec="seconds")
    with _TRANSCRIPT_LOCK:
        with path.open("a", encoding="utf-8") as handle:
            handle.write("---\n")
            handle.write(f"ended: {ended}\n")
    logger.info("Transcript closed file=%s", transcript_id)


def mint_ephemeral_token(session_config: dict) -> str:
    """Create a short-lived Realtime client secret using the permanent API key."""
    root = get_azure_resource_root()
    url = f"{root}/openai/v1/realtime/client_secrets"
    headers = {
        "api-key": AZURE_OPENAI_API_KEY,
        "Content-Type": "application/json",
    }
    logger.info(
        "Minting ephemeral Realtime client secret for deployment=%s",
        AZURE_OPENAI_REALTIME_DEPLOYMENT,
    )
    response = requests.post(url, headers=headers, json=session_config, timeout=30)
    if response.status_code >= 400:
        detail = response.text[:500]
        # Older Realtime builds may reject retention_ratio truncation — retry with auto.
        session = session_config.get("session") if isinstance(session_config, dict) else None
        if (
            response.status_code == 400
            and isinstance(session, dict)
            and "truncation" in session
            and session.get("truncation") != "auto"
            and ("truncation" in detail.lower() or "retention" in detail.lower())
        ):
            logger.warning(
                "Realtime truncation config rejected; retrying with truncation=auto: %s",
                detail[:300],
            )
            retry_config = json.loads(json.dumps(session_config))
            retry_config["session"]["truncation"] = "auto"
            response = requests.post(url, headers=headers, json=retry_config, timeout=30)
            if response.status_code < 400:
                data = response.json()
                token = data.get("value") or (data.get("client_secret") or {}).get("value")
                if not token:
                    raise RuntimeError(
                        f"No ephemeral token in client_secrets response: {data}"
                    )
                return token
        logger.error(
            "client_secrets failed: status=%s body=%s",
            response.status_code,
            detail,
        )
        response.raise_for_status()

    data = response.json()
    token = data.get("value") or (data.get("client_secret") or {}).get("value")
    if not token:
        raise RuntimeError(f"No ephemeral token in client_secrets response: {data}")
    return token


def build_expert_system_prompt(helpdesk_rules: str) -> str:
    """Stable system prefix for diagnose calls (kept identical for prompt caching)."""
    return (
        "You are the senior enterprise IT Help Desk diagnostic expert supporting a "
        "live phone agent. Follow the Tech Cafe triage rules below.\n\n"
        f"{helpdesk_rules}\n\n"
        "Return concise JSON only (no markdown) with this shape:\n"
        "{\n"
        '  "path": "remote" | "servicenow" | "techcafe",\n'
        '  "next_questions": ["..."],\n'
        '  "next_actions": ["one step at a time guidance"],\n'
        '  "speak_to_caller": "short phone-style coaching for what the voice agent should say next",\n'
        '  "notes": "optional internal note"\n'
        "}\n"
        "Keep speak_to_caller short and conversational for a phone call "
        "(usually 1-3 spoken sentences). "
        "Write speak_to_caller in the caller's latest spoken content language "
        "(English, Japanese, Mandarin, or Cantonese as given in caller_language — "
        "that field must reflect sentence content, not English-looking names). "
        "Ask at most 1-2 questions or give ONE action, then wait. "
        "Do not over-explain, recap solved steps, or narrate reasoning. "
        "ANTI-DOUBLE-ASK (critical): Treat issue_summary, symptoms, already_tried, and "
        "known_facts as already confirmed on the live call. "
        "Never put a question in next_questions or speak_to_caller that re-asks those facts "
        "(examples: office vs home, exact error text already stated, whether intranet works, "
        "whether they are logged into Windows, VPN status already given). "
        "If the error message is already known, do not ask them to read it again — "
        "advance to the next diagnostic step or next_action. "
        "Prefer one NEW next_action over re-asking settled context. "
        "Never repeat troubleshooting the caller already confirmed. "
        "If the issue is already resolved, only acknowledge briefly and ask if anything else is needed — "
        "do not restate the solution steps. "
        "If the caller reports AD/domain/Windows account lockout, set path to servicenow and "
        "coach an immediate simulated ServiceNow ticket offer — never invent backend checking or "
        "ask the caller to wait while you unlock the account. "
        "Never request passwords, MFA codes, or secrets. "
        "ServiceNow and Tech Cafe bookings remain simulated in this POC."
    )


def get_prompt_cache_key(helpdesk_rules: str) -> str:
    """Stable cache routing key; changes when techcafe_prompt.txt changes."""
    digest = hashlib.sha256(helpdesk_rules.encode("utf-8")).hexdigest()[:12]
    return f"techcafe-helpdesk-diagnose:{digest}"


def call_gpt55_diagnose(payload: dict, *, warmup: bool = False) -> dict:
    """Call Azure chat deployment (gpt-6-astra) for Help Desk diagnostics."""
    root = get_azure_resource_root()
    url = f"{root}/openai/v1/chat/completions"
    helpdesk_rules = load_helpdesk_prompt()
    system_prompt = build_expert_system_prompt(helpdesk_rules)
    cache_key = get_prompt_cache_key(helpdesk_rules)
    user_blob = {
        "caller_name": _as_text(payload.get("caller_name")),
        "issue_summary": _as_text(payload.get("issue_summary")),
        "symptoms": _as_text(payload.get("symptoms")),
        "already_tried": _as_text(payload.get("already_tried")),
        "known_facts": _as_text(payload.get("known_facts")),
        "caller_language": _as_text(payload.get("caller_language")) or "English",
    }
    # Stable system prefix first, variable case JSON last — required for cache hits.
    body = {
        "model": AZURE_OPENAI_CHAT_DEPLOYMENT,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    "Diagnose this live Help Desk call and recommend the NEXT phone step only.\n"
                    "Do not re-ask anything already present in known_facts, symptoms, "
                    "already_tried, or issue_summary.\n"
                    + json.dumps(user_blob, ensure_ascii=False)
                ),
            },
        ],
        "max_completion_tokens": 16 if warmup else 900,
        # gpt-5.5 and earlier: extended retention improves hit rate across calls.
        "prompt_cache_retention": PROMPT_CACHE_RETENTION,
        # Helps route related diagnose requests to the same cache shard when supported.
        "prompt_cache_key": cache_key,
    }
    headers = {
        "api-key": AZURE_OPENAI_API_KEY,
        "Content-Type": "application/json",
    }
    logger.info(
        "Calling chat diagnostic model=%s cache_key=%s retention=%s warmup=%s",
        AZURE_OPENAI_CHAT_DEPLOYMENT,
        cache_key,
        PROMPT_CACHE_RETENTION,
        warmup,
    )
    response = requests.post(url, headers=headers, json=body, timeout=60)
    if response.status_code >= 400:
        # Older API builds may reject unknown cache fields — retry without them once.
        detail = response.text[:800]
        if response.status_code == 400 and (
            "prompt_cache" in detail.lower() or "cache" in detail.lower()
        ):
            logger.warning(
                "chat diagnose cache params rejected; retrying without cache fields: %s",
                detail[:300],
            )
            body.pop("prompt_cache_retention", None)
            body.pop("prompt_cache_key", None)
            response = requests.post(url, headers=headers, json=body, timeout=60)
        if response.status_code >= 400:
            logger.error(
                "chat diagnose failed: status=%s body=%s",
                response.status_code,
                response.text[:800],
            )
            response.raise_for_status()

    data = response.json()
    usage = data.get("usage") or {}
    prompt_details = usage.get("prompt_tokens_details") or {}
    cached_tokens = prompt_details.get("cached_tokens", 0)
    logger.info(
        "Diagnose usage prompt_tokens=%s cached_tokens=%s completion_tokens=%s",
        usage.get("prompt_tokens"),
        cached_tokens,
        usage.get("completion_tokens"),
    )
    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
        .strip()
    )
    if warmup:
        return {
            "path": "remote",
            "next_questions": [],
            "next_actions": [],
            "speak_to_caller": "",
            "notes": "prompt_cache_warmup",
            "cached_tokens": cached_tokens,
        }
    if not content:
        raise RuntimeError("Empty diagnostic response from chat model.")

    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            parsed["_cached_tokens"] = cached_tokens
            return parsed
    except json.JSONDecodeError:
        # Model sometimes wraps JSON in prose — return as speak_to_caller.
        pass

    return {
        "path": "remote",
        "next_questions": [],
        "next_actions": [],
        "speak_to_caller": content,
        "notes": "unparsed_model_text",
        "_cached_tokens": cached_tokens,
    }


def _model_payload_from_request(payload: dict) -> tuple[dict, str]:
    """Build gpt-6-astra payload + optional transcript id from a JSON body."""
    model_payload = {
        "caller_name": _as_text(payload.get("caller_name")),
        "issue_summary": _as_text(payload.get("issue_summary")),
        "symptoms": _as_text(payload.get("symptoms")),
        "already_tried": _as_text(payload.get("already_tried")),
        "known_facts": _as_text(payload.get("known_facts")),
        "caller_language": _as_text(payload.get("caller_language")) or "English",
    }
    transcript_id = _as_text(payload.get("_transcript_id"))
    return model_payload, transcript_id


def _run_expert_job(job_id: str, model_payload: dict, transcript_id: str) -> None:
    """Background gpt-6-astra consult so the phone only needs short HTTP requests."""
    try:
        if TRANSCRIPT_LOGGING and transcript_id:
            try:
                append_transcript_line(
                    transcript_id,
                    "TOOL",
                    json.dumps(model_payload, ensure_ascii=False),
                    "consult_helpdesk_expert",
                )
            except Exception as exc:
                logger.warning("Could not append expert request to transcript: %s", exc)

        result = call_gpt55_diagnose(model_payload)
        cached_tokens = result.pop("_cached_tokens", None)
        if TRANSCRIPT_LOGGING and transcript_id:
            try:
                append_transcript_line(
                    transcript_id,
                    "TOOL_RESULT",
                    json.dumps(result, ensure_ascii=False),
                    f"path={result.get('path')}",
                )
            except Exception as exc:
                logger.warning("Could not append expert result to transcript: %s", exc)

        with _EXPERT_JOBS_LOCK:
            _EXPERT_JOBS[job_id] = {
                "status": "done",
                "ok": True,
                "model": AZURE_OPENAI_CHAT_DEPLOYMENT,
                "result": result,
                "cached_tokens": cached_tokens,
            }
        logger.info(
            "Expert job done id=%s path=%s cached_tokens=%s",
            job_id,
            result.get("path"),
            cached_tokens,
        )
    except Exception as exc:
        logger.exception("Expert job failed id=%s", job_id)
        with _EXPERT_JOBS_LOCK:
            _EXPERT_JOBS[job_id] = {
                "status": "error",
                "ok": False,
                "error": str(exc),
            }


def warm_diagnose_prompt_cache() -> None:
    """Prime Azure prompt cache so the first live call is more likely to hit."""
    if not AZURE_OPENAI_API_KEY or not AZURE_OPENAI_ENDPOINT:
        logger.warning("Skipping prompt cache warm-up (Azure not configured)")
        return
    try:
        logger.info("Warming gpt-6-astra diagnose prompt cache...")
        result = call_gpt55_diagnose(
            {
                "caller_name": "warmup",
                "issue_summary": "Internal prompt-cache warm-up (ignore).",
                "symptoms": "none",
                "already_tried": "none",
                "known_facts": "warmup only",
                "caller_language": "English",
            },
            warmup=True,
        )
        logger.info(
            "Prompt cache warm-up finished cached_tokens=%s",
            result.get("cached_tokens", 0),
        )
    except Exception as exc:
        logger.warning("Prompt cache warm-up failed: %s", exc)


@app.get("/")
def index():
    app_js_path = BASE_DIR / "static" / "app.js"
    app_js_version = str(int(app_js_path.stat().st_mtime)) if app_js_path.exists() else "1"
    return render_template("index.html", app_js_version=app_js_version)


@app.after_request
def _no_cache_app_js(response):
    if request.path.endswith("/static/app.js"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@app.get("/health")
def health():
    missing = []
    if not AZURE_OPENAI_API_KEY:
        missing.append("AZURE_OPENAI_API_KEY")
    if not AZURE_OPENAI_ENDPOINT:
        missing.append("AZURE_OPENAI_ENDPOINT")
    if missing:
        return jsonify({"ok": False, "missing": missing}), 500
    if not PROMPT_PATH.exists():
        return jsonify({"ok": False, "error": "techcafe_prompt.txt missing"}), 500
    return jsonify(
        {
            "ok": True,
            "realtime_deployment": AZURE_OPENAI_REALTIME_DEPLOYMENT,
            "chat_deployment": AZURE_OPENAI_CHAT_DEPLOYMENT,
            "voice": AZURE_OPENAI_VOICE,
            "reasoning_effort": AZURE_REASONING_EFFORT,
            "transcript_logging": TRANSCRIPT_LOGGING,
            "transcription_deployment": AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT or None,
            "realtime_truncation_retention_ratio": REALTIME_TRUNCATION_RETENTION_RATIO,
        }
    )


@app.get("/token")
def get_token():
    """
    Return a short-lived Azure Realtime credential for browser WebRTC.
    Permanent AZURE_OPENAI_API_KEY never leaves the server.
    """
    if not AZURE_OPENAI_API_KEY:
        logger.error("AZURE_OPENAI_API_KEY is not configured.")
        return jsonify({"error": "AZURE_OPENAI_API_KEY is not configured."}), 500
    if not AZURE_OPENAI_ENDPOINT:
        logger.error("AZURE_OPENAI_ENDPOINT is not configured.")
        return jsonify({"error": "AZURE_OPENAI_ENDPOINT is not configured."}), 500

    try:
        instructions = load_helpdesk_prompt()
        session_config = build_session_config(instructions)
        ephemeral_token = mint_ephemeral_token(session_config)
        root = get_azure_resource_root()
        webrtc_url = f"{root}/openai/v1/realtime/calls"
        transcript_id = None
        call_id = None
        if TRANSCRIPT_LOGGING:
            try:
                created = create_transcript_file()
                transcript_id = created["transcript_id"]
                call_id = register_call_session(transcript_id)
                append_transcript_line(
                    transcript_id,
                    "SYSTEM",
                    f"Call session opened (client={request.remote_addr})",
                    "token",
                )
            except Exception as exc:
                logger.warning("Could not create transcript for call: %s", exc)
        if not call_id:
            try:
                call_id = register_call_session()
            except Exception as exc:
                logger.warning("Could not register call session: %s", exc)
        logger.info(
            "Ephemeral token issued for browser WebRTC (transcript_logging=%s transcript_id=%s call_id=%s)",
            TRANSCRIPT_LOGGING,
            transcript_id,
            call_id,
        )
        return jsonify(
            {
                "token": ephemeral_token,
                "webrtc_url": webrtc_url,
                "deployment": AZURE_OPENAI_REALTIME_DEPLOYMENT,
                "chat_deployment": AZURE_OPENAI_CHAT_DEPLOYMENT,
                "voice": AZURE_OPENAI_VOICE,
                "transcript_logging": TRANSCRIPT_LOGGING,
                "transcript_id": transcript_id,
                "call_id": call_id,
                "transcription_deployment": AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT or None,
                "realtime_truncation_retention_ratio": REALTIME_TRUNCATION_RETENTION_RATIO,
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": AZURE_VAD_THRESHOLD,
                    "prefix_padding_ms": AZURE_VAD_PREFIX_MS,
                    "silence_duration_ms": AZURE_VAD_SILENCE_MS,
                    "create_response": True,
                    "interrupt_response": AZURE_INTERRUPT_RESPONSE,
                },
            }
        )
    except FileNotFoundError as exc:
        logger.error("%s", exc)
        return jsonify({"error": str(exc)}), 500
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        detail = exc.response.text[:300] if exc.response is not None else str(exc)
        logger.error("Azure HTTP error: %s", detail)
        return (
            jsonify(
                {
                    "error": "Unable to connect to the Tech Cafe AI service.",
                    "detail": detail,
                }
            ),
            status,
        )
    except Exception as exc:
        logger.exception("Token mint failed")
        return (
            jsonify(
                {
                    "error": "Unable to establish the voice session.",
                    "detail": str(exc),
                }
            ),
            502,
        )


@app.post("/api/transcript/start")
def transcript_start():
    """Create a timestamped transcript file for the current call (if enabled)."""
    if not TRANSCRIPT_LOGGING:
        call_id = register_call_session()
        return jsonify({"ok": True, "enabled": False, "call_id": call_id})
    try:
        created = create_transcript_file()
        call_id = register_call_session(created["transcript_id"])
        return jsonify(
            {
                "ok": True,
                "enabled": True,
                "transcript_id": created["transcript_id"],
                "call_id": call_id,
            }
        )
    except Exception as exc:
        logger.exception("Transcript start failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/transcript/append")
def transcript_append():
    """
    Append one spoken/tool line to an open transcript.

    Special case: role=TOOL_REQUEST + event=consult_helpdesk_expert starts a
    background GPT-5.5 job and returns job_id (used by iPhone — same path that
    already works for transcript lines, avoiding a second concurrent POST).
    """
    try:
        payload = request.get_json(force=True, silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON body must be an object."}), 400

        role = _as_text(payload.get("role")) or "SYSTEM"
        event = _as_text(payload.get("event"))
        text = payload.get("text")
        if text is None:
            text = ""
        transcript_id = _as_text(payload.get("transcript_id"))

        if role == "TOOL_REQUEST" and event == "consult_helpdesk_expert":
            return _expert_start_response(payload, text, transcript_id, via="append")

        if not TRANSCRIPT_LOGGING:
            return jsonify({"ok": True, "enabled": False})
        if not transcript_id:
            return jsonify({"error": "transcript_id is required."}), 400

        append_transcript_line(transcript_id, role, str(text), event)
        return jsonify({"ok": True})
    except ConnectionResetError:
        logger.warning("Transcript append aborted: client closed connection")
        return jsonify({"error": "Client closed connection."}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        logger.exception("Transcript append failed")
        return jsonify({"error": str(exc)}), 500


def _begin_expert_job(args: dict, transcript_id: str, via: str) -> dict:
    """
    Start a background GPT-5.5 job. Returns a dict with either
    {"ok": True, "job_id": ..., "status": "running"} or {"ok": False, "error": ...}.
    """
    if not AZURE_OPENAI_API_KEY or not AZURE_OPENAI_ENDPOINT:
        return {"ok": False, "error": "Azure OpenAI is not configured."}

    model_payload, resolved_transcript_id = _model_payload_from_request(args)
    if transcript_id and not resolved_transcript_id:
        resolved_transcript_id = transcript_id
    if resolved_transcript_id in ("none", "-", "null"):
        resolved_transcript_id = ""
    if not model_payload["issue_summary"]:
        return {"ok": False, "error": "issue_summary is required."}

    job_id = uuid.uuid4().hex[:12]
    with _EXPERT_JOBS_LOCK:
        _EXPERT_JOBS[job_id] = {"status": "running", "ok": True}
    logger.info(
        "Expert job start id=%s via=%s issue=%s",
        job_id,
        via,
        model_payload["issue_summary"][:120],
    )
    _append_client_event(
        "expert_start",
        f"job={job_id} via={via} issue={model_payload['issue_summary'][:80]}",
    )
    threading.Thread(
        target=_run_expert_job,
        args=(job_id, model_payload, resolved_transcript_id),
        name=f"expert-{job_id}",
        daemon=True,
    ).start()
    return {"ok": True, "job_id": job_id, "status": "running"}


def _expert_start_response(
    payload: dict,
    text: object,
    transcript_id: str,
    via: str = "post",
):
    """Shared HTTP starter for background consult jobs."""
    args: dict
    if isinstance(text, dict):
        args = dict(text)
    else:
        raw = _as_text(text) or "{}"
        try:
            parsed = json.loads(raw)
            args = parsed if isinstance(parsed, dict) else {"issue_summary": str(parsed)}
        except json.JSONDecodeError:
            args = {"issue_summary": raw}

    # Allow fields on the outer payload too.
    for key in (
        "caller_name",
        "issue_summary",
        "symptoms",
        "already_tried",
        "known_facts",
        "caller_language",
    ):
        if key in payload and payload.get(key) not in (None, ""):
            args[key] = payload.get(key)
    if transcript_id:
        args["_transcript_id"] = transcript_id

    result = _begin_expert_job(args, transcript_id, via)
    if not result.get("ok"):
        return jsonify({"error": result.get("error") or "Expert start failed."}), 400
    return jsonify(result)


@sock.route("/ws/control")
def ws_control(ws):
    """
    Persistent control channel for iPhone Brain consults.

    Safari/WebRTC often breaks same-origin fetch POST/GET mid-call; a single
    WSS opened at call start stays usable for expert_start + expert_status.
    """
    client = request.remote_addr or "?"
    logger.info("Control WebSocket connected client=%s", client)
    _append_client_event("ws_connected", f"client={client}")
    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except Exception:
                ws.send(json.dumps({"ok": False, "error": "invalid json"}))
                continue
            if not isinstance(msg, dict):
                ws.send(json.dumps({"ok": False, "error": "message must be an object"}))
                continue

            msg_id = msg.get("id")
            msg_type = _as_text(msg.get("type"))

            if msg_type == "ping":
                ws.send(json.dumps({"ok": True, "type": "pong", "id": msg_id}))
                continue

            if msg_type == "expert_start":
                args = msg.get("args") if isinstance(msg.get("args"), dict) else {}
                tid = _as_text(msg.get("transcript_id"))
                if tid:
                    args = {**args, "_transcript_id": tid}
                result = _begin_expert_job(args, tid, via="ws")
                result["id"] = msg_id
                result["type"] = "expert_start"
                ws.send(json.dumps(result))
                continue

            if msg_type == "expert_status":
                job_id = _as_text(msg.get("job_id"))
                with _EXPERT_JOBS_LOCK:
                    job = dict(_EXPERT_JOBS.get(job_id) or {})
                if not job:
                    ws.send(
                        json.dumps(
                            {
                                "ok": False,
                                "id": msg_id,
                                "type": "expert_status",
                                "status": "missing",
                                "error": "Unknown job_id",
                            }
                        )
                    )
                else:
                    ws.send(
                        json.dumps(
                            {
                                "ok": True,
                                "id": msg_id,
                                "type": "expert_status",
                                "job_id": job_id,
                                **job,
                            }
                        )
                    )
                continue

            ws.send(
                json.dumps(
                    {
                        "ok": False,
                        "id": msg_id,
                        "error": f"Unknown type: {msg_type}",
                    }
                )
            )
    except Exception as exc:
        logger.warning("Control WebSocket closed client=%s err=%s", client, exc)
    finally:
        logger.info("Control WebSocket disconnected client=%s", client)
        _append_client_event("ws_disconnected", f"client={client}")


@app.post("/api/transcript/end")
def transcript_end():
    """Close a transcript file with an ended timestamp; also finalize ticket CSV."""
    payload = request.get_json(silent=True) or {}
    transcript_id = (payload.get("transcript_id") or "").strip()
    call_id = (payload.get("call_id") or transcript_id or "").strip()
    ticket_result = None
    if call_id:
        try:
            ticket_result = write_call_ticket_csv(call_id, payload if isinstance(payload, dict) else None)
        except Exception as exc:
            logger.warning("Ticket finalize on transcript end failed: %s", exc)
    if not TRANSCRIPT_LOGGING:
        return jsonify({"ok": True, "enabled": False, "ticket": ticket_result})
    if not transcript_id:
        return jsonify({"error": "transcript_id is required.", "ticket": ticket_result}), 400
    try:
        close_transcript_file(transcript_id)
        return jsonify({"ok": True, "ticket": ticket_result})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("Transcript end failed")
        return jsonify({"error": str(exc)}), 500


@app.post("/api/ticket")
def ticket_upsert():
    """
    Store or finalize a per-call ticket CSV.
    Pass finalize=true (or omit fields-only update) to write logs/tickets/ticket-*.csv.
    Server fills ticket_creation_time, started_at, and ended_at.
    """
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON object required."}), 400
    call_id = _as_text(payload.get("call_id") or payload.get("transcript_id"))
    if not call_id:
        return jsonify({"error": "call_id is required."}), 400
    try:
        finalize = payload.get("finalize")
        if finalize is None:
            # Default: write CSV when outcome fields are present.
            finalize = any(
                key in payload
                for key in ("caller_name", "problem_summary", "solution_summary", "resolved")
            )
        if finalize:
            result = write_call_ticket_csv(call_id, payload)
        else:
            session = update_call_ticket_fields(call_id, payload)
            result = {"ok": True, "call_id": call_id, "session": session, "written": False}
        return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("Ticket upsert failed")
        return jsonify({"error": str(exc)}), 500


@app.post("/api/transcript/expert/start")
def expert_start():
    """
    Start a background GPT-5.5 consult and return immediately.
    Prefer GET /api/transcript/expert/start-get on iPhone (POST body often reset).
    """
    if not AZURE_OPENAI_API_KEY or not AZURE_OPENAI_ENDPOINT:
        return jsonify({"error": "Azure OpenAI is not configured."}), 500
    try:
        payload = request.get_json(force=True, silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON body must be an object."}), 400
        return _expert_start_response(
            payload,
            payload,
            _as_text(payload.get("_transcript_id")),
            via="post",
        )
    except ConnectionResetError:
        logger.warning("Expert start aborted: client closed connection while reading body")
        _append_client_event("expert_start_reset", "post body connection reset")
        return jsonify({"error": "Client closed connection."}), 400
    except Exception as exc:
        logger.exception("Expert start failed")
        return jsonify({"error": str(exc)}), 502


@app.get("/api/transcript/expert/start-get")
def expert_start_get():
    """
    Start expert job via GET + URL-safe base64 JSON (iPhone-safe).

    Safari/WebRTC on iPhone often resets concurrent/long POSTs to this Flask
    HTTPS server; GET requests already succeed (token, static, HEAD keepalives).
    Query: d=<base64url json args>, tid=<optional transcript id>
    """
    try:
        args = _decode_b64url_json(request.args.get("d", ""))
        transcript_id = _as_text(request.args.get("tid"))
        return _expert_start_response(args, args, transcript_id, via="get")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("Expert start-get failed")
        return jsonify({"error": str(exc)}), 502


@app.get("/api/client-log")
def client_log():
    """Browser breadcrumbs over GET so we see consult attempts even if POST dies."""
    event = _as_text(request.args.get("event")) or "ping"
    detail = _as_text(request.args.get("detail"))
    _append_client_event(event, detail)
    return jsonify({"ok": True})


@app.get("/api/transcript/expert/status/<job_id>")
def expert_status(job_id: str):
    """Poll background consult status (short requests — mobile-safe)."""
    safe_id = _as_text(job_id)
    with _EXPERT_JOBS_LOCK:
        job = dict(_EXPERT_JOBS.get(safe_id) or {})
    if not job:
        return jsonify({"ok": False, "status": "missing", "error": "Unknown job_id"}), 404
    return jsonify({"ok": True, **job, "job_id": safe_id})


@app.post("/api/helpdesk-consult")
@app.post("/api/diagnose")
def helpdesk_consult():
    """
    Synchronous consult (kept for compatibility / desktop).
    Prefer /api/transcript/expert/start + status on mobile WebRTC calls.
    """
    started = time.time()
    try:
        if not AZURE_OPENAI_API_KEY or not AZURE_OPENAI_ENDPOINT:
            logger.error("Diagnose rejected: Azure OpenAI is not configured")
            return jsonify({"error": "Azure OpenAI is not configured."}), 500

        payload = request.get_json(force=True, silent=True) or {}
        if not isinstance(payload, dict):
            logger.error("Diagnose rejected: JSON body must be an object")
            return jsonify({"error": "JSON body must be an object."}), 400

        model_payload, transcript_id = _model_payload_from_request(payload)
        issue_summary = model_payload["issue_summary"]
        logger.info(
            "Diagnose request received path=%s issue=%s transcript=%s",
            request.path,
            (issue_summary[:120] + "…") if len(issue_summary) > 120 else issue_summary,
            transcript_id or "-",
        )
        if not issue_summary:
            return jsonify({"error": "issue_summary is required."}), 400

        if TRANSCRIPT_LOGGING and transcript_id:
            try:
                append_transcript_line(
                    transcript_id,
                    "TOOL",
                    json.dumps(model_payload, ensure_ascii=False),
                    "consult_helpdesk_expert",
                )
            except Exception as exc:
                logger.warning("Could not append diagnose request to transcript: %s", exc)

        result = call_gpt55_diagnose(model_payload)
        cached_tokens = result.pop("_cached_tokens", None)
        elapsed_ms = int((time.time() - started) * 1000)
        logger.info(
            "Diagnose complete path=%s cached_tokens=%s elapsed_ms=%s",
            result.get("path"),
            cached_tokens,
            elapsed_ms,
        )
        if TRANSCRIPT_LOGGING and transcript_id:
            try:
                append_transcript_line(
                    transcript_id,
                    "TOOL_RESULT",
                    json.dumps(result, ensure_ascii=False),
                    f"path={result.get('path')}",
                )
            except Exception as exc:
                logger.warning("Could not append diagnose result to transcript: %s", exc)
        return jsonify(
            {
                "ok": True,
                "model": AZURE_OPENAI_CHAT_DEPLOYMENT,
                "result": result,
                "cached_tokens": cached_tokens,
            }
        )
    except ConnectionResetError:
        logger.warning("Diagnose aborted: client closed connection while reading body")
        return jsonify({"error": "Client closed connection."}), 400
    except requests.HTTPError as exc:
        detail = exc.response.text[:400] if exc.response is not None else str(exc)
        logger.error("Diagnose HTTP error: %s", detail)
        return jsonify({"error": "Diagnostic model request failed.", "detail": detail}), 502
    except Exception as exc:
        logger.exception("Diagnose failed")
        return jsonify({"error": "Diagnostic model failed.", "detail": str(exc)}), 502


def _local_ipv4_addresses() -> list[str]:
    addresses: list[str] = ["127.0.0.1"]
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in addresses:
                addresses.append(ip)
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        ip = probe.getsockname()[0]
        probe.close()
        if ip not in addresses:
            addresses.append(ip)
    except OSError:
        pass
    return addresses


def ensure_dev_ssl_certs() -> tuple[str, str]:
    """Resolve TLS cert/key paths for HTTPS (provided files or local self-signed)."""
    cert_dir = BASE_DIR / "certs"
    cert_dir.mkdir(parents=True, exist_ok=True)

    env_cert = os.getenv("FLASK_SSL_CERT", "").strip()
    env_key = os.getenv("FLASK_SSL_KEY", "").strip()
    if env_cert and env_key:
        cert_path = Path(env_cert)
        key_path = Path(env_key)
        if cert_path.is_file() and key_path.is_file():
            logger.info("Using TLS cert from env: %s", cert_path)
            return str(cert_path), str(key_path)
        raise FileNotFoundError(
            f"FLASK_SSL_CERT/KEY set but missing: cert={cert_path} key={key_path}"
        )

    # Prefer Let's Encrypt-style names when present (e.g. cloud VM).
    provided_cert = cert_dir / "fullchain.pem"
    provided_key = cert_dir / "privkey.pem"
    if provided_cert.is_file() and provided_key.is_file():
        logger.info("Using TLS cert from %s", provided_cert)
        return str(provided_cert), str(provided_key)

    cert_file = cert_dir / "dev-cert.pem"
    key_file = cert_dir / "dev-key.pem"
    if cert_file.exists() and key_file.exists():
        return str(cert_file), str(key_file)

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError as exc:
        raise RuntimeError(
            "HTTPS requires the cryptography package. Run: pip install cryptography"
        ) from exc

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "Tech Cafe AI Helpdesk Dev")]
    )
    alt_names = [
        x509.DNSName("localhost"),
        x509.DNSName("*.local"),
    ]
    for ip_text in _local_ipv4_addresses():
        try:
            alt_names.append(x509.IPAddress(ipaddress.ip_address(ip_text)))
        except ValueError:
            continue
    # Optional public DNS / IPs for cloud VMs (comma-separated).
    for host in os.getenv("FLASK_SSL_EXTRA_HOSTS", "").split(","):
        host = host.strip()
        if not host:
            continue
        try:
            alt_names.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            alt_names.append(x509.DNSName(host))

    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .sign(key, hashes.SHA256())
    )

    key_file.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    logger.info("Created development TLS cert at %s (SANs include LAN IPs)", cert_file)
    return str(cert_file), str(key_file)


if __name__ == "__main__":
    if not AZURE_OPENAI_API_KEY:
        logger.error("AZURE_OPENAI_API_KEY is not configured. Create a .env with AZURE_OPENAI_API_KEY.")
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_PORT", "5000"))
    use_ssl = os.getenv("FLASK_SSL", "true").strip().lower() in ("1", "true", "yes", "on")
    scheme = "https" if use_ssl else "http"
    if use_ssl:
        ensure_dev_ssl_certs()

    logger.info(
        "Starting Tech Cafe AI Helpdesk via gunicorn (%s://%s:%s realtime=%s chat=%s)",
        scheme,
        host,
        port,
        AZURE_OPENAI_REALTIME_DEPLOYMENT,
        AZURE_OPENAI_CHAT_DEPLOYMENT,
    )
    if use_ssl:
        logger.info(
            "Browser: open https://<this-host-ip>:%s - accept/trust the certificate warning if shown, then tap Start.",
            port,
        )

    # Prefer gunicorn+gevent over Werkzeug; Flask's built-in server can wedge on
    # CLOSE-WAIT / long-lived WebSockets under public scan + call load.
    gunicorn_bin = str(BASE_DIR / ".venv" / "bin" / "gunicorn")
    if not Path(gunicorn_bin).exists():
        gunicorn_bin = "gunicorn"
    conf = str(BASE_DIR / "gunicorn.conf.py")
    os.execvp(
        gunicorn_bin,
        [gunicorn_bin, "-c", conf, "wsgi:app"],
    )