"""WebSocket signaling router for PairPort.

Phase 4: WebRTC Signaling Relay & Session Lifecycle.
Relays WebRTC session offers, answers, and ICE candidates strictly between
the two participants in the same room.

Chat messages and file payloads are NEVER relayed through this signaling backend;
they travel directly peer-to-peer over the WebRTC DataChannel.
"""

from __future__ import annotations

import json
import logging
import math
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import (
    MAX_MESSAGE_BYTES,
    ROOM_TTL_SECONDS,
    WS_ACTION_LIMIT_ROOM_OPS,
    WS_RATE_LIMIT_BURST,
    WS_RATE_LIMIT_CREATE_PER_MIN,
    WS_RATE_LIMIT_JOIN_PER_MIN,
    WS_RATE_LIMIT_PER_SEC,
    WS_RATE_LIMIT_WINDOW_SECONDS,
    is_origin_allowed,
)
from app.services.rate_limiter import get_client_ip, ws_rate_limiter
from app.services.room_manager import (
    DuplicateConnectionError,
    InvalidInvitationError,
    InvalidRoomCodeError,
    InvitationAlreadyUsedError,
    InvitationError,
    InvitationExpiredError,
    InvitationRequiredError,
    Participant,
    Room,
    RoomError,
    RoomExpiredError,
    RoomFullError,
    RoomNotFoundError,
    ServerCapacityError,
    normalize_room_code,
    room_manager,
)

logger = logging.getLogger("pairport.signaling")

router = APIRouter(tags=["signaling"])


class ConnectionRateLimiter:
    """Per-connection token bucket and sliding-window rate limiter."""

    def __init__(
        self,
        rate_per_sec: float = WS_RATE_LIMIT_PER_SEC,
        burst: float = WS_RATE_LIMIT_BURST,
        action_limit_10s: int = WS_ACTION_LIMIT_ROOM_OPS,
    ) -> None:
        self.rate_per_sec = float(rate_per_sec)
        self.burst = float(burst)
        self.tokens = float(burst)
        self.last_update = time.time()
        self.action_limit_10s = action_limit_10s
        self.action_timestamps: list[float] = []
        self.violations = 0

    def allow_message(self) -> bool:
        """Token bucket check for general WebSocket messages."""
        now = time.time()
        elapsed = now - self.last_update
        self.last_update = now
        self.tokens = min(self.burst, self.tokens + elapsed * self.rate_per_sec)

        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        self.violations += 1
        return False

    def allow_room_action(self) -> bool:
        """Sliding window check for sensitive room operations (create / join)."""
        now = time.time()
        cutoff = now - 10.0
        self.action_timestamps = [t for t in self.action_timestamps if t > cutoff]
        if len(self.action_timestamps) >= self.action_limit_10s:
            self.violations += 1
            return False
        self.action_timestamps.append(now)
        return True


async def send_json(ws: WebSocket, event_type: str, payload: dict[str, Any] | None = None) -> bool:
    """Safely serialize and send a structured JSON message over WebSocket."""
    message = {
        "type": event_type,
        "payload": payload or {},
    }
    try:
        await ws.send_text(json.dumps(message))
        return True
    except Exception:
        return False


def validate_sdp(payload: Any, expected_type: str) -> tuple[bool, str, dict[str, Any] | None]:
    """Validate WebRTC SDP offer/answer payload structure and limits."""
    if not isinstance(payload, dict):
        return False, "Payload must be a JSON object.", None

    sdp = payload.get("sdp")
    if not isinstance(sdp, dict):
        return False, "Payload must contain an 'sdp' object.", None

    sdp_type = sdp.get("type")
    sdp_str = sdp.get("sdp")

    if sdp_type != expected_type:
        return False, f"Expected SDP type '{expected_type}', got '{sdp_type}'.", None

    if not isinstance(sdp_str, str) or not sdp_str.strip():
        return False, "SDP description must be a non-empty string.", None

    if len(sdp_str) > 32768:
        return False, "SDP description exceeds allowable size limit (32KB).", None

    return True, "", {"type": sdp_type, "sdp": sdp_str}


