"""PairPort FastAPI Application Entry Point.

Phase 3: Real Room Pairing and WebSocket Signaling.

ARCHITECTURE NOTE:
Room state is maintained strictly in-memory for Phase 3 signaling.
Rooms reset when the server restarts and are not shared across multiple worker
processes or instances. Distributed persistence will be added in later phases.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.api.health import router as health_router
from app.api.rooms import router as rooms_router
from app.api.websocket import router as ws_router
from app.config import (
    ALLOWED_ORIGINS,
    APP_ENV,
    APP_NAME,
    ROOM_CLEANUP_INTERVAL_SECONDS,
)
from app.services.room_manager import room_manager


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Enforces defensive production security headers on all HTTP responses."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "0"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "img-src 'self' data: blob:; "
            "connect-src 'self' ws: wss:; "
            "style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none';"
        )
        return response


async def periodic_room_cleanup() -> None:
    """Background task running periodically to evict expired in-memory rooms."""
    while True:
        try:
            await asyncio.sleep(ROOM_CLEANUP_INTERVAL_SECONDS)
            await room_manager.cleanup_expired_rooms()
        except asyncio.CancelledError:
            break
        except Exception:
            # Prevent background loop crashing on unexpected errors
            pass


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan context managing background cleanup tasks."""
    cleanup_task = asyncio.create_task(periodic_room_cleanup())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title=APP_NAME,
    description="PairPort WebSocket signaling backend for peer-to-peer room pairing.",
    version="0.9.0",
    lifespan=lifespan,
)

# Enforce security headers
app.add_middleware(SecurityHeadersMiddleware)

# Configure CORS using environment-based origin list
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(health_router)
app.include_router(rooms_router)
app.include_router(ws_router)


@app.get("/")
def root() -> dict[str, str | list[str]]:
    return {
        "service": APP_NAME,
        "environment": APP_ENV,
        "status": "ready",
        "phase": "Phase 9: Security Hardening & Production Readiness",
    }
