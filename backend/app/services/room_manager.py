"""In-memory room manager for PairPort WebSockets signaling.

Maintains room state, participant sessions, and life-cycle events.
Note: Room state is stored entirely in memory for Phase 3.
Rooms reset when the server restarts and are not shared across multiple processes/instances.
"""

from __future__ import annotations

import asyncio
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.config import (
    MAX_ACTIVE_ROOMS,
    MAX_PARTICIPANTS_PER_ROOM,
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


class DuplicateConnectionError(RoomError):
    code = "DUPLICATE_CONNECTION"


class ServerCapacityError(RoomError):
    code = "SERVER_FULL"


def normalize_room_code(raw_code: str) -> str:
    """Normalize input room code.
    
    Trims whitespace, converts to uppercase, and ensures standard PORT-XXXX formatting.
    Accepts formats such as:
    - 'PORT-7K2M' -> 'PORT-7K2M'
    - 'port-7k2m' -> 'PORT-7K2M'
    - '7k2m'      -> 'PORT-7K2M'
    - 'PORT7K2M'  -> 'PORT-7K2M'
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
            f"Invalid room code length. Expected {ROOM_CODE_PREFIX}XXXX format."
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
    """Represents a connected peer in a room."""
    session_id: str
    role: str  # 'host' or 'guest'
    websocket: Any
    joined_at: float = field(default_factory=time.time)


@dataclass
class Room:
    """Represents an active in-memory sharing room."""
    code: str
    created_at: float = field(default_factory=time.time)
    last_activity_at: float = field(default_factory=time.time)
    participants: dict[str, Participant] = field(default_factory=dict)

    def is_full(self) -> bool:
        return len(self.participants) >= MAX_PARTICIPANTS_PER_ROOM

    def is_empty(self) -> bool:
        return len(self.participants) == 0

    def is_expired(self, now: float | None = None, ttl: float = ROOM_TTL_SECONDS) -> bool:
        current = now if now is not None else time.time()
        return (current - self.created_at) > ttl

    def get_other_participant(self, session_id: str) -> Participant | None:
        for sid, p in self.participants.items():
            if sid != session_id:
                return p
        return None

    def get_host(self) -> Participant | None:
        for p in self.participants.values():
            if p.role == "host":
                return p
        return None


class RoomManager:
    """In-memory coordinator for room lifecycles and peer membership."""

    def __init__(self, default_ttl: float = ROOM_TTL_SECONDS) -> None:
        self.rooms: dict[str, Room] = {}
        self.default_ttl = default_ttl
        self._lock = asyncio.Lock()

    async def create_room(self, ttl: float | None = None) -> Room:
        """Create a new room with a unique random code."""
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
                    # Expand code length in the rare case of high collision
                    code = generate_unambiguous_code(length=ROOM_CODE_LENGTH + 2)
                    if code not in self.rooms:
                        break

            now = time.time()
            room = Room(code=code, created_at=now, last_activity_at=now)
            self.rooms[code] = room
            return room

    async def get_room(self, raw_code: str, check_expiry: bool = True) -> Room:
        """Retrieve a room by code, validating format and expiration."""
        code = normalize_room_code(raw_code)
        async with self._lock:
            room = self.rooms.get(code)
            if not room:
                raise RoomNotFoundError(f"Room '{code}' does not exist.")

            if check_expiry and room.is_expired(ttl=self.default_ttl):
                # Expired room: remove it
                del self.rooms[code]
                raise RoomExpiredError(f"Room '{code}' has expired.")

            return room

    async def join_room(self, raw_code: str, websocket: Any) -> tuple[Room, Participant]:
        """Join an existing room as a participant.
        
        Assigns a server-generated UUID session ID and determines role:
        - If room has no active host or 0 participants, assigned role is 'host'.
        - Otherwise, assigned role is 'guest'.
        """
        code = normalize_room_code(raw_code)
        async with self._lock:
            room = self.rooms.get(code)
            if not room:
                raise RoomNotFoundError(f"Room '{code}' does not exist.")

            now = time.time()
            if room.is_expired(now=now, ttl=self.default_ttl):
                del self.rooms[code]
                raise RoomExpiredError(f"Room '{code}' has expired.")

            if room.is_full():
                raise RoomFullError(f"Room '{code}' already has the maximum of {MAX_PARTICIPANTS_PER_ROOM} participants.")

            # Assign identity securely on the server
            session_id = uuid.uuid4().hex

            # Assign role
            has_host = any(p.role == "host" for p in room.participants.values())
            role = "host" if not has_host else "guest"

            participant = Participant(
                session_id=session_id,
                role=role,
                websocket=websocket,
                joined_at=now,
            )

            room.participants[session_id] = participant
            room.last_activity_at = now
            return room, participant

    async def leave_room(
        self,
        raw_code: str,
        session_id: str,
    ) -> tuple[Room | None, Participant | None, Participant | None]:
        """Remove a participant from a room.
        
        Returns a tuple: (room, departed_participant, remaining_participant)
        If the room is empty after leaving, it is cleaned up.
        """
        try:
            code = normalize_room_code(raw_code)
        except InvalidRoomCodeError:
            return None, None, None

        async with self._lock:
            room = self.rooms.get(code)
            if not room:
                return None, None, None

            departed = room.participants.pop(session_id, None)
            if not departed:
                return room, None, None

            room.last_activity_at = time.time()
            remaining = next(iter(room.participants.values())) if room.participants else None

            # If room is now empty, delete room
            if room.is_empty():
                del self.rooms[code]
                return None, departed, None

            return room, departed, remaining

    async def cleanup_expired_rooms(self, ttl: float | None = None) -> list[str]:
        """Safely remove rooms that have exceeded their time-to-live."""
        effective_ttl = ttl if ttl is not None else self.default_ttl
        now = time.time()
        expired_codes: list[str] = []

        async with self._lock:
            for code, room in list(self.rooms.items()):
                if room.is_expired(now=now, ttl=effective_ttl):
                    expired_codes.append(code)
                    del self.rooms[code]

        return expired_codes

    def get_stats(self) -> dict[str, int]:
        """Synchronously return current active room and connection count."""
        active_rooms = len(self.rooms)
        active_connections = sum(len(r.participants) for r in self.rooms.values())
        return {
            "active_rooms": active_rooms,
            "active_connections": active_connections,
        }


# Global singleton room manager instance
room_manager = RoomManager()
