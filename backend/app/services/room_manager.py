"""In-memory room manager for PairPort WebSockets signaling.

Maintains room state, participant sessions, role authorization, and reconnection lifecycles.
Room state is stored in memory and synchronized via asyncio.Lock.
"""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.config import (
    INVITATION_TOKEN_BYTES,
    INVITATION_TTL_SECONDS,
    MAX_ACTIVE_ROOMS,
    MAX_PARTICIPANTS_PER_ROOM,
    RECONNECT_GRACE_PERIOD_SECONDS,
    RECONNECT_TOKEN_BYTES,
    REQUIRE_INVITATION_TOKEN,
    ROOM_CODE_LENGTH,
    ROOM_CODE_PREFIX,
    ROOM_TTL_SECONDS,
)

# Unambiguous alphanumeric alphabet (excludes 0, O, 1, I, L)
UNAMBIGUOUS_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"


class RoomError(Exception):
    """Base exception for room operations."""
    code: str = "ROOM_ERROR"

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code


class RoomNotFoundError(RoomError):
    code = "ROOM_NOT_FOUND"


class RoomFullError(RoomError):
    code = "ROOM_FULL"


class RoomExpiredError(RoomError):
    code = "ROOM_EXPIRED"


class InvalidRoomCodeError(RoomError):
    code = "INVALID_ROOM_CODE"


class InvalidRoomCapacityError(RoomError, ValueError):
    """Raised when an explicit room capacity is outside allowed bounds (2 to max_participants_per_room)."""
    code = "INVALID_ROOM_CAPACITY"


class DuplicateConnectionError(RoomError):
    code = "DUPLICATE_CONNECTION"


class ServerCapacityError(RoomError):
    code = "SERVER_FULL"


class InvitationError(RoomError):
    """Base exception for invitation validation failures."""
    code: str = "INVITATION_ERROR"


class InvitationRequiredError(InvitationError):
    code = "INVITATION_REQUIRED"


class InvalidInvitationError(InvitationError):
    code = "INVALID_INVITATION"


class InvitationExpiredError(InvitationError):
    code = "INVITATION_EXPIRED"


class InvitationAlreadyUsedError(InvitationError):
    code = "INVITATION_ALREADY_USED"


class ReconnectError(RoomError):
    """Base exception for reconnection failures."""
    code: str = "RECONNECT_FAILED"


class ReconnectExpiredError(ReconnectError):
    code = "RECONNECT_EXPIRED"


class InvalidReconnectCredentialError(ReconnectError):
    code = "INVALID_RECONNECT_TOKEN"


class ParticipantNotFoundError(ReconnectError):
    code = "PARTICIPANT_NOT_FOUND"


class UnauthorizedRoleError(RoomError):
    code = "UNAUTHORIZED_ROLE"


