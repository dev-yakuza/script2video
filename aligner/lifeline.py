"""The server exits with the CLI that started it (stdlib only, so CI can test it cheaply)."""

from __future__ import annotations

import os
import threading


def exit_with_parent() -> None:
    """With S2V_LIFELINE=1, stdin is a pipe from the CLI that started this server: exit when it
    closes, so a CLI killed outright (SIGKILL) leaves no server holding memory (S8)."""
    if os.environ.get("S2V_LIFELINE") != "1":
        return

    def watch() -> None:
        while os.read(0, 4096):
            pass
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()
