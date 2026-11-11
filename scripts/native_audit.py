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


RUNTIME_VERSIONS = {"swival": "1.9.3", "litellm": "1.106.6"}
OVERRIDE_KEYS = {
    "provider": "provider", "model": "model",
    "reasoningEffort": "reasoning_effort", "temperature": "temperature",
    "topP": "top_p", "seed": "seed", "maxOutputTokens": "max_output_tokens",
    "maxTurns": "max_turns", "providerTimeout": "provider_timeout",
    "encryptSecrets": "encrypt_secrets",
}
ROUTING_KEYS = {
    *{v for v in OVERRIDE_KEYS.values() if v != "encrypt_secrets"},
    "base_url", "api_key", "user_agent", "extra_body", "aws_profile",
    "project", "location", "max_context_tokens", "retries", "prompt_cache",
    "sanitize_thinking", "show_thinking", "decision_model", "decision_base_url",
    "decision_api_key", "model_routing", "routing_profiles",
}
OPTION_KEYS = ("max_output_tokens", "max_turns", "provider_timeout", "retries",
               "temperature", "top_p", "seed", "max_context_tokens")
# Credential forwarding is an authority boundary, not a provider implementation.
CREDENTIAL_ENV = {
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "bedrock": "AWS_ACCESS_KEY_ID",
    "geap": "GOOGLE_OAUTH_ACCESS_TOKEN",
}
FALLBACK_CREDENTIAL_ENV = {
    "bedrock": {"AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"},
    "geap": {"GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "VERTEXAI_CREDENTIALS"},
}
AMBIENT_ENDPOINTS = {
    "CHATGPT_API_BASE", "OPENAI_CHATGPT_API_BASE", "OPENAI_API_BASE",
    "OPENAI_BASE_URL", "OPENROUTER_API_BASE", "LITELLM_API_BASE",
    "ANTHROPIC_API_BASE", "ANTHROPIC_BASE_URL",
    "AWS_BEDROCK_RUNTIME_ENDPOINT", "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "VERTEXAI_API_BASE",
}


def _unpropagated_policy(key, value):
    if key.startswith("encrypt_secrets") and value is not False:
        return "encrypt_secrets"
    if (key == "web_search" and value is not False) or (key == "web_search_providers" and value):
        return "web_search"
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
        if key == "decision_api_key" and value is not None:
            raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED", "api_key")
        if key in {"model_routing", "routing_profiles", "decision_model", "decision_base_url"} and value:
            raise NativeAuditError("ROUTE_SELECTOR_UNSUPPORTED")
        if (key in {"nono_profile", "nono_rollback", "nono_block_net", "nono_allow_domain",
                    "nono_network_profile", "nono_credential", "nono_audit_integrity"}
                and value) or (
                (key, value) in [("network", "none"), ("files", "none"), ("sandbox", "nono")]):
            raise NativeAuditError("POLICY_NOT_PROPAGATED", key)
        if isinstance(value, dict):
            _requirements(value)


def _scan_config(filename, *, project=False, allow_encrypt_secrets_override=False):
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
    # Upstream still validates every profile's schema; selected policy is checked later.
    _requirements({key: value for key, value in raw.items()
                   if key != "profiles" and not (
                       not project and allow_encrypt_secrets_override
                       and key == "encrypt_secrets" and value is True)})
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


def _aws_region(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", value))


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
            if key == "encrypt_secrets":
                if not isinstance(value, bool):
                    raise NativeAuditError("CONFIG_INVALID")
                argv.append("--encrypt-secrets" if value else "--no-encrypt-secrets")
                continue
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
    defer_credentials = request.get("deferCredentials") is True and not request.get("snapshot")
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
    raw = _scan_config(
        config_module.global_config_dir() / "config.toml",
        allow_encrypt_secrets_override=routing.get("encryptSecrets") is False,
    )
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
            if args.provider == "vertexai":
                args.provider = "geap"
            _parse_route(parser, {
                **(
                    {"gcp_project": args.gcp_project, "location": args.location}
                    if args.provider == "geap"
                    else {}
                ),
                **{
                    key: getattr(args, key)
                    for key in (*OPTION_KEYS, "provider", "model", "base_url", "reasoning_effort")
                },
            })
    except NativeAuditError:
        raise
    except Exception as exc:
        raise NativeAuditError("CONFIG_INVALID") from exc
    _requirements(effective)
    return _admit_route(args, profile, routing, defer_credentials=defer_credentials)


def _credential_capability(args, *, defer_credentials=False):
    if args.api_key is not None or getattr(args, "decision_api_key", None) is not None:
        raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED", "api_key")
    if FALLBACK_CREDENTIAL_ENV.get(args.provider, set()) & os.environ.keys():
        raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
    if args.provider == "bedrock":
        if getattr(args, "gcp_project", None) or getattr(args, "location", None):
            raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
        if args.aws_profile is not None and not _identifier(args.aws_profile, 80):
            raise NativeAuditError("CONFIG_INVALID")
        if not defer_credentials:
            has_aws_env = bool(
                os.environ.get("AWS_ACCESS_KEY_ID")
                and os.environ.get("AWS_SECRET_ACCESS_KEY")
                and os.environ.get("AWS_SESSION_TOKEN")
            )
            if not has_aws_env:
                if args.aws_profile is not None or args.base_url is None:
                    raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
                raise NativeAuditError("CREDENTIAL_UNAVAILABLE")
            if args.aws_profile is not None and not os.environ.get("PI_SWIVAL_AWS_PROFILE_MINTED"):
                raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
        return
    if args.provider == "geap":
        if getattr(args, "aws_profile", None):
            raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
        if not _identifier(getattr(args, "gcp_project", None), 128) or not _identifier(
            getattr(args, "location", None), 64
        ):
            raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
        if not defer_credentials and not os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN"):
            raise NativeAuditError("CREDENTIAL_UNAVAILABLE")
        return
    if any(getattr(args, key, None) for key in ("aws_profile", "gcp_project", "location")):
        raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
    if args.provider != "chatgpt" and args.provider not in CREDENTIAL_ENV:
        raise NativeAuditError("CREDENTIAL_INTERFACE_UNSUPPORTED")
    if args.provider in CREDENTIAL_ENV and not os.environ.get(CREDENTIAL_ENV[args.provider]):
        raise NativeAuditError("CREDENTIAL_UNAVAILABLE")


def _admit_route(args, profile, routing, *, defer_credentials=False):
    """No provider construction, catalog request, or inference for admission."""
    provider, model = args.provider, args.model
    if not _identifier(provider, 40) or not _identifier(model):
        raise NativeAuditError("CONFIG_INVALID")
    if provider == "command":
        raise NativeAuditError("COMMAND_EXECUTION_REQUIRED")
    if provider in {"lmstudio", "generic", "llamacpp", "applefm", "google"}:
        raise NativeAuditError("MODEL_REPLACEMENT_UNCONTROLLABLE")
    if provider == "bedrock":
        _credential_capability(args, defer_credentials=defer_credentials)
        if args.base_url is None:
            raise NativeAuditError("ENDPOINT_REQUIREMENT_UNSUPPORTED")
        if not _aws_region(args.base_url):
            _ = _endpoint(args.base_url)
            raise NativeAuditError("ENDPOINT_REQUIREMENT_UNSUPPORTED")
        endpoint = args.base_url
    else:
        endpoint = _endpoint(args.base_url)
        _credential_capability(args, defer_credentials=defer_credentials)
    if provider == "geap":
        if "/" in model:
            raise NativeAuditError("CONFIG_INVALID")
        if endpoint is not None:
            raise NativeAuditError("ENDPOINT_REQUIREMENT_UNSUPPORTED")
    if model.rsplit("/", 1)[-1].split(":", 1)[0] in {"auto", "random", "free"}:
        raise NativeAuditError("ROUTE_SELECTOR_UNSUPPORTED")
    if provider == "chatgpt" and endpoint not in (None, "https://chatgpt.com/backend-api/codex"):
        raise NativeAuditError("ENDPOINT_REQUIREMENT_UNSUPPORTED")
    if provider == "anthropic" and endpoint is not None:
        raise NativeAuditError("ENDPOINT_REQUIREMENT_UNSUPPORTED")
    if endpoint and not _aws_region(endpoint) and urlsplit(endpoint).hostname in ("localhost", "127.0.0.1", "::1"):
        if args.max_context_tokens is None:
            raise NativeAuditError("POLICY_NOT_PROPAGATED", "max_context_tokens")
    options = {key: getattr(args, key) for key in OPTION_KEYS}
    if any(isinstance(value, (int, float)) and not math.isfinite(value)
           for value in options.values()):
        raise NativeAuditError("CONFIG_INVALID")
    import litellm
    from litellm.types.utils import LlmProviders
    from litellm.utils import ProviderConfigManager
    # Pinned adapters without a dynamic models handler must not expose a singleton
    # bundled catalog. Otherwise Swival's singleton NotFound retry can substitute.
    # Empty catalogs (len == 0, such as openrouter in LiteLLM 1.106.6) return None
    # in swival/agent.py:_handle_model_not_found and cannot substitute a model.
    # For anthropic, bedrock, and geap (vertex_ai), _list_server_models returns [].
    adapter_name = "vertex_ai" if provider == "geap" else provider
    adapter = LlmProviders(adapter_name)
    if ((provider not in {"anthropic", "bedrock", "geap"}
            and ProviderConfigManager.get_provider_model_info(None, adapter) is not None)
            or len(set(litellm.models_by_provider.get(adapter_name, []))) == 1):
        raise NativeAuditError("MODEL_REPLACEMENT_UNCONTROLLABLE")
    result = {
        "version": 2, "runtime": RUNTIME_VERSIONS, "provider": provider, "model": model,
        "reasoningEffort": args.reasoning_effort, "options": options, "profile": profile,
        "endpoint": endpoint, "reportIdentity": {"provider": provider, "model": model},
        "selection": {"profileSource": "explicit" if "profile" in routing else
            "active" if profile else None, "explicitFields": sorted(routing)},
        **({"project": args.gcp_project, "location": args.location}
           if provider == "geap" else {}),
    }
    if provider == "bedrock" and args.aws_profile:
        result["awsProfile"] = args.aws_profile
    return result


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
