"""Restricted bridge to the released native /audit entry point.

Preflight never creates a Session or resolves provider credentials. Configuration
values stay in memory; diagnostics never include their contents.
"""

# Swival imports remain lazy so preflight cannot initialize a provider.
# pylint: disable=import-outside-toplevel

import argparse
import contextlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import re
import select
import sys
import threading
import time
import tomllib


class NativeAuditError(Exception):
    """A safe, value-free native availability diagnostic."""


ROUTING_KEYS = {
    "provider", "model", "base_url", "api_key", "user_agent", "aws_profile",
    "project", "location", "extra_body", "max_output_tokens", "max_context_tokens",
    "temperature", "top_p", "seed", "reasoning_effort", "sanitize_thinking",
    "show_thinking", "provider_timeout", "max_turns", "retries", "prompt_cache",
}
OVERRIDE_KEYS = {
    "provider": "provider", "model": "model", "baseUrl": "base_url",
    "reasoningEffort": "reasoning_effort", "temperature": "temperature",
    "topP": "top_p", "seed": "seed", "maxOutputTokens": "max_output_tokens",
    "maxTurns": "max_turns", "providerTimeout": "provider_timeout",
}


def _protected(config):
    for key, value in config.items():
        if key == "llm_filter" or key == "secret_shield" or (
            key.startswith("encrypt_secrets") and value is not False
        ):
            return True
        if isinstance(value, dict) and _protected(value):
            return True
    return False


def _read_config(filename, *, project=False):
    from swival import config as config_module  # No Session/provider initialization.

    if not filename.exists():
        return {}
    if project and filename.is_symlink():
        raise NativeAuditError("Unsupported symlinked project configuration.")
    if not filename.is_file() or filename.stat().st_size > 128 * 1024:
        raise NativeAuditError("Unsupported or oversized native configuration.")
    try:
        raw = tomllib.loads(filename.read_text(encoding="utf-8"))
    except (ValueError, OSError, UnicodeError) as exc:
        raise NativeAuditError(
            "Unknown native configuration requirements: unreadable TOML."
        ) from exc
    if _protected(raw):
        raise NativeAuditError(
            "Protected native routes are unsupported: upstream omits shielding/filtering."
        )
    known = set(config_module.CONFIG_KEYS) | {
        "profiles", "active_profile", "audit", "mcp_servers", "a2a_servers", "serve_skills",
        "encrypt_secrets_patterns",
    }
    if set(raw) - known:
        raise NativeAuditError("Unknown native configuration requirements.")
    if project and (set(raw) & (ROUTING_KEYS | {"profiles", "active_profile"})):
        raise NativeAuditError("Unsupported project-supplied native provider routing.")
    if raw.get("files") == "none" or raw.get("network") == "none" or raw.get("sandbox") == "nono":
        raise NativeAuditError("Unsupported restrictive native filesystem/network configuration.")
    if (raw.get("sandbox_strict_read") or raw.get("lifecycle_fail_closed")
            or any(value for key, value in raw.items() if key.startswith("nono_"))):
        raise NativeAuditError("Unsupported required sandbox or lifecycle isolation control.")
    # Released validation, with all value-bearing warnings/errors suppressed.
    try:
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            validated = config_module._load_single(filename, "native configuration")  # pylint: disable=protected-access
    except Exception as exc:
        raise NativeAuditError("Unknown or unsupported native configuration requirements.") from exc
    return validated


