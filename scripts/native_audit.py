"""Bounded configuration/scope preflight; never construct a provider or Session.

Swival owns configuration precedence and provider/auth integration. Only frozen,
nonsecret routing metadata leaves this process.
"""
# pylint: disable=import-outside-toplevel
import argparse
import contextlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import tomllib
from urllib.parse import urlsplit

os.environ["LITELLM_MODE"] = "PRODUCTION"  # Public upstream dotenv opt-out, before imports.


class NativeAuditError(Exception):
    """A value-free, structured native availability diagnostic."""

    def __init__(self, reason, field=None):
        super().__init__(reason)
        self.reason = reason
        self.field = field

    def response(self):
        """Never expose upstream exceptions or configuration values."""
        result = {"ok": False, "reason": self.reason}
        if self.field is not None:
            result["field"] = self.field
        return result


RUNTIME_VERSIONS = {"swival": "1.0.46", "litellm": "1.103.4"}
OVERRIDE_KEYS = {
    "provider": "provider", "model": "model",
    "reasoningEffort": "reasoning_effort", "temperature": "temperature",
    "topP": "top_p", "seed": "seed", "maxOutputTokens": "max_output_tokens",
    "maxTurns": "max_turns", "providerTimeout": "provider_timeout",
}
ROUTING_KEYS = {
    *OVERRIDE_KEYS.values(), "base_url", "api_key", "user_agent", "extra_body", "aws_profile",
    "project", "location", "max_context_tokens", "retries", "prompt_cache",
    "sanitize_thinking", "show_thinking",
}
OPTION_KEYS = ("max_output_tokens", "max_turns", "provider_timeout", "retries",
               "temperature", "top_p", "seed", "max_context_tokens")
# Credential forwarding is an authority boundary, not a provider implementation.
CREDENTIAL_ENV = {"openrouter": "OPENROUTER_API_KEY"}
AMBIENT_ENDPOINTS = {"CHATGPT_API_BASE", "OPENAI_CHATGPT_API_BASE", "OPENAI_API_BASE",
                     "OPENAI_BASE_URL", "OPENROUTER_API_BASE", "LITELLM_API_BASE"}


def _unpropagated_policy(key, value):
    if key.startswith("encrypt_secrets") and value is not False:
        return "encrypt_secrets"
    if key in {"llm_filter", "secret_shield", "extra_body", "user_agent"}:
        return key if value not in (None, False, "", {}) else None
    if (key == "prompt_cache" and value is False) or (key == "retries" and value != 5):
        return key
    if key in {"sanitize_thinking", "show_thinking", "sandbox_strict_read", "sandbox_session",
               "lifecycle_fail_closed", "reasoning_effort_all_phases", "retries_all_phases"}:
        return key if value else None
    return None


def _requirements(raw):
    """Reject concrete requirements omitted by native or auxiliary phases."""
    for key, value in raw.items():
        field = _unpropagated_policy(key, value)
        if field:
            raise NativeAuditError("POLICY_NOT_PROPAGATED", field)
        if (key in {"nono_profile", "nono_rollback", "nono_block_net", "nono_allow_domain",
                    "nono_network_profile", "nono_credential", "nono_audit_integrity"}
                and value) or (
                (key, value) in [("network", "none"), ("files", "none"), ("sandbox", "nono")]):
            raise NativeAuditError("POLICY_NOT_PROPAGATED", key)
        if isinstance(value, dict):
            _requirements(value)


def _scan_config(filename, *, project=False):
    """Bounded metadata/TOML scan before released loading; no auth-store reads."""
    from swival import config as config_module
    if not filename.exists():
        return {}
    if filename.is_symlink() or not filename.is_file() or filename.stat().st_size > 128 * 1024:
        raise NativeAuditError("CONFIG_INVALID")
    try:
        raw = tomllib.loads(filename.read_text(encoding="utf-8"))
    except Exception as exc:
        raise NativeAuditError("CONFIG_INVALID") from exc
    _requirements(raw)
    known = set(config_module.CONFIG_KEYS) | {
        "profiles", "active_profile", "audit", "mcp_servers", "a2a_servers", "serve_skills",
    }
    if set(raw) - known:
        raise NativeAuditError("CONFIG_INVALID")
    if project and set(raw) & (ROUTING_KEYS | {"profiles", "active_profile"}):
        raise NativeAuditError("PROJECT_ROUTING_UNSUPPORTED")
    return raw


