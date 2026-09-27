#!/usr/bin/env python3
"""Diagnose pi-tui autocomplete triggering for /context-window-cap.

Each scenario runs in a fresh PTY; each stage takes a fresh screen snapshot.
Compares our extension command against built-in /model as control.
"""
import os
import pty
import re
import select
import time

CUP = re.compile(r"\x1b\[(\d+);(\d+)H")
COLS, ROWS = 140, 42


def read_available(fd, timeout=0.4):
    out = b""
    while True:
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            return out
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return out
        if not chunk:
            return out
        out += chunk
        timeout = 0.12


def screen_lines(raw, cols=COLS, rows=ROWS):
    grid = [[" "] * cols for _ in range(rows)]
    row = col = 0
    i = 0
    data = raw.decode("utf-8", "replace")
    while i < len(data):
        ch = data[i]
        if ch == "\x1b":
            m = CUP.match(data, i)
            if m:
                row, col = int(m.group(1)) - 1, int(m.group(2)) - 1
                i = m.end()
                continue
            if i + 1 < len(data) and data[i + 1] == "[":
                j = i + 2
                while j < len(data) and not ("\x40" <= data[j] <= "\x7e"):
                    j += 1
                i = j + 1
                continue
            i += 2
            continue
        if ch == "\r":
            col = 0
        elif ch == "\n":
            row += 1
        elif ch == "\x08":
            col = max(0, col - 1)
        elif ch == "\x07":
            pass
        else:
            if 0 <= row < rows and 0 <= col < cols:
                grid[row][col] = ch
            col += 1
        i += 1
    return ["".join(r).rstrip() for r in grid]


def stage(fd, label, probes, keys=None, wait=0.55):
    if keys is not None:
        for k in keys:
            os.write(fd, k.encode())
            time.sleep(0.03)
        time.sleep(wait)
    raw = read_available(fd, 0.5)
    lines = screen_lines(raw)
    hits = [p for p in probes if any(p in l for l in lines)]
    print(f"  {label:48} -> {', '.join(hits) if hits else '-- nothing --'}")
    if os.environ.get("VERBOSE"):
        for l in lines:
            if any(p in l for p in probes) or "/context" in l or "/model" in l:
                print(f"      | {l}")
    return hits


def session(name, body):
    print(f"=== {name} ===")
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(COLS)
        os.environ["LINES"] = str(ROWS)
        os.execvp("pi", ["pi", "--no-session"])
        os._exit(1)
    try:
        deadline = time.time() + 15
        boot = b""
        while time.time() < deadline:
            boot += read_available(fd, 0.5)
            if boot.count(b"\x1b[") > 20:
                break
        time.sleep(0.8)
        read_available(fd, 0.4)
        body(fd)
        os.write(fd, b"\x03")
        time.sleep(0.3)
    finally:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


CMDS = ["toggle", "off", "set", "status"]
CMD = "/context-window-cap"
typing_cmd = ["/"] + list("context-window-cap")


def slow_manual(fd):
    stage(fd, "after '/'", ["toggle", "model", "thinking"], keys=["/"])
    stage(fd, f"after full name (no space)", CMDS + ["context-window-cap"], keys=typing_cmd[1:])
    stage(fd, "after ' ' space", CMDS, keys=[" "])


def fast_manual(fd):
    stage(fd, "typing full cmd fast (0.02s/key) + space", CMDS, keys=typing_cmd + [" "], wait=0.8)
    stage(fd, "then first arg letter 't'", ["toggle"], keys=["t"])


def tab_accept(fd):
    stage(fd, "typed '/context-w'", ["context-window-cap"], keys=["/"] + list("context-w"))
    stage(fd, "after Tab accept", CMDS, keys=["\t"], wait=0.8)
    stage(fd, "after next key 't'", ["toggle"], keys=["t"])


def esc_then_space(fd):
    stage(fd, "typed full cmd", ["context-window-cap"], keys=typing_cmd)
    stage(fd, "Esc dismiss", CMDS, keys=["\x1b"])
    stage(fd, "after space", CMDS, keys=[" "])


def model_control(fd):
    stage(fd, "typed '/model' (no space)", ["anthropic", "openai", "Providers"], keys=["/"] + list("model"))
    stage(fd, "after ' ' space", ["anthropic", "openai", "xiaomi"], keys=[" "])


session("A: slow manual typing + space", slow_manual)
session("B: fast typing + space", fast_manual)
session("C: Tab-accept command name", tab_accept)
session("D: Esc-dismiss then space", esc_then_space)
session("E: control - built-in /model", model_control)