def validate_candidate(payload: Any) -> tuple[bool, str, Any]:
    """Validate WebRTC ICE candidate payload structure and limits."""
    if not isinstance(payload, dict):
        return False, "Payload must be a JSON object.", None

    candidate = payload.get("candidate")
    if candidate is None:
        # WebRTC end-of-candidates notification
        return True, "", None

    if not isinstance(candidate, dict):
        return False, "Candidate must be a dictionary or null.", None

    cand_str = candidate.get("candidate")
    if cand_str is not None and not isinstance(cand_str, str):
        return False, "candidate string must be a string if present.", None

    if cand_str and len(cand_str) > 4096:
        return False, "Candidate description exceeds allowable size limit (4KB).", None

    # Sanitize and ensure standard WebRTC candidate keys
    cleaned_candidate = {
        "candidate": cand_str or "",
        "sdpMid": str(candidate.get("sdpMid")) if candidate.get("sdpMid") is not None else None,
        "sdpMLineIndex": int(candidate.get("sdpMLineIndex")) if candidate.get("sdpMLineIndex") is not None else None,
    }
    return True, "", cleaned_candidate


async def handle_leave(
    room_code: str | None,
    session_id: str | None,
    reason: str = "Peer disconnected.",
) -> None:
    """Clean up participant from room and notify remaining peer."""
    if not room_code or not session_id:
        return

    room, departed, remaining = await room_manager.leave_room(room_code, session_id)
    if remaining and remaining.websocket:
        await send_json(
            remaining.websocket,
            "peer-left",
            {
                "room_code": room_code,
                "reason": reason,
            },
        )
        # Remaining peer returns to waiting state
        await send_json(
            remaining.websocket,
            "waiting",
            {
                "room_code": room_code,
                "message": "Waiting for a peer to join...",
            },
        )


