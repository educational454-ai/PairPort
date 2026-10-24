"""Health-check route used to verify that the backend is running."""

from fastapi import APIRouter
from app.services.room_manager import room_manager

router = APIRouter(tags=["health"])


@router.get("/health")
def health_check() -> dict[str, str | int]:
    stats = room_manager.get_stats()
    return {
        "status": "ok",
        "service": "pairport-api",
        "active_rooms": stats["active_rooms"],
        "active_connections": stats["active_connections"],
    }
