import sys
from pathlib import Path

APP_TITLE = "XAUUSD Calendar Agent"
APP_ICON = "assets/xauusd.ico"

UI_COLORS = {
    "bg": "#f5f2ec",
    "card": "#ffffff",
    "ink": "#1f1c18",
    "muted": "#6c675f",
    "accent": "#b07b2c",
    "accent_dark": "#8a5d1a",
    "accent_soft": "#f1e3cf",
    "border": "#e2d8c9",
    "shadow": "#efe7db",
    "header": "#fbf8f3",
    "info": "#2563eb",
    "warn": "#d97706",
    "error": "#b42318",
    "status_idle": "#9a948b",
    "status_running": "#2563eb",
}

UI_FONTS = {
    "title": ("Georgia", 22, "bold"),
    "subtitle": ("Segoe UI", 10),
    "section": ("Segoe UI Semibold", 11),
    "body": ("Segoe UI", 10),
    "mono": ("Consolas", 9),
}


def get_asset_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / relative


def parse_version(value: str) -> tuple:
    parts = value.split(".")
    numbers = []
    for part in parts:
        try:
            numbers.append(int(part))
        except ValueError:
            numbers.append(0)
    return tuple(numbers)