@router.websocket("/ws")
@router.websocket("/ws/{room_code}")
async def websocket_signaling_endpoint(
    websocket: WebSocket,
    room_code: str | None = None,
) -> None:
    """Primary WebSocket signaling endpoint.
    
    Coordinates room creation, peer joining, and relays WebRTC offers, answers,
    and ICE candidates directly to the connected peer in the same room.
    
    Supported Inbound Actions:
      - {"type": "create"}
      - {"type": "join", "payload": {"room_code": "..."}}
      - {"type": "leave"}
      - {"type": "ping"}
      - {"type": "signal-offer", "payload": {"sdp": {"type": "offer", "sdp": "..."}}}
      - {"type": "signal-answer", "payload": {"sdp": {"type": "answer", "sdp": "..."}}}
      - {"type": "signal-candidate", "payload": {"candidate": {...}}}
      
    Supported Outbound Events:
      - {"type": "room-created", "payload": {...}}
      - {"type": "waiting", "payload": {...}}
      - {"type": "peer-joined", "payload": {...}}
      - {"type": "peer-left", "payload": {...}}
      - {"type": "signal-offer", "payload": {"sender_session_id": "...", "sdp": {...}}}
      - {"type": "signal-answer", "payload": {"sender_session_id": "...", "sdp": {...}}}
      - {"type": "signal-candidate", "payload": {"sender_session_id": "...", "candidate": {...}}}
      - {"type": "error", "payload": {"code": "...", "message": "..."}}
      - {"type": "pong", "payload": {...}}
    """
    # ----------------------------------------------------
    # Security (SEC-01): Validate WebSocket Origin before accept()
    # ----------------------------------------------------
    raw_origin = websocket.headers.get("origin")
    is_allowed, reason = is_origin_allowed(raw_origin)
    if not is_allowed:
        logger.warning(
            "WebSocket rejected: %s (origin=%r, path=%s, client=%s)",
            reason,
            raw_origin,
            websocket.url.path,
            websocket.client.host if websocket.client else "unknown",
        )
        await websocket.close(code=1008, reason=reason)
        return

    client_ip = get_client_ip(websocket)

    # If room_code was provided in the URL path, handle legacy path join
    if room_code:
        # Every path-based join attempt is subject to the shared IP join rate limit
        allowed, retry_after = await ws_rate_limiter.acquire(
            f"ws:join:{client_ip}",
            WS_RATE_LIMIT_JOIN_PER_MIN,
            WS_RATE_LIMIT_WINDOW_SECONDS,
        )
        if not allowed:
            await websocket.accept()
            await send_json(
                websocket,
                "error",
                {
                    "code": "RATE_LIMITED",
                    "message": f"Too many room join attempts. Please wait {retry_after} seconds before retrying.",
                    "retry_after": retry_after,
                },
            )
            await websocket.close(code=1008, reason=f"Rate limit exceeded. Retry after {retry_after}s")
            return

        # Legacy URL path join token hardening:
        # Query parameter invitation tokens are strictly prohibited on /ws/{room_code}
        has_query_token = any(
            k in websocket.query_params
            for k in ("invitation_token", "token", "invite", "secret", "key")
        )
        if has_query_token:
            await websocket.accept()
            await send_json(
                websocket,
                "error",
                {
                    "code": "QUERY_PARAM_TOKEN_PROHIBITED",
                    "message": (
                        "Passing invitation tokens in URL query parameters is prohibited. "
                        "Connect to /ws and supply the token in the join message payload."
                    ),
                },
            )
            await websocket.close(code=1008, reason="Invitation tokens in URL parameters prohibited")
            return

        # Without query parameter token, path-based join cannot join as guest
        await websocket.accept()
        await send_json(
            websocket,
            "error",
            {
                "code": "INVITATION_REQUIRED",
                "message": (
                    "Guest join requires an invitation token. "
                    "Connect to /ws and supply the token in the join message payload."
                ),
            },
        )
        await websocket.close(code=1008, reason="Invitation required")
        return

    await websocket.accept()

    current_room_code: str | None = None
    current_session_id: str | None = None
    rate_limiter = ConnectionRateLimiter()

    try:
        while True:
            # Receive incoming ASGI WebSocket frame safely
            try:
                msg = await websocket.receive()
            except RuntimeError:
                break

            asgi_type = msg.get("type")
            if asgi_type == "websocket.disconnect":
                raise WebSocketDisconnect(msg.get("code", 1000))

            # Reject binary payloads safely
            if "bytes" in msg and msg["bytes"]:
                await send_json(
                    websocket,
                    "error",
                    {
                        "code": "BINARY_NOT_ALLOWED",
                        "message": "Binary WebSocket frames are not permitted on the signaling server. Use WebRTC DataChannel for binary transfers.",
                    },
                )
                continue

            raw_text = msg.get("text", "")
            if not raw_text:
                continue

            # Per-connection message rate limit check
            if not rate_limiter.allow_message():
                await send_json(
                    websocket,
                    "error",
                    {
                        "code": "RATE_LIMITED",
                        "message": "Message rate limit exceeded. Please slow down your message frequency.",
                    },
                )
                if rate_limiter.violations > 100:
                    await websocket.close(code=1008, reason="Rate limit policy violation")
                    break
                continue

            if len(raw_text.encode("utf-8")) > MAX_MESSAGE_BYTES:
                await send_json(
                    websocket,
                    "error",
                    {
                        "code": "MESSAGE_TOO_LARGE",
                        "message": f"Message exceeded maximum allowed limit of {MAX_MESSAGE_BYTES} bytes.",
                    },
                )
                continue

            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                await send_json(
                    websocket,
                    "error",
                    {"code": "INVALID_JSON", "message": "Malformed JSON payload."},
                )
                continue

            if not isinstance(data, dict) or "type" not in data:
                await send_json(
                    websocket,
                    "error",
                    {"code": "INVALID_PROTOCOL", "message": "Message must be an object with a 'type' property."},
                )
                continue

            msg_type = data.get("type")
            payload = data.get("payload") or {}

            # ----------------------------------------------------
            # 1. Action: CREATE
            # ----------------------------------------------------
            if msg_type == "create":
                allowed, retry_after = await ws_rate_limiter.acquire(
                    f"ws:create:{client_ip}",
                    WS_RATE_LIMIT_CREATE_PER_MIN,
                    WS_RATE_LIMIT_WINDOW_SECONDS,
                )
                if not allowed:
                    await send_json(
                        websocket,
                        "error",
                        {
                            "code": "RATE_LIMITED",
                            "message": f"Too many room creation attempts. Please wait {retry_after} seconds before retrying.",
                            "retry_after": retry_after,
                        },
                    )
                    continue

                if current_room_code:
                    await send_json(
                        websocket,
                        "error",
                        {
                            "code": "ALREADY_IN_ROOM",
                            "message": f"Already connected to room {current_room_code}. Leave first.",
                        },
                    )
                    continue

                try:
                    room = await room_manager.create_room()
                except ServerCapacityError as cap_err:
                    await send_json(
                        websocket,
                        "error",
                        {
                            "code": cap_err.code,
                            "message": str(cap_err),
                        },
                    )
                    continue

                room, participant = await room_manager.join_room(room.code, websocket, role="host")
                current_room_code = room.code
                current_session_id = participant.session_id

                await send_json(
                    websocket,
                    "room-created",
                    {
                        "room_code": room.code,
                        "invitation_token": room.invitation_token,
                        "session_id": current_session_id,
                        "role": participant.role,
                        "expires_in": ROOM_TTL_SECONDS,
                    },
                )

                await send_json(
                    websocket,
                    "waiting",
                    {
                        "room_code": room.code,
                        "message": "Waiting for peer to join with this room code.",
                    },
                )

            # ----------------------------------------------------
            # 2. Action: JOIN
            # ----------------------------------------------------
            elif msg_type == "join":
                allowed, retry_after = await ws_rate_limiter.acquire(
                    f"ws:join:{client_ip}",
                    WS_RATE_LIMIT_JOIN_PER_MIN,
                    WS_RATE_LIMIT_WINDOW_SECONDS,
                )
                if not allowed:
                    await send_json(
                        websocket,
                        "error",
                        {
                            "code": "RATE_LIMITED",
                            "message": f"Too many room join attempts. Please wait {retry_after} seconds before retrying.",
                            "retry_after": retry_after,
                        },
                    )
                    continue

                if current_room_code:
                    await send_json(
                        websocket,
                        "error",
                        {
                            "code": "ALREADY_IN_ROOM",
                            "message": f"Already connected to room {current_room_code}. Leave first.",
                        },
                    )
                    continue

                target_code = payload.get("room_code")
                if not target_code:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "MISSING_ROOM_CODE", "message": "Missing required field 'room_code'."},
                    )
                    continue

                invitation_token = payload.get("invitation_token")
                try:
                    room, participant = await room_manager.join_room(
                        target_code,
                        websocket,
                        invitation_token=invitation_token,
                        role="guest",
                    )
                    current_room_code = room.code
                    current_session_id = participant.session_id

                    other = room.get_other_participant(current_session_id)
                    if other:
                        # Both participants now present
                        await send_json(
                            websocket,
                            "peer-joined",
                            {
                                "room_code": room.code,
                                "session_id": current_session_id,
                                "role": participant.role,
                                "peer_session_id": other.session_id,
                                "message": "Connected to room peer.",
                            },
                        )
                        await send_json(
                            other.websocket,
                            "peer-joined",
                            {
                                "room_code": room.code,
                                "session_id": other.session_id,
                                "role": other.role,
                                "peer_session_id": current_session_id,
                                "message": "Peer joined the room.",
                            },
                        )
                    else:
                        await send_json(
                            websocket,
                            "waiting",
                            {
                                "room_code": room.code,
                                "session_id": current_session_id,
                                "role": participant.role,
                                "message": "Waiting for peer to join with this room code.",
                            },
                        )
                except RoomError as err:
                    await send_json(
                        websocket,
                        "error",
                        {"code": err.code, "message": str(err)},
                    )

            # ----------------------------------------------------
            # 3. WebRTC Signaling Relay: OFFER
            # ----------------------------------------------------
            elif msg_type in ("signal-offer", "offer"):
                if not current_room_code or not current_session_id:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "NOT_IN_ROOM", "message": "Cannot send offer: not joined to any room."},
                    )
                    continue

                try:
                    room = await room_manager.get_room(current_room_code)
                except RoomError as err:
                    await send_json(websocket, "error", {"code": err.code, "message": str(err)})
                    continue

                other = room.get_other_participant(current_session_id)
                if not other or not other.websocket:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "NO_PEER_IN_ROOM", "message": "Cannot send offer: no peer in room to receive it."},
                    )
                    continue

                is_valid, err_msg, clean_sdp = validate_sdp(payload, "offer")
                if not is_valid:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "INVALID_OFFER", "message": f"Offer validation failed: {err_msg}"},
                    )
                    continue

                # Relay offer strictly to the verified other participant
                await send_json(
                    other.websocket,
                    "signal-offer",
                    {
                        "room_code": current_room_code,
                        "sender_session_id": current_session_id,
                        "sdp": clean_sdp,
                    },
                )

            # ----------------------------------------------------
            # 4. WebRTC Signaling Relay: ANSWER
            # ----------------------------------------------------
            elif msg_type in ("signal-answer", "answer"):
                if not current_room_code or not current_session_id:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "NOT_IN_ROOM", "message": "Cannot send answer: not joined to any room."},
                    )
                    continue

                try:
                    room = await room_manager.get_room(current_room_code)
                except RoomError as err:
                    await send_json(websocket, "error", {"code": err.code, "message": str(err)})
                    continue

                other = room.get_other_participant(current_session_id)
                if not other or not other.websocket:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "NO_PEER_IN_ROOM", "message": "Cannot send answer: no peer in room to receive it."},
                    )
                    continue

                is_valid, err_msg, clean_sdp = validate_sdp(payload, "answer")
                if not is_valid:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "INVALID_ANSWER", "message": f"Answer validation failed: {err_msg}"},
                    )
                    continue

                # Relay answer strictly to the verified other participant
                await send_json(
                    other.websocket,
                    "signal-answer",
                    {
                        "room_code": current_room_code,
                        "sender_session_id": current_session_id,
                        "sdp": clean_sdp,
                    },
                )

            # ----------------------------------------------------
            # 5. WebRTC Signaling Relay: ICE CANDIDATE
            # ----------------------------------------------------
            elif msg_type in ("signal-candidate", "candidate", "ice-candidate"):
                if not current_room_code or not current_session_id:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "NOT_IN_ROOM", "message": "Cannot send ICE candidate: not joined to any room."},
                    )
                    continue

                try:
                    room = await room_manager.get_room(current_room_code)
                except RoomError as err:
                    await send_json(websocket, "error", {"code": err.code, "message": str(err)})
                    continue

                other = room.get_other_participant(current_session_id)
                if not other or not other.websocket:
                    # Ignore or notify if peer is not present
                    continue

                is_valid, err_msg, clean_cand = validate_candidate(payload)
                if not is_valid:
                    await send_json(
                        websocket,
                        "error",
                        {"code": "INVALID_CANDIDATE", "message": f"Candidate validation failed: {err_msg}"},
                    )
                    continue

                # Relay candidate strictly to the verified other participant
                await send_json(
                    other.websocket,
                    "signal-candidate",
                    {
                        "room_code": current_room_code,
                        "sender_session_id": current_session_id,
                        "candidate": clean_cand,
                    },
                )

            # ----------------------------------------------------
            # 6. Action: LEAVE
            # ----------------------------------------------------
            elif msg_type == "leave":
                if current_room_code and current_session_id:
                    await handle_leave(current_room_code, current_session_id, reason="Peer left the session.")
                    current_room_code = None
                    current_session_id = None
                await send_json(websocket, "left", {"message": "Successfully left the room."})

            # ----------------------------------------------------
            # 7. Action: PING
            # ----------------------------------------------------
            elif msg_type == "ping":
                await send_json(websocket, "pong", {"timestamp": time.time()})

            # ----------------------------------------------------
            # Security Enforcement: Reject Chat on Signaling WS
            # ----------------------------------------------------
            elif msg_type in ("chat", "message", "chat-message"):
                await send_json(
                    websocket,
                    "error",
                    {
                        "code": "CHAT_NOT_ALLOWED_ON_SIGNALING",
                        "message": "Chat messages must be transmitted directly via WebRTC DataChannel, not through the signaling server.",
                    },
                )

            # ----------------------------------------------------
            # Security Enforcement: Reject File Transfers on Signaling WS
            # ----------------------------------------------------
            elif msg_type in ("file", "file-meta", "file-chunk", "file-data", "file-transfer"):
                await send_json(
                    websocket,
                    "error",
                    {
                        "code": "FILE_TRANSFER_NOT_ALLOWED_ON_SIGNALING",
                        "message": "File transfer data must be transmitted directly via WebRTC DataChannel, not through the signaling server.",
                    },
                )

            # ----------------------------------------------------
            # Unknown Action
            # ----------------------------------------------------
            else:
                await send_json(
                    websocket,
                    "error",
                    {
                        "code": "UNKNOWN_ACTION",
                        "message": f"Unrecognized action '{msg_type}'. Expected 'create', 'join', 'signal-offer', 'signal-answer', 'signal-candidate', 'leave', or 'ping'.",
                    },
                )

    except WebSocketDisconnect:
        # Client closed connection abruptly
        if current_room_code and current_session_id:
            await handle_leave(current_room_code, current_session_id, reason="Peer disconnected.")
    except Exception as exc:
        logger.exception("Signaling endpoint unexpected error: %s", exc)
        if current_room_code and current_session_id:
            await handle_leave(current_room_code, current_session_id, reason="Peer connection lost.")
