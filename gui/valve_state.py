"""视频通道阀门的状态读写（与插件共用同一个 state.json）。

只做三件事：读、写、记审计。不联网、不读注册表、不碰别的目录。
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("VIDEO_GATE_HOME") or (Path.home() / ".dsh" / "video-gate"))
STATE_FILE = STATE_DIR / "state.json"
AUDIT_FILE = STATE_DIR / "audit.jsonl"

CHANNELS: list[tuple[str, str]] = [("local", "本地文件"), ("bilibili", "Bilibili")]

DEFAULTS: dict = {
    "version": 1,
    "channels": {"local": True, "bilibili": False},
    "localRoots": [],
    "auditLog": True,
}


def _defaults() -> dict:
    return json.loads(json.dumps(DEFAULTS))


def load() -> dict:
    """读 state.json；不存在或损坏时返回默认值，绝不抛异常。"""
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return _defaults()
    if not isinstance(raw, dict):
        return _defaults()

    state = _defaults()
    state.update(raw)

    channels = raw.get("channels")
    merged = dict(DEFAULTS["channels"])
    if isinstance(channels, dict):
        for name in merged:
            value = channels.get(name)
            if isinstance(value, bool):
                merged[name] = value
    state["channels"] = merged

    roots = raw.get("localRoots")
    state["localRoots"] = [r for r in roots if isinstance(r, str) and r.strip()] if isinstance(roots, list) else []
    return state


def save(state: dict) -> None:
    """原子写：先写同目录临时文件，再 replace，避免插件读到半个文件。"""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=str(STATE_DIR))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
        os.replace(tmp, STATE_FILE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def audit(record: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}, ensure_ascii=False)
        with AUDIT_FILE.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(line + "\n")
    except Exception:
        pass


def set_channel(name: str, on: bool) -> dict:
    state = load()
    current = bool(state["channels"].get(name))
    if current == on:
        return state
    state["channels"][name] = on
    save(state)
    audit({"event": "channel-open" if on else "channel-close", "channel": name, "via": "valve-window"})
    return state


def set_all(on: bool) -> dict:
    state = load()
    changed = []
    for name, _label in CHANNELS:
        if bool(state["channels"].get(name)) != on:
            state["channels"][name] = on
            changed.append(name)
    if changed:
        save(state)
        audit({"event": "valve-set", "channels": dict(state["channels"]), "via": "valve-window"})
    return state


def last_event() -> str:
    """审计日志最后一条的简要描述，用来在窗口里显示“最近发生了什么”。"""
    try:
        lines = AUDIT_FILE.read_text(encoding="utf-8").splitlines()
    except Exception:
        return "（还没有记录）"
    for line in reversed(lines[-200:]):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        at = str(event.get("at", ""))[11:19]
        kind = event.get("event", "")
        channel = event.get("channel", "")
        if kind == "read":
            frames = event.get("frames", 0)
            return f"{at} 读取 {channel}（{frames} 帧）" if event.get("ok", True) else f"{at} 读取 {channel} 失败"
        if kind in ("armed", "disarmed"):
            return f"{at} {'启用' if kind == 'armed' else '停用'}视频插件"
        if kind in ("channel-open", "channel-close", "grant-once", "grant-session"):
            label = {"channel-open": "打开通道", "channel-close": "关闭通道",
                     "grant-once": "放行一次", "grant-session": "本会话放行"}[kind]
            return f"{at} {label} {channel}"
        if kind == "valve-set":
            return f"{at} 批量设置阀门"
        if kind == "denied":
            return f"{at} 拒绝 {channel}"
    return "（还没有记录）"


__all__ = [
    "STATE_DIR", "STATE_FILE", "AUDIT_FILE", "CHANNELS",
    "load", "save", "audit", "set_channel", "set_all", "last_event",
]
