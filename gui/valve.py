"""视频通道阀门 —— 一个独立的小窗口，随时开关通道。

不是 DSH 里的弹窗：这是一个真正的桌面程序窗口，改了立刻写进 state.json，
插件每次读取前都会重读，所以不需要重启 DSH。

启动：双击仓库根目录的「启动阀门.cmd」，或
    pythonw gui/valve.py
"""

from __future__ import annotations

import os
import sys
import threading
import tkinter as tk
from tkinter import messagebox, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "_vendor"))
import valve_state as vs  # noqa: E402

# 托盘是可选的：装了 pystray + Pillow 就缩到托盘，没装就缩到任务栏。
try:
    import pystray  # type: ignore
    from PIL import Image, ImageDraw  # type: ignore

    HAVE_TRAY = True
except Exception:
    HAVE_TRAY = False


def enable_dpi_awareness() -> None:
    try:
        from ctypes import windll

        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass


class ValveWindow:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.vars: dict[str, tk.BooleanVar] = {}
        self.syncing = False
        self.pending: str | None = None
        self.tray = None

        root.title("视频通道阀门")
        root.resizable(False, False)
        root.attributes("-topmost", True)
        root.configure(padx=14, pady=12)
        root.protocol("WM_DELETE_WINDOW", self.on_close)

        header = ttk.Label(root, text="视频通道阀门", font=("Microsoft YaHei UI", 13, "bold"))
        header.grid(row=0, column=0, columnspan=2, sticky="w")

        hint = ttk.Label(
            root,
            text="勾选=允许读取，取消=一律拒绝。改动立即生效，无需重启。",
            foreground="#666666",
        )
        hint.grid(row=1, column=0, columnspan=2, sticky="w", pady=(2, 10))

        row = 2
        for name, label in vs.CHANNELS:
            var = tk.BooleanVar(value=False)
            self.vars[name] = var
            check = ttk.Checkbutton(
                root,
                text=label,
                variable=var,
                command=lambda n=name: self.on_toggle(n),
            )
            check.grid(row=row, column=0, columnspan=2, sticky="w", pady=3)
            row += 1

        buttons = ttk.Frame(root)
        buttons.grid(row=row, column=0, columnspan=2, sticky="we", pady=(12, 6))
        row += 1

        ttk.Button(buttons, text="全部关闭", command=lambda: self.bulk(False)).pack(side="left")
        ttk.Button(buttons, text="全部打开", command=lambda: self.bulk(True)).pack(side="left", padx=6)
        ttk.Button(buttons, text="刷新", command=self.sync).pack(side="left")

        self.topmost = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            root,
            text="窗口置顶",
            variable=self.topmost,
            command=lambda: root.attributes("-topmost", self.topmost.get()),
        ).grid(row=row, column=0, sticky="w", pady=(0, 8))
        row += 1

        self.status = ttk.Label(root, text="", font=("Microsoft YaHei UI", 9), foreground="#333333")
        self.status.grid(row=row, column=0, columnspan=2, sticky="w")
        row += 1

        session = ttk.Frame(root)
        session.grid(row=row, column=0, columnspan=2, sticky="we", pady=(6, 0))
        row += 1
        self.session_label = ttk.Label(session, text="", font=("Microsoft YaHei UI", 9), foreground="#333333")
        self.session_label.pack(side="left")
        ttk.Button(session, text="退出 B 站登录", command=self.logout).pack(side="right")

        self.path_label = ttk.Label(
            root,
            text=str(vs.STATE_FILE),
            font=("Consolas", 8),
            foreground="#888888",
            wraplength=360,
        )
        self.path_label.grid(row=row, column=0, columnspan=2, sticky="w", pady=(4, 0))

        self.sync()
        self.poll()

    # ------------------------------------------------------------------ 交互

    def on_close(self) -> None:
        """点关闭 = 收起来，而不是退出。"""
        if HAVE_TRAY:
            self.ensure_tray()
            self.root.withdraw()
        else:
            self.root.iconify()

    def ensure_tray(self) -> None:
        if self.tray is not None or not HAVE_TRAY:
            return
        image = Image.new("RGB", (64, 64), (16, 26, 43))
        draw = ImageDraw.Draw(image)
        draw.ellipse((10, 10, 54, 54), fill=(255, 209, 102))
        menu = pystray.Menu(
            pystray.MenuItem("显示窗口", lambda: self._post("show"), default=True),
            pystray.MenuItem("全部关闭", lambda: self._post("all-off")),
            pystray.MenuItem("全部打开", lambda: self._post("all-on")),
            pystray.MenuItem("退出", lambda: self._post("quit")),
        )
        self.tray = pystray.Icon("video-gate", image, "视频通道阀门", menu)
        threading.Thread(target=self.tray.run, daemon=True).start()

    def _post(self, action: str) -> None:
        """托盘线程只写一个标记，真正的 Tk 操作留给主线程的轮询去做。"""
        self.pending = action

    def restore(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.attributes("-topmost", self.topmost.get())

    def on_toggle(self, name: str) -> None:
        if self.syncing:
            return
        vs.set_channel(name, bool(self.vars[name].get()))
        self.render(vs.load())

    def bulk(self, on: bool) -> None:
        vs.set_all(on)
        self.sync()

    def logout(self) -> None:
        removed = vs.logout()
        self.session_label.configure(
            text="登录态：未保存（已删除）" if removed else "登录态：未保存",
        )
        if removed:
            messagebox.showinfo("视频通道阀门", "已删掉本地保存的 B 站登录态（SESSDATA）。\n想再用时说「登录 B 站」重新拿一次。")

    # ------------------------------------------------------------------ 显示

    def sync(self) -> None:
        self.render(vs.load())

    def render(self, state: dict) -> None:
        self.syncing = True
        try:
            for name, var in self.vars.items():
                var.set(bool(state["channels"].get(name)))
        finally:
            self.syncing = False

        on = [label for name, label in vs.CHANNELS if state["channels"].get(name)]
        summary = "、".join(on) if on else "全部关闭"
        self.status.configure(text=f"当前允许：{summary}\n最近：{vs.last_event()}")
        self.session_label.configure(
            text="登录态：已保存（用完记得退出）" if vs.has_session() else "登录态：未保存",
        )

    def poll(self) -> None:
        """外部（插件/命令行）改了状态时，窗口跟着变；顺便处理托盘点单。"""
        action, self.pending = self.pending, None
        if action == "show":
            self.restore()
        elif action == "all-off":
            self.bulk(False)
        elif action == "all-on":
            self.bulk(True)
        elif action == "quit":
            if self.tray is not None:
                try:
                    self.tray.stop()
                except Exception:
                    pass
            self.root.destroy()
            return
        try:
            self.render(vs.load())
        except Exception:
            pass
        self.root.after(1500, self.poll)


def main() -> None:
    enable_dpi_awareness()
    root = tk.Tk()
    ValveWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