def _identifier(value, limit=160):
    return (isinstance(value, str) and 0 < len(value) <= limit
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:-]*", value)
            and not re.search(r"[A-Za-z0-9]{40,}|(?:^|/)\.\.?(?:/|$)", value))


def _endpoint(value):
    if value is None:
        return None
    if (not isinstance(value, str) or len(value) > 512
            or re.search(r"[A-Za-z0-9]{40,}", value) or not re.fullmatch(
            r"https?://[A-Za-z0-9.:[\]-]+(?::[0-9]+)?(?:/[A-Za-z0-9_./-]*)?", value)):
        raise NativeAuditError("CONFIG_INVALID")
    try:
        url = urlsplit(value)
        if not url.hostname or any((url.username, url.password, url.query, url.fragment)):
            raise ValueError("invalid endpoint")
        if not _identifier(url.hostname.replace(":", "-"), 253):
            raise ValueError("invalid endpoint")
        if url.scheme != "https" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("insecure endpoint")
        _ = url.port
    except ValueError as exc:
        raise NativeAuditError("CONFIG_INVALID") from exc
    return value


def _parse_route(parser, values):
    """Use released CLI choices for both explicit and configuration-fed fields."""
    argv = []
    for key, value in values.items():
        if value is not None:
            if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                raise NativeAuditError("CONFIG_INVALID")
            argv.append("--" + key.replace("_", "-") + "=" + str(value))
    try:
        return parser.parse_args(argv)
    except SystemExit as exc:
        raise NativeAuditError("CONFIG_INVALID") from exc


def resolve_native_config(request):
    """Select through released precedence, then admit concrete native capabilities."""
    routing = request.get("routing", {})
    if not isinstance(routing, dict) or set(routing) - (set(OVERRIDE_KEYS) | {"profile"}):
        raise NativeAuditError("CONFIG_INVALID")
    if (sys.version_info < (3, 13) or any(importlib.metadata.version(name) != version
                                       for name, version in RUNTIME_VERSIONS.items())):
        raise NativeAuditError("RUNTIME_UNSUPPORTED")
    if ("USE_LITELLM_PROXY" in os.environ or any(name.lower() in {
            "http_proxy", "https_proxy", "all_proxy"} for name in os.environ)):
        raise NativeAuditError("TRANSPORT_REQUIREMENT_UNSUPPORTED")
    for name, field in {"SWIVAL_ENCRYPT_KEY": "encrypt_secrets", "SWIVAL_LLM_FILTER": "llm_filter",
                        "SWIVAL_SECRET_SHIELD": "secret_shield"}.items():
        if name in os.environ:
            raise NativeAuditError("POLICY_NOT_PROPAGATED", field)
    if AMBIENT_ENDPOINTS & os.environ.keys():
        raise NativeAuditError("ENDPOINT_REQUIREMENT_UNSUPPORTED")
    from swival import config as config_module
    from swival.agent import build_parser
    raw = _scan_config(config_module.global_config_dir() / "config.toml")
    source = Path(request["source"]).resolve()
    _scan_config(source / "swival.toml", project=True)
    profile = routing.get("profile", raw.get("active_profile"))
    if profile is not None or "profile" in routing:
        if not _identifier(profile, 80):
            raise NativeAuditError("PROFILE_UNAVAILABLE")
        profiles = raw.get("profiles", {})
        if (not isinstance(profiles, dict) or not isinstance(profiles.get(profile), dict)
                or not profiles[profile].get("provider")):
            raise NativeAuditError("PROFILE_UNAVAILABLE")
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            parser = build_parser()
            args = _parse_route(parser, {
                OVERRIDE_KEYS.get(key, key): value for key, value in routing.items()})
            config = config_module.load_config(source)
            profile = config_module.resolve_profile_config(args, config)
            effective = {**config, **{OVERRIDE_KEYS[key]: value for key, value in routing.items()
                                      if key in OVERRIDE_KEYS}}
            if not effective.get("provider") or not effective.get("model"):
                raise NativeAuditError("ROUTE_INCOMPLETE")
            config_module.apply_config_to_args(args, config)
            _parse_route(parser, {key: getattr(args, key) for key in
                (*OPTION_KEYS, "provider", "model", "base_url", "reasoning_effort")})
    except NativeAuditError:
        raise
    except Exception as exc:
        raise NativeAuditError("CONFIG_INVALID") from exc
    _requirements(effective)
    return _admit_route(args, profile, routing)