def resolve_native_config(request):
    """Resolve routing without instantiating a provider or weakening requirements."""
    from swival import config as config_module

    if importlib.metadata.version("swival") != "1.0.46" or sys.version_info < (3, 13):
        raise NativeAuditError(
            "Unsupported native runtime; this bridge verifies Swival 1.0.46 on Python 3.13+."
        )
    protected_environment = ("SWIVAL_ENCRYPT_KEY", "SWIVAL_LLM_FILTER", "SWIVAL_SECRET_SHIELD")
    if any(name in os.environ for name in protected_environment):
        raise NativeAuditError("Protected native environment requirements are unsupported.")
    source = Path(request["source"]).resolve()
    global_config = _read_config(config_module.global_config_dir() / "config.toml")
    _read_config(source / "swival.toml", project=True)
    routing = request.get("routing", {})
    if not isinstance(routing, dict) or set(routing) - (set(OVERRIDE_KEYS) | {"profile"}):
        raise NativeAuditError("Unknown native routing override requirements.")
    config = dict(global_config)
    profile = routing["profile"] if "profile" in routing else config.get("active_profile")
    if "profile" in routing and (not isinstance(profile, str) or not profile):
        raise NativeAuditError("Native profile is missing or unavailable; no fallback.")
    try:
        config_module.resolve_profile_config(argparse.Namespace(profile=profile), config)
    except Exception as exc:
        raise NativeAuditError("Native profile is missing or unavailable; no fallback.") from exc
    for external, internal in OVERRIDE_KEYS.items():
        if external in routing:
            config[internal] = routing[external]
    if config.get("provider", "lmstudio") not in {
        "lmstudio", "openrouter", "generic", "chatgpt", "bedrock", "vertexai", "huggingface",
    }:
        raise NativeAuditError(
            "Unsupported native provider; executable provider routes are forbidden."
        )
    if not config.get("model"):
        raise NativeAuditError(
            "Native audit requires an explicit configured model; no auto-discovery or fallback."
        )
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            config_module._validate_config(  # pylint: disable=protected-access
                {k: v for k, v in config.items() if k in ROUTING_KEYS}, "native routing"
            )
        if config.get("reasoning_effort") not in (None, *config_module.REASONING_LEVELS):
            raise ValueError("unsupported effort")
    except Exception as exc:
        raise NativeAuditError("Unsupported native routing values.") from exc
    settings = {k: v for k, v in config.items() if k in ROUTING_KEYS}
    settings.setdefault("provider", "lmstudio")
    public = {"provider": settings["provider"], "model": settings["model"],
              "reasoningEffort": settings.get("reasoning_effort"), "profile": profile}
    return settings, public


def native_scope(request):
    """Use the released Git scope matcher, never host-path expansion."""
    from swival.audit import _resolve_scope  # pylint: disable=protected-access

    options = request.get("audit", {})
    paths = options.get("paths", [])
    if not isinstance(paths, list) or len(paths) > 64:
        raise NativeAuditError("Unsupported native audit paths.")
    for token in paths:
        if (not isinstance(token, str) or not re.fullmatch(r"[\w.*?\[\]/-]+", token)
                or token.startswith(("/", "-")) or any(p in (".", "..") for p in token.split("/"))):
            raise NativeAuditError("Unsupported native audit path token.")
    for key, limit in (("workers", 8), ("patchMaxTurns", 100)):
        value = options.get(key, 4 if key == "workers" else 50)
        if type(value) is not int or not 1 <= value <= limit:  # pylint: disable=unidiomatic-typecheck
            raise NativeAuditError("Unsupported bounded native audit option.")
    return _resolve_scope(request["snapshot"], paths).to_dict()


@contextlib.contextmanager
def _expansion_failures(max_files):
    """Observe the 1.0.46 warning emitted only for retained, lossy deep reviews.

    All-failed attempts raise and can recover through native retries. Successful
    repairs, empty inventories, and out-of-scope discards do not emit this warning.
    Keep only counts, never paths, findings, or value-bearing exception text.
    """
    from swival import audit

    warning = audit._ui_warning  # pylint: disable=protected-access
    failures = []
    lock = threading.Lock()

    def observe(ui, message):
        match = re.fullmatch(
            r"  .+: ([0-9]+)/([0-9]+) expansion\(s\) failed, ([0-9]+) finding\(s\) retained",
            message,
        )
        if match:
            failed, inventory, retained = map(int, match.groups())
            if 0 < failed < inventory and 0 < retained <= inventory - failed:
                with lock:
                    if len(failures) >= max_files:
                        raise NativeAuditError("Native expansion evidence limit exceeded.")
                    failures.append(failed)
        warning(ui, message)

    audit._ui_warning = observe  # pylint: disable=protected-access
    try:
        yield failures
    finally:
        audit._ui_warning = warning  # pylint: disable=protected-access


