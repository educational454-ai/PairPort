"""PairPort configuration settings.

Loads settings from environment variables with sensible defaults for local development.
"""

import os

APP_NAME = "PairPort API"
APP_ENV = os.getenv("PAIRPORT_ENV", "development")

# CORS origin configuration
_default_origins = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"
_env_origins = os.getenv("PAIRPORT_ALLOWED_ORIGINS") or os.getenv("PAIRPORT_FRONTEND_ORIGIN") or _default_origins
ALLOWED_ORIGINS = [origin.strip() for origin in _env_origins.split(",") if origin.strip()]

# Room lifecycle and limits
ROOM_TTL_SECONDS = int(os.getenv("PAIRPORT_ROOM_TTL_SECONDS", "1800"))  # 30 minutes
ROOM_CLEANUP_INTERVAL_SECONDS = int(os.getenv("PAIRPORT_ROOM_CLEANUP_INTERVAL_SECONDS", "300"))  # 5 minutes
MAX_MESSAGE_BYTES = int(os.getenv("PAIRPORT_MAX_MESSAGE_BYTES", "65536"))  # 64 KB
MAX_PARTICIPANTS_PER_ROOM = 2
ROOM_CODE_PREFIX = "PORT-"
ROOM_CODE_LENGTH = 4  # e.g. PORT-7K2M (30^4 = 810,000 combinations)

# Server capacity limits and WebSocket rate limiting (Phase 9)
MAX_ACTIVE_ROOMS = int(os.getenv("PAIRPORT_MAX_ACTIVE_ROOMS", "10000"))
WS_RATE_LIMIT_PER_SEC = int(os.getenv("PAIRPORT_WS_RATE_LIMIT_PER_SEC", "30"))
WS_RATE_LIMIT_BURST = int(os.getenv("PAIRPORT_WS_RATE_LIMIT_BURST", "60"))
WS_ACTION_LIMIT_ROOM_OPS = int(os.getenv("PAIRPORT_WS_ACTION_LIMIT_ROOM_OPS", "10"))  # Max room creates/joins per 10s window
