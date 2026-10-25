from __future__ import annotations

import os
from urllib.parse import urlparse

APP_NAME = "PairPort API"
APP_ENV = os.getenv("PAIRPORT_ENV", "development")

# CORS and WebSocket origin configuration
_default_origins = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:4173,http://127.0.0.1:4173"
)
_env_origins = os.getenv("PAIRPORT_ALLOWED_ORIGINS") or os.getenv("PAIRPORT_FRONTEND_ORIGIN") or _default_origins
ALLOWED_ORIGINS = [origin.strip() for origin in _env_origins.split(",") if origin.strip()]

# WebSocket Origin validation policy
# In production, an Origin header is strictly mandatory on all WebSocket connections.
# In development, it is required by default unless explicitly disabled for headless tooling.
WS_REQUIRE_ORIGIN = os.getenv("PAIRPORT_WS_REQUIRE_ORIGIN", "true").lower() in ("true", "1")


def normalize_origin(raw_origin: str | None) -> str | None:
    """Parse and normalize an HTTP/HTTPS origin into canonical 'scheme://host[:port]'.

    Rejects missing, empty, 'null', non-HTTP schemes, invalid port formatting,
    userinfo, paths, queries, and fragments.
    """
    if not raw_origin or not isinstance(raw_origin, str):
        return None
    cleaned = raw_origin.strip()
    if not cleaned or cleaned.lower() == "null":
        return None

    try:
        parsed = urlparse(cleaned)
    except Exception:
        return None

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return None

    # Origin per RFC 6454 cannot have path beyond empty/slash, or queries/fragments/userinfo
    if parsed.path not in ("", "/"):
        return None
    if parsed.query or parsed.fragment:
        return None
    if parsed.username or parsed.password:
        return None

    try:
        hostname = parsed.hostname
        port = parsed.port
    except (ValueError, AttributeError):
        # Invalid host/port formatting (e.g. 'http://localhost:5173.evil.com')
        return None

    if not hostname:
        return None

    hostname = hostname.lower()

    if port is None or (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        return f"{scheme}://{hostname}"
    return f"{scheme}://{hostname}:{port}"


def get_normalized_allowed_origins() -> set[str]:
    """Return the set of normalized allowed origins, omitting wildcards."""
    allowed: set[str] = set()
    for origin in ALLOWED_ORIGINS:
        if origin == "*":
            continue
        normalized = normalize_origin(origin)
        if normalized:
            allowed.add(normalized)
    return allowed


def is_origin_allowed(raw_origin: str | None) -> tuple[bool, str]:
    """Validate incoming WebSocket Origin against configured ALLOWED_ORIGINS.

    Returns (is_allowed, reason).
    """
    if raw_origin is None or not raw_origin.strip():
        # Policy for missing Origin header:
        # Browser WebSocket handshakes ALWAYS include an Origin header (RFC 6455).
        # A missing Origin header is never silently trusted.
        if WS_REQUIRE_ORIGIN or APP_ENV != "development":
            return False, "Missing Origin header"
        return True, "Allowed (development missing-origin override)"

    normalized = normalize_origin(raw_origin)
    if not normalized:
        return False, "Malformed or invalid Origin header"

    allowed_set = get_normalized_allowed_origins()
    if normalized in allowed_set:
        return True, "Origin allowed"

    return False, "Origin not allowed"


# Room lifecycle and limits
ROOM_TTL_SECONDS = int(os.getenv("PAIRPORT_ROOM_TTL_SECONDS", "1800"))  # 30 minutes
ROOM_CLEANUP_INTERVAL_SECONDS = int(os.getenv("PAIRPORT_ROOM_CLEANUP_INTERVAL_SECONDS", "300"))  # 5 minutes
MAX_MESSAGE_BYTES = int(os.getenv("PAIRPORT_MAX_MESSAGE_BYTES", "65536"))  # 64 KB
MAX_PARTICIPANTS_PER_ROOM = 2
ROOM_CODE_PREFIX = "PORT-"
ROOM_CODE_LENGTH = int(os.getenv("PAIRPORT_ROOM_CODE_LENGTH", "6"))  # e.g. PORT-7K2M9X (31^6 = 887,503,681 combinations)

# Server capacity limits and WebSocket rate limiting (Phase 9)
MAX_ACTIVE_ROOMS = int(os.getenv("PAIRPORT_MAX_ACTIVE_ROOMS", "10000"))
WS_RATE_LIMIT_PER_SEC = int(os.getenv("PAIRPORT_WS_RATE_LIMIT_PER_SEC", "30"))
WS_RATE_LIMIT_BURST = int(os.getenv("PAIRPORT_WS_RATE_LIMIT_BURST", "60"))
WS_ACTION_LIMIT_ROOM_OPS = int(os.getenv("PAIRPORT_WS_ACTION_LIMIT_ROOM_OPS", "10"))  # Max room creates/joins per 10s window

# REST API Rate Limiting (Phase 9D)
REST_RATE_LIMIT_CREATE_ROOM_PER_MIN = int(os.getenv("PAIRPORT_REST_LIMIT_CREATE_PER_MIN", "5"))
REST_RATE_LIMIT_CHECK_ROOM_PER_MIN = int(os.getenv("PAIRPORT_REST_LIMIT_CHECK_PER_MIN", "30"))
REST_RATE_LIMIT_WINDOW_SECONDS = float(os.getenv("PAIRPORT_REST_LIMIT_WINDOW_SECONDS", "60.0"))
REST_RATE_LIMIT_MAX_ENTRIES = int(os.getenv("PAIRPORT_REST_LIMIT_MAX_ENTRIES", "10000"))
TRUST_PROXY_HEADERS = os.getenv("PAIRPORT_TRUST_PROXY_HEADERS", "false").lower() in ("true", "1")

# WebSocket IP Rate Limiting (Step 9H-1)
WS_RATE_LIMIT_CREATE_PER_MIN = int(os.getenv("PAIRPORT_WS_LIMIT_CREATE_PER_MIN", "10"))
WS_RATE_LIMIT_JOIN_PER_MIN = int(os.getenv("PAIRPORT_WS_LIMIT_JOIN_PER_MIN", "30"))
WS_RATE_LIMIT_WINDOW_SECONDS = float(os.getenv("PAIRPORT_WS_LIMIT_WINDOW_SECONDS", "60.0"))

# Guest Invitation Security (Step 9F)
INVITATION_TOKEN_BYTES = int(os.getenv("PAIRPORT_INVITATION_TOKEN_BYTES", "16"))  # 128-bit CSPRNG entropy
INVITATION_TTL_SECONDS = int(os.getenv("PAIRPORT_INVITATION_TTL_SECONDS", "1800"))  # Bound to room TTL
REQUIRE_INVITATION_TOKEN = os.getenv("PAIRPORT_REQUIRE_INVITATION_TOKEN", "false").lower() in ("true", "1")

# Participant Reconnection Protocol (Step 9J-1)
RECONNECT_GRACE_PERIOD_SECONDS = float(os.getenv("PAIRPORT_RECONNECT_GRACE_PERIOD_SECONDS", "30.0"))
RECONNECT_TOKEN_BYTES = int(os.getenv("PAIRPORT_RECONNECT_TOKEN_BYTES", "32"))  # 256-bit CSPRNG entropy
WS_RATE_LIMIT_RECONNECT_PER_MIN = int(os.getenv("PAIRPORT_WS_LIMIT_RECONNECT_PER_MIN", "30"))
