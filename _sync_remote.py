#!/usr/bin/env python3
"""临时同步脚本：将本地 chunk-release 提交推送到 GitHub origin/main。"""
import subprocess, sys, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))
r = subprocess.run(
    ["git", "push", "origin", "main"],
    capture_output=True, text=True, timeout=90,
)
print("STDOUT:", r.stdout)
print("STDERR:", r.stderr)
print("RC:", r.returncode)
sys.exit(r.returncode)
