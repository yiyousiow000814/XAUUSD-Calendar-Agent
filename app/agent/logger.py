import logging
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from .config import get_log_dir


def setup_logger(debug: bool) -> logging.Logger:
    log_dir = get_log_dir()
    level = logging.DEBUG if debug else logging.INFO

    logger = logging.getLogger("xauusd_calendar_agent")
    logger.setLevel(level)
    logger.handlers.clear()

    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%d-%m-%Y %H:%M:%S",
    )

    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "app.log"
        file_handler = TimedRotatingFileHandler(
            Path(log_path),
            when="midnight",
            backupCount=14,
            encoding="utf-8",
            delay=True,
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except OSError:
        logger.addHandler(logging.NullHandler())

    return logger