def run_native(request):
    """Dispatch exactly one /audit with fixed, restrictive Session policies."""
    if sys.platform == "darwin" and request.get("agentfsVersion") == "0.6.4":
        raise NativeAuditError(
            "Native audit is blocked on Darwin/macOS with AgentFS 0.6.4: writable temporary roots."
        )
    if sys.platform != "linux" or request.get("agentfsVersion") != "0.6.4":
        raise NativeAuditError("Unverified native AgentFS/platform isolation; no fallback.")
    settings, public = resolve_native_config(request)
    scope = native_scope(request)
    if not scope["mandatory_files"]:
        return {"status": "empty_scope", "error": "No auditable committed files in scope.",
                "scope": scope}
    if request.get("expectedScope") != scope:
        raise NativeAuditError("Native committed scope changed after preflight.")
    if os.environ.get("AGENTFS") != "1":
        raise NativeAuditError("Native audit requires an external AgentFS sandbox; no fallback.")
    from swival.session import Session

    options = request["audit"]
    command = "/audit " + " ".join([
        *options.get("paths", []), *( ["--all"] if options.get("all") else [] ),
        "--workers", str(options["workers"]), "--patch-max-turns", str(options["patchMaxTurns"]),
    ])
    with _expansion_failures(len(scope["mandatory_files"])) as failures, Session(
                 **settings, base_dir=request["snapshot"], files="some", commands="none",
                 sandbox="agentfs", sandbox_auto_session=False, network="provider-only",
                 no_instructions=True, no_skills=True, metaskills="off", memory=False,
                 history=False, continue_here=False, subagents=False, lifecycle_enabled=False,
                 mcp_servers=None, a2a_servers=None, trace_dir=None, read_guard=True) as session:
        result = session.ask(command, parse_commands=True)
    return {"status": "failed" if result.exhausted else "partial" if failures else "completed",
            "unrecoveredExpansionFailures": sum(failures), "answer": result.answer,
            "scope": scope, "provider": public["provider"], "model": public["model"],
            "requestedEffort": public["reasoningEffort"], "network": "provider-only",
            "sandbox": {"agentfs": True, "agentfsVersion": request.get("agentfsVersion")},
            "verification": "Native verifier judgment; project commands and PoCs cannot execute."}


def launch_native():
    """Wait for live ownership and a bounded commit before executing AgentFS."""
    if len(sys.argv) != 6:
        raise NativeAuditError("Unsupported native launcher arguments.")
    agentfs, snapshot, evidence, session = sys.argv[2:]
    if (not all(os.path.isabs(value) for value in (agentfs, snapshot, evidence))
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session)):
        raise NativeAuditError("Unsupported fixed native launcher scope.")
    deadline = time.monotonic() + 5
    token = b""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([3], [], [], remaining)[0]:
            raise NativeAuditError("Native ownership commit timed out.")
        chunk = os.read(3, 6 - len(token))
        if not chunk:
            if token != b"EXEC\n":
                raise NativeAuditError("Native ownership commit was missing or invalid.")
            break
        token += chunk
        if len(token) >= 6 or not b"EXEC\n".startswith(token):
            raise NativeAuditError("Native ownership commit was invalid.")
    # Keep only the native request stream and bounded output streams. execve
    # replaces this owned PID/group; no bootstrap process remains.
    os.closerange(3, os.sysconf("SC_OPEN_MAX"))
    argv = [agentfs, "run", "--no-default-allows", "--allow", snapshot,
            "--allow", evidence, "--session", session, "--", sys.executable,
            "-I", "-B", str(Path(__file__).resolve()), "--run"]
    os.execve(agentfs, argv, dict(os.environ))


def main():
    """Run the bounded JSON protocol with value-free diagnostics."""
    if sys.argv[1:2] == ["--launch"]:
        launch_native()
        return
    request = json.loads(sys.stdin.read(64 * 1024))
    if sys.argv[1:] == ["--preflight"]:
        _, public = resolve_native_config(request)
        if "snapshot" in request:
            public["scope"] = native_scope(request)
        print(json.dumps(public))
    elif sys.argv[1:] == ["--run"]:
        try:
            result = run_native(request)
        except Exception:  # pylint: disable=broad-exception-caught
            result = {"status": "failed",
                      "error": "Native pipeline failed; inspect preserved partial state."}
        target = Path(request["evidence"]) / "native-result.json"
        target.write_text(json.dumps(result), encoding="utf-8")
        if result["status"] != "completed":
            sys.exit(1)
    else:
        raise NativeAuditError("Unsupported native bridge invocation.")


if __name__ == "__main__":
    try:
        main()
    except NativeAuditError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:  # pylint: disable=broad-exception-caught
        # Never expose configuration values or provider diagnostics.
        print("Unknown native configuration requirements.", file=sys.stderr)
        sys.exit(1)