def hash_reconnect_token(token: str) -> str:
    """Compute SHA-256 hex digest of reconnect token."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_reconnect_token(stored_hash: str | None, candidate_token: str | None) -> bool:
    """Constant-time verification of candidate token against stored SHA-256 digest."""
    if not stored_hash or not candidate_token or not isinstance(candidate_token, str):
        return False
    candidate_hash = hash_reconnect_token(candidate_token.strip())
    return secrets.compare_digest(stored_hash, candidate_hash)


def normalize_room_code(raw_code: str) -> str:
    """Normalize input room code.
    
    Trims whitespace, converts to uppercase, and ensures standard PORT-XXXXXX formatting.
    Accepts formats such as:
    - 'PORT-7K2M9X' -> 'PORT-7K2M9X'
    - 'port-7k2m9x' -> 'PORT-7K2M9X'
    - '7k2m9x'      -> 'PORT-7K2M9X'
    - 'PORT7K2M9X'  -> 'PORT-7K2M9X'
    """
    if not raw_code or not isinstance(raw_code, str):
        raise InvalidRoomCodeError("Room code cannot be empty.")

    cleaned = raw_code.strip().upper().replace(" ", "")
    
    # Check if prefixed
    if cleaned.startswith(ROOM_CODE_PREFIX):
        suffix = cleaned[len(ROOM_CODE_PREFIX):]
    elif cleaned.startswith("PORT"):
        suffix = cleaned[4:].lstrip("-")
    else:
        suffix = cleaned

    if not suffix or len(suffix) < 3 or len(suffix) > 8:
        raise InvalidRoomCodeError(
            f"Invalid room code length. Expected {ROOM_CODE_PREFIX}{'X' * ROOM_CODE_LENGTH} format."
        )

    for char in suffix:
        if char not in UNAMBIGUOUS_ALPHABET and not char.isalnum():
            raise InvalidRoomCodeError(f"Room code contains invalid character: '{char}'.")

    return f"{ROOM_CODE_PREFIX}{suffix}"


def generate_unambiguous_code(length: int = ROOM_CODE_LENGTH) -> str:
    """Generate a random human-readable room code using unambiguous characters."""
    suffix = "".join(secrets.choice(UNAMBIGUOUS_ALPHABET) for _ in range(length))
    return f"{ROOM_CODE_PREFIX}{suffix}"


@dataclass
class Participant:
    """Represents a connected or temporarily disconnected peer in a room."""
    session_id: str
    role: str  # 'host' or 'guest'
    websocket: Any | None
    joined_at: float = field(default_factory=time.time)
    reconnect_token_hash: str | None = None
    status: str = "connected"  # 'connected' | 'disconnected' | 'removed'
    disconnected_at: float | None = None

    def is_connected(self) -> bool:
        return self.status == "connected" and self.websocket is not None

    def is_disconnected(self) -> bool:
        return self.status == "disconnected"


@dataclass
class Room:
    """Represents an active in-memory sharing room."""
    code: str
    host_session_id: str | None = None
    invitation_token: str | None = None
    invitation_consumed: bool = False
    invitation_claims_count: int = 0
    invitation_revoked: bool = False
    invitation_created_at: float = field(default_factory=time.time)
    invitation_ttl: float = INVITATION_TTL_SECONDS
    max_participants: int = MAX_PARTICIPANTS_PER_ROOM
    created_at: float = field(default_factory=time.time)
    last_activity_at: float = field(default_factory=time.time)
    participants: dict[str, Participant] = field(default_factory=dict)

    def is_full(self) -> bool:
        return len(self.participants) >= self.max_participants

    def is_empty(self) -> bool:
        return len(self.participants) == 0

    def is_expired(self, now: float | None = None, ttl: float = ROOM_TTL_SECONDS) -> bool:
        current = now if now is not None else time.time()
        return (current - self.created_at) > ttl

    def revoke_invitation(self) -> None:
        """Revoke active invitation token, disallowing any further guest joins."""
        self.invitation_revoked = True
        self.invitation_consumed = True

    def is_invitation_valid(self, token: str | None, now: float | None = None) -> tuple[bool, str]:
        """Validate an invitation token against this room.

        Returns (is_valid, reason_code).
        """
        if not token or not isinstance(token, str) or not token.strip():
            return False, "INVITATION_REQUIRED"

        if self.invitation_revoked or self.invitation_consumed:
            return False, "INVITATION_ALREADY_USED"

        current_time = now if now is not None else time.time()
        if (current_time - self.invitation_created_at) > self.invitation_ttl:
            return False, "INVITATION_EXPIRED"

        if not self.invitation_token or not secrets.compare_digest(self.invitation_token, token.strip()):
            return False, "INVALID_INVITATION"

        return True, "OK"

    def get_other_participant(self, session_id: str) -> Participant | None:
        for sid, p in self.participants.items():
            if sid != session_id:
                return p
        return None

    def get_other_participants(self, session_id: str) -> list[Participant]:
        """Return list of all participants in the room other than session_id."""
        return [p for sid, p in self.participants.items() if sid != session_id]

    def get_host(self) -> Participant | None:
        for p in self.participants.values():
            if p.role == "host":
                return p
        return None

    def prune_expired_participants(self, now: float, grace_period: float) -> list[Participant]:
        """Prune participants whose temporary disconnect grace period has expired."""
        expired: list[Participant] = []
        for sid, p in list(self.participants.items()):
            if p.status == "disconnected" and p.disconnected_at is not None:
                if (now - p.disconnected_at) > grace_period:
                    expired.append(p)
                    del self.participants[sid]
        if expired:
            self.last_activity_at = now
        return expired


class RoomManager:
    """In-memory coordinator for room lifecycles and peer membership."""

    def __init__(
        self,
        default_ttl: float = ROOM_TTL_SECONDS,
        grace_period: float = RECONNECT_GRACE_PERIOD_SECONDS,
        require_invitation_token: bool = REQUIRE_INVITATION_TOKEN,
        max_participants_per_room: int = MAX_PARTICIPANTS_PER_ROOM,
    ) -> None:
        self.rooms: dict[str, Room] = {}
        self.default_ttl = default_ttl
        self.grace_period = grace_period
        self.require_invitation_token = require_invitation_token
        self.max_participants_per_room = max_participants_per_room
        self._lock = asyncio.Lock()

    async def create_room(
        self,
        ttl: float | None = None,
        max_participants: int | None = None,
        now: float | None = None,
    ) -> Room:
        """Create a new room with a unique random code and guest invitation token."""
        # Enforce capacity constraints before acquiring lock or modifying state
        if max_participants is not None:
            if not isinstance(max_participants, int) or isinstance(max_participants, bool):
                raise InvalidRoomCapacityError("max_participants must be an integer.")
            if max_participants < 2 or max_participants > self.max_participants_per_room:
                raise InvalidRoomCapacityError(
                    f"max_participants must be between 2 and {self.max_participants_per_room} (got {max_participants})."
                )
            effective_max = max_participants
        else:
            effective_max = self.max_participants_per_room

        current_time = now if now is not None else time.time()
        async with self._lock:
            if len(self.rooms) >= MAX_ACTIVE_ROOMS:
                raise ServerCapacityError(
                    f"Server room capacity ({MAX_ACTIVE_ROOMS}) reached. Please try again later."
                )

            # Generate a collision-free code
            attempts = 0
            while True:
                code = generate_unambiguous_code()
                if code not in self.rooms:
                    break
                attempts += 1
                if attempts > 100:
                    code = generate_unambiguous_code(length=ROOM_CODE_LENGTH + 2)
                    if code not in self.rooms:
                        break

            effective_invitation_ttl = ttl if ttl is not None else INVITATION_TTL_SECONDS
            invitation_token = secrets.token_urlsafe(INVITATION_TOKEN_BYTES)
            room = Room(
                code=code,
                host_session_id=None,
                invitation_token=invitation_token,
                invitation_consumed=False,
                invitation_claims_count=0,
                invitation_revoked=False,
                invitation_created_at=current_time,
                invitation_ttl=effective_invitation_ttl,
                max_participants=effective_max,
                created_at=current_time,
                last_activity_at=current_time,
            )
            self.rooms[code] = room
            return room

    async def get_room(self, raw_code: str, check_expiry: bool = True, now: float | None = None) -> Room:
        """Retrieve a room by code, validating format, expiration, and disconnected reservations."""
        code = normalize_room_code(raw_code)
        async with self._lock:
            current_time = now if now is not None else time.time()
            room = self.rooms.get(code)
            if not room:
                raise RoomNotFoundError(f"Room '{code}' does not exist.")

            if check_expiry and room.is_expired(now=current_time, ttl=self.default_ttl):
                del self.rooms[code]
                raise RoomExpiredError(f"Room '{code}' has expired.")

            room.prune_expired_participants(now=current_time, grace_period=self.grace_period)
            if check_expiry and room.is_empty() and room.host_session_id is not None:
                del self.rooms[code]
                raise RoomNotFoundError(f"Room '{code}' does not exist.")

            return room

    async def join_room(
        self,
        raw_code: str,
        websocket: Any,
        invitation_token: str | None = None,
        role: str | None = None,
        now: float | None = None,
    ) -> tuple[Room, Participant, str]:
        """Join an existing room as a participant.
        
        Assigns a server-generated UUID session ID and determines role:
        - If room has no host established and no active participants, initial joiner seats as 'host'.
        - Once a host is established, NO new participant may ever join as 'host' or inherit the host role.
        - Subsequent joins are strictly 'guest' and strictly require a valid, unconsumed invitation token.
        - Returns (room, participant, raw_reconnect_token).
        """
        code = normalize_room_code(raw_code)
        async with self._lock:
            current_time = now if now is not None else time.time()
            room = self.rooms.get(code)
            if not room:
                raise RoomNotFoundError(f"Room '{code}' does not exist.")

            if room.is_expired(now=current_time, ttl=self.default_ttl):
                del self.rooms[code]
                raise RoomExpiredError(f"Room '{code}' has expired.")

            # Prune expired reservations before capacity checks
            room.prune_expired_participants(now=current_time, grace_period=self.grace_period)

            if room.is_full():
                raise RoomFullError(f"Room '{code}' already has the maximum of {room.max_participants} participants.")

            # Host-role authorization enforcement:
            # Only the initial participant in an unseated room can seat as host.
            # If the host disconnected, their slot is reserved; strangers cannot usurp the host role.
            if len(room.participants) == 0 and room.host_session_id is None:
                assigned_role = "host"
            else:
                if role == "host":
                    raise RoomFullError(f"Room '{code}' already has an established host. Reconnection required to reclaim host role.")
                assigned_role = "guest"

            if assigned_role == "guest":
                if invitation_token and str(invitation_token).strip():
                    is_valid, reason = room.is_invitation_valid(invitation_token, now=current_time)
                    if not is_valid:
                        if reason in ("INVITATION_ALREADY_USED", "INVITATION_REVOKED"):
                            raise InvitationAlreadyUsedError("Invitation token has already been consumed.")
                        elif reason == "INVITATION_EXPIRED":
                            raise InvitationExpiredError("Invitation token has expired.")
                        else:
                            raise InvalidInvitationError("Invalid invitation token.")

                    # Consume token atomically with slot assignment when guest quota is reached
                    room.invitation_claims_count += 1
                    if room.invitation_claims_count >= (room.max_participants - 1):
                        room.invitation_consumed = True
                elif self.require_invitation_token:
                    raise InvitationRequiredError("Invitation token is required to join as guest.")

            session_id = uuid.uuid4().hex
            reconnect_token = secrets.token_urlsafe(RECONNECT_TOKEN_BYTES)
            reconnect_hash = hash_reconnect_token(reconnect_token)

            participant = Participant(
                session_id=session_id,
                role=assigned_role,
                websocket=websocket,
                joined_at=current_time,
                reconnect_token_hash=reconnect_hash,
                status="connected",
                disconnected_at=None,
            )

            if assigned_role == "host":
                room.host_session_id = session_id

            room.participants[session_id] = participant
            room.last_activity_at = current_time
            return room, participant, reconnect_token

    async def reconnect_participant(
        self,
        raw_code: str,
        session_id: str,
        reconnect_token: str,
        websocket: Any,
        now: float | None = None,
    ) -> tuple[Room, Participant, str, Participant | None]:
        """Reconnect a temporarily disconnected participant using their session ID and reconnect token.
        Atomically validates credentials, rotates the reconnect token, and attaches the new WebSocket.
        Returns (room, participant, new_reconnect_token, other_participant).
        """
        code = normalize_room_code(raw_code)
        async with self._lock:
            current_time = now if now is not None else time.time()
            room = self.rooms.get(code)
            if not room:
                raise RoomNotFoundError(f"Room '{code}' does not exist.")

            if room.is_expired(now=current_time, ttl=self.default_ttl):
                del self.rooms[code]
                raise RoomExpiredError(f"Room '{code}' has expired.")

            participant = room.participants.get(session_id)
            if not participant:
                if room.is_empty():
                    del self.rooms[code]
                raise ParticipantNotFoundError(f"Participant '{session_id}' not found in room '{code}'.")

            # Validate grace period window
            if participant.disconnected_at is not None:
                if (current_time - participant.disconnected_at) > self.grace_period:
                    del room.participants[session_id]
                    if room.is_empty():
                        del self.rooms[code]
                    raise ReconnectExpiredError("Reconnect grace period has expired.")

            # Prune any other expired participants in the room
            room.prune_expired_participants(now=current_time, grace_period=self.grace_period)

            # Guard against concurrent active connection
            if participant.status == "connected" and participant.websocket is not None:
                raise DuplicateConnectionError(f"Participant '{session_id}' is already actively connected.")

            # Constant-time verification of reconnect token
            if not verify_reconnect_token(participant.reconnect_token_hash, reconnect_token):
                raise InvalidReconnectCredentialError("Invalid reconnect credential.")

            # Rotate credential immediately upon successful validation
            new_reconnect_token = secrets.token_urlsafe(RECONNECT_TOKEN_BYTES)
            participant.reconnect_token_hash = hash_reconnect_token(new_reconnect_token)

            # Attach new socket and mark active
            participant.websocket = websocket
            participant.status = "connected"
            participant.disconnected_at = None
            room.last_activity_at = current_time

            other = room.get_other_participant(session_id)
            return room, participant, new_reconnect_token, other

    async def disconnect_participant(
        self,
        raw_code: str,
        session_id: str,
        websocket: Any,
        now: float | None = None,
    ) -> tuple[Room | None, Participant | None, Participant | None]:
        """Mark a participant temporarily disconnected on unexpected socket loss.
        Reserves the room slot for the grace period and protects against stale socket cleanups.
        Returns (room, disconnected_participant, other_participant).
        """
        try:
            code = normalize_room_code(raw_code)
        except InvalidRoomCodeError:
            return None, None, None

        async with self._lock:
            current_time = now if now is not None else time.time()
            room = self.rooms.get(code)
            if not room:
                return None, None, None

            participant = room.participants.get(session_id)
            if not participant:
                return room, None, None

            # STALE SOCKET GUARD:
            # If the participant's active websocket is NOT the one that disconnected,
            # an older socket closed after a newer reconnected socket attached.
            # Do NOT disconnect or alter the newer active connection.
            if participant.websocket is not None and participant.websocket is not websocket:
                return room, None, None

            # Mark temporarily disconnected and reserve slot
            participant.status = "disconnected"
            participant.disconnected_at = current_time
            participant.websocket = None
            room.last_activity_at = current_time

            other = room.get_other_participant(session_id)
            return room, participant, other

    async def leave_room(
        self,
        raw_code: str,
        session_id: str,
        now: float | None = None,
    ) -> tuple[Room | None, Participant | None, Participant | None]:
        """Voluntarily remove a participant from a room on intentional leave.
        
        Immediately revokes reconnect credentials and evicts the slot.
        Returns (room, departed_participant, remaining_participant).
        """
        try:
            code = normalize_room_code(raw_code)
        except InvalidRoomCodeError:
            return None, None, None

        async with self._lock:
            current_time = now if now is not None else time.time()
            room = self.rooms.get(code)
            if not room:
                return None, None, None

            departed = room.participants.pop(session_id, None)
            if not departed:
                return room, None, None

            # Revoke credentials immediately
            departed.reconnect_token_hash = None
            departed.status = "removed"
            departed.websocket = None

            room.last_activity_at = current_time
            remaining = next(iter(room.participants.values())) if room.participants else None

            # If room is now empty, delete room
            if room.is_empty():
                del self.rooms[code]
                return None, departed, None

            return room, departed, remaining

    async def cleanup_expired_rooms(
        self,
        ttl: float | None = None,
        now: float | None = None,
    ) -> list[str]:
        """Safely remove rooms and participants that have exceeded their time-to-live."""
        effective_ttl = ttl if ttl is not None else self.default_ttl
        current_time = now if now is not None else time.time()
        expired_codes: list[str] = []

        async with self._lock:
            for code, room in list(self.rooms.items()):
                # 1. Prune disconnected participants whose grace period expired
                pruned = room.prune_expired_participants(now=current_time, grace_period=self.grace_period)
                if pruned:
                    for p in pruned:
                        for other in room.get_other_participants(p.session_id):
                            if other and other.status == "connected" and other.websocket:
                                try:
                                    import json
                                    asyncio.create_task(
                                        other.websocket.send_text(
                                            json.dumps({
                                                "type": "peer-left",
                                                "payload": {
                                                    "room_code": code,
                                                    "peer_session_id": p.session_id,
                                                    "reason": "Peer disconnected and reconnect window expired.",
                                                },
                                            })
                                        )
                                    )
                                except Exception:
                                    pass

                # 2. Check if room is empty or TTL expired
                if room.is_empty() or room.is_expired(now=current_time, ttl=effective_ttl):
                    expired_codes.append(code)
                    del self.rooms[code]

        return expired_codes

    def get_stats(self) -> dict[str, int]:
        """Synchronously return current active room and connection count."""
        active_rooms = len(self.rooms)
        active_connections = sum(
            sum(1 for p in r.participants.values() if p.status == "connected")
            for r in self.rooms.values()
        )
        return {
            "active_rooms": active_rooms,
            "active_connections": active_connections,
        }


# Global singleton room manager instance
room_manager = RoomManager()