def _credential_capability(args):
    if args.api_key is not None:
        raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED", "api_key")
    if any(getattr(args, key, None) for key in ("aws_profile", "gcp_project", "location")):
        raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
    if args.provider != "chatgpt" and args.provider not in CREDENTIAL_ENV:
        raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
    if args.provider in CREDENTIAL_ENV and not os.environ.get(CREDENTIAL_ENV[args.provider]):
        raise NativeAuditError("CREDENTIAL_UNAVAILABLE")


def _admit_route(args, profile, routing):
    """No provider construction, catalog request, or inference for admission."""
    provider, model = args.provider, args.model
    if not _identifier(provider, 40) or not _identifier(model):
        raise NativeAuditError("CONFIG_INVALID")
    endpoint = _endpoint(args.base_url)
    if provider == "command":
        raise NativeAuditError("COMMAND_EXECUTION_REQUIRED")
    if provider in {"lmstudio", "generic", "llamacpp", "applefm", "google"}:
        raise NativeAuditError("MODEL_REPLACEMENT_UNCONTROLLABLE")
    _credential_capability(args)
    if model.rsplit("/", 1)[-1].split(":", 1)[0] in {"auto", "random", "free"}:
        raise NativeAuditError("ROUTE_SELECTOR_UNSUPPORTED")
    if provider == "chatgpt" and endpoint not in (None, "https://chatgpt.com/backend-api/codex"):
        raise NativeAuditError("ENDPOINT_REQUIREMENT_UNSUPPORTED")
    if endpoint and urlsplit(endpoint).hostname in ("localhost", "127.0.0.1", "::1"):
        if args.max_context_tokens is None:
            raise NativeAuditError("POLICY_NOT_PROPAGATED", "max_context_tokens")
    options = {key: getattr(args, key) for key in OPTION_KEYS}
    if any(isinstance(value, (int, float)) and not math.isfinite(value)
           for value in options.values()):
        raise NativeAuditError("CONFIG_INVALID")
    import litellm
    from litellm.types.utils import LlmProviders
    from litellm.utils import ProviderConfigManager
    # Pinned adapters without a dynamic models handler must keep a multi-model
    # bundled catalog. Otherwise Swival's singleton NotFound retry can substitute.
    adapter = LlmProviders(provider)
    if (ProviderConfigManager.get_provider_model_info(None, adapter) is not None
            or len(set(litellm.models_by_provider.get(provider, []))) < 2):
        raise NativeAuditError("MODEL_REPLACEMENT_UNCONTROLLABLE")
    return {"version": 2, "runtime": RUNTIME_VERSIONS, "provider": provider, "model": model,
            "reasoningEffort": args.reasoning_effort, "options": options, "profile": profile,
            "endpoint": endpoint, "reportIdentity": {"provider": provider, "model": model},
            "selection": {"profileSource": "explicit" if "profile" in routing else
                "active" if profile else None, "explicitFields": sorted(routing)}}


def native_scope(request):
    """Use released scope matching only on the owned inert committed snapshot."""
    from swival.audit import _resolve_scope  # pylint: disable=protected-access
    paths = request.get("audit", {}).get("paths", [])
    if not isinstance(paths, list) or len(paths) > 64:
        raise NativeAuditError("CONFIG_INVALID")
    for token in paths:
        if (not isinstance(token, str) or not re.fullmatch(r"[\w.*?\[\]/-]+", token)
                or token.startswith(("/", "-")) or any(p in (".", "..") for p in token.split("/"))):
            raise NativeAuditError("CONFIG_INVALID")
    return _resolve_scope(request["snapshot"], paths).to_dict()


def main():
    """Read a capped adapter request and print only nonsecret metadata."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true", required=True)
    parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            raise NativeAuditError("CONFIG_INVALID")
        request = json.loads(raw)
        result = resolve_native_config(request)
        if request.get("snapshot"):
            result["scope"] = native_scope(request)
        output = json.dumps(result)
        if len(output.encode()) > 64 * 1024:
            raise NativeAuditError("CONFIG_INVALID")
        print(output)
    except NativeAuditError as exc:
        print(json.dumps(exc.response()))
        return 1
    except Exception:  # pylint: disable=broad-exception-caught
        # Third-party errors must not disclose configuration or credential values.
        print(json.dumps({"ok": False, "reason": "CONFIG_INVALID"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
