"""视频通道阀门 —— 一个独立的小窗口，随时开关通道。

不是 DSH 里的弹窗：这是一个真正的桌面程序窗口，改了立刻写进 state.json，
插件每次读取前都会重读，所以不需要重启 DSH。

启动：双击仓库根目录的「启动阀门.cmd」，或
    pythonw gui/valve.py
"""

from __future__ import annotations

import os
import sys
import tkinter as tk
from tkinter import ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import valve_state as vs  # noqa: E402


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

        root.title("视频通道阀门")
        root.resizable(False, False)
        root.attributes("-topmost", True)
        root.configure(padx=14, pady=12)

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

    def on_toggle(self, name: str) -> None:
        if self.syncing:
            return
        vs.set_channel(name, bool(self.vars[name].get()))
        self.render(vs.load())

    def bulk(self, on: bool) -> None:
        vs.set_all(on)
        self.sync()

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

    def poll(self) -> None:
        """外部（插件/命令行）改了状态时，窗口跟着变。"""
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
