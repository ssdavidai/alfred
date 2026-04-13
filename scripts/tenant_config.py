"""Shared tenant SSH config for audit scripts."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass


@dataclass
class Tenant:
    name: str
    ssh_key: str
    ip: str


TENANTS: dict[str, Tenant] = {
    "david": Tenant("david", os.path.expanduser("~/.ssh/alfred-david-99"), "100.119.63.29"),
    "miguel": Tenant("miguel", os.path.expanduser("~/.ssh/alfred-miguel-103"), "100.72.147.32"),
    "rapali": Tenant("rapali", os.path.expanduser("~/.ssh/alfred-rapali-101"), "100.121.134.35"),
}


def ssh_exec(tenant: Tenant, cmd: str, timeout: int = 30) -> tuple[int, str]:
    """Execute a command on a tenant via SSH. Returns (exit_code, output).

    Pipes the command via stdin (`bash -s`) to avoid quote-escaping issues
    with nested Python/JSON in complex scripts.
    """
    full_cmd = [
        "ssh",
        "-o", "IdentityAgent=none",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-i", tenant.ssh_key,
        f"deploy@{tenant.ip}",
        "bash -s",
    ]
    try:
        result = subprocess.run(
            full_cmd, capture_output=True, text=True, timeout=timeout,
            input=cmd,
        )
        output = result.stdout + result.stderr
        return result.returncode, output.strip()
    except subprocess.TimeoutExpired:
        return -1, "SSH_TIMEOUT"
    except Exception as e:
        return -1, f"SSH_ERROR: {e}"


def get_tenant(name: str) -> Tenant:
    if name not in TENANTS:
        raise ValueError(f"Unknown tenant: {name}. Available: {', '.join(TENANTS)}")
    return TENANTS[name]
