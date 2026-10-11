"""Restricted bridge to the released native /audit entry point.

Preflight never creates a Session or resolves provider credentials. Only validated
non-secret route metadata leaves memory; diagnostics never include configuration values.
"""

# Swival imports remain lazy so preflight cannot initialize a provider.
# pylint: disable=import-outside-toplevel,too-many-lines

import argparse
import contextlib
import ctypes
import errno
import hashlib
import importlib.metadata
import io
import json
import math
import operator
import os
from pathlib import Path
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time
import tomllib
from urllib.parse import urlsplit


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


# Released Session constructor defaults. These are requested options, not a claim
# that auxiliary audit calls forward them all. Never derive this from raw config.
EXECUTION_DEFAULTS = {
    "max_output_tokens": 32768, "max_context_tokens": None, "max_turns": 100,
    "temperature": None, "top_p": None, "seed": None, "provider_timeout": 900,
    "retries": 5, "prompt_cache": True, "sanitize_thinking": None, "show_thinking": None,
}
RUNTIME_VERSIONS = {"swival": "1.0.46", "litellm": "1.103.3"}
UNSHARE_IDENTITY = {
    "path": "/usr/bin/unshare",
    "version": "unshare from util-linux 2.41.5",
    "package": "util-linux",
    "packageVersion": "2.41.5-0+deb13u1",
    "architecture": "arm64",
    "sha256": "285119fd3989039d50f8904b619b2abb8b795cb56753eb0235c8c031eb880a21",
}
BWRAP_IDENTITY = {
    "path": "/usr/bin/bwrap",
    "version": "bubblewrap 0.12.0",
    "package": "bubblewrap",
    "packageVersion": "0.12.0-1~deb13u1",
    "architecture": "arm64",
    "sha256": "b3b829e18a7d43ee589dc37e351cb9480ff7301b493d8227b8c754294638b976",
}
# Reviewed regular member of the authenticated 0.79.0 ARM64 GNU release archive
# with SHA-256 c4a4f4b9ae318574d30d352127a34dcc919c4d6682ee8fbd30bb8d2bd2e0e85d.
NONO_ARTIFACT_IDENTITY = {
    "version": "0.79.0",
    "architecture": "aarch64-unknown-linux-gnu",
    "bytes": 26141064,
    "sha256": "667fdaea93f77c9f8f45b04a80f4e2fb7e7d7fb104fa1da189ea38f41fbcf57b",
}
_NONO_IDENTITY_KEYS = {"path", *NONO_ARTIFACT_IDENTITY}
_NONO_OUTPUT_LIMIT = 16 * 1024
_NONO_COMMAND_TIMEOUT = 5
_NONO_WRAPPER_PROFILE = "jedisct1/swival"
_NONO_MANIFEST_LIMIT = 64 * 1024
_NONO_PROFILE_LIMIT = 1024 * 1024
_NONO_PROFILE_IDENTITY_KEYS = {"config", "pack", "manifest", "profile"}
_NONO_FILE_IDENTITY_KEYS = {"path", "bytes", "sha256"}
_VERTEX_SELECTOR = None
_VERTEX_SELECTOR_LOCK = threading.Lock()
CREDENTIAL_PATTERN = re.compile(
    r"(?:sk[-_][A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|"
    r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9]{40,})"
)


def _selector(value, pattern=r"[A-Za-z0-9_.:/-]+"):
    if (not isinstance(value, str) or not 1 <= len(value) <= 256
            or not re.fullmatch(pattern, value) or CREDENTIAL_PATTERN.search(value)
            or value.startswith("os.environ/")):
        raise NativeAuditError("Unsupported or sensitive native route selector.")
    return value


def _endpoint(value):
    """Allow only representable HTTP destinations, never URL credentials."""
    try:
        if (not isinstance(value, str) or not 1 <= len(value) <= 2048
                or not re.fullmatch(r"[A-Za-z0-9:/_.~\[\]-]+", value)
                or CREDENTIAL_PATTERN.search(value)):
            raise ValueError("opaque URL")
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None):
            raise ValueError("unsupported authority")
        if (parsed.query or parsed.fragment
                or any(part in (".", "..") for part in parsed.path.split("/"))
                or (parsed.port is not None and not 1 <= parsed.port <= 65535)):
            raise ValueError("unsupported URL")
        # Preserve meaningful scheme/authority/port/path spelling. No redacted
        # URL may stand in for a different actual destination.
        return value
    except ValueError as exc:
        raise NativeAuditError("Unsupported or sensitive native endpoint.") from exc


def _chatgpt_endpoint():
    # Released Authenticator selects this before Responses routing. It ignores
    # the configured base_url; never initialize Authenticator to find it.
    return (os.environ.get("CHATGPT_API_BASE") or os.environ.get("OPENAI_CHATGPT_API_BASE")
            or "https://chatgpt.com/backend-api/codex")


def _vertex_gemini_dispatch(model):
    """Use the released selector without dotenv, network metadata, or auth."""
    global _VERTEX_SELECTOR  # pylint: disable=global-statement
    with _VERTEX_SELECTOR_LOCK:
        if _VERTEX_SELECTOR is None:
            flags = {"LITELLM_MODE": "PRODUCTION", "LITELLM_LOCAL_MODEL_COST_MAP": "True"}
            previous = {name: os.environ.get(name) for name in flags}
            try:
                os.environ.update(flags)
                from litellm.llms.vertex_ai.common_utils import (
                    VertexAIModelRoute, get_vertex_ai_model_route,
                )
                selected = get_vertex_ai_model_route(model=model, litellm_params={})
                _VERTEX_SELECTOR = (get_vertex_ai_model_route, VertexAIModelRoute.GEMINI)
                return selected == VertexAIModelRoute.GEMINI
            except Exception as exc:
                raise NativeAuditError("Native Vertex dispatch metadata unavailable.") from exc
            finally:
                for name, value in previous.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value
        selector, gemini = _VERTEX_SELECTOR
    # Cached imports remain private to this native process. Audit threads only
    # call the pure selector; they never change environment or initialize an SDK.
    return selector(model=model, litellm_params={}) == gemini


# Provider cases mirror the pinned destination semantics; do not infer them from credentials.
# pylint: disable-next=too-many-branches,too-many-locals,too-many-statements
def _route_binding(settings, profile):
    """Materialize pinned non-secret routing without credentials or discovery."""
    provider = settings["provider"]
    model = _selector(settings["model"])
    if profile is not None:
        profile = _selector(profile, r"[A-Za-z0-9_.-]+")
    if settings.get("extra_body"):
        raise NativeAuditError("Opaque native extra_body routing is unsupported.")
    options = {key: settings.get(key, default) for key, default in EXECUTION_DEFAULTS.items()}
    if any(isinstance(value, (int, float)) and not math.isfinite(value)
           for value in options.values()):
        raise NativeAuditError("Unsupported native execution options.")
    settings.update(options)
    for key in ("aws_profile", "project", "location"):
        if settings.get(key):
            _selector(settings[key], r"[A-Za-z0-9_.-]+")
    base = settings.get("base_url")
    destination = {}
    key_reference = {"generic": "OPENAI_API_KEY", "openrouter": "OPENROUTER_API_KEY",
                     "huggingface": "HF_TOKEN", "chatgpt": "CHATGPT_API_KEY"}.get(provider)
    credential = {"kind": "configuration" if settings.get("api_key") else "runtime-lookup",
                  "reference": key_reference}
    if provider == "lmstudio":
        base = _endpoint(base or "http://127.0.0.1:1234")
        api_base = base + "/v1"
        transport_model = "openai/" + model
        credential = {"kind": "upstream-placeholder", "reference": None}
    elif provider == "generic":
        base = _endpoint(base).rstrip("/")
        if not re.search(r"/v[0-9]+$", base):
            base += "/v1"
        api_base = base
        transport_model = "openai/" + model
    elif provider == "openrouter":
        base = _endpoint(base or os.environ.get("OPENROUTER_API_BASE")
                         or "https://openrouter.ai/api/v1")
        api_base = base
        bare = model.removeprefix("openrouter/") if model.startswith(
            "openrouter/openrouter/") else model
        transport_model = "openrouter/" + bare
    elif provider == "chatgpt":
        bare = model.removeprefix("chatgpt/").removeprefix("chatgpt/")
        if not bare.startswith("gpt"):
            raise NativeAuditError("Unverified native ChatGPT model routing.")
        effective = _endpoint(_chatgpt_endpoint())
        if base and _endpoint(base).rstrip("/") != effective.rstrip("/"):
            raise NativeAuditError("Configured native ChatGPT endpoint cannot be enforced.")
        base = effective
        api_base = base
        transport_model = "chatgpt/" + bare
        credential = {"kind": "chatgpt-runtime-auth", "reference": None}
    elif provider == "huggingface":
        bare = model.removeprefix("huggingface/")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", bare):
            raise NativeAuditError("Unverified native HuggingFace provider/model mapping.")
        base = _endpoint(base or os.environ.get("HF_API_BASE")
                         or os.environ.get("HUGGINGFACE_API_BASE")
                         or "https://router.huggingface.co/v1").rstrip("/")
        if not base.endswith("/chat/completions"):
            base += "/chat/completions" if base.endswith("/v1") else "/v1/chat/completions"
        api_base = base
        transport_model = "huggingface/" + bare
    elif provider == "bedrock":
        # A runtime endpoint alone does not fix the signing/destination region.
        # Never consult ~/.aws or boto3 to discover it.
        if any(part in {"mantle", "agent", "agentcore", "claude_platform", "openai"}
               for part in model.split("/")[:-1]):
            raise NativeAuditError("Unsupported alternate native Bedrock endpoint route.")
        region = _selector(base or "", r"[a-z]{2}(?:-[a-z]+)+-[0-9]+")
        if region.startswith(("us-iso", "eu-iso")):
            raise NativeAuditError("Unverified native Bedrock region partition.")
        profile_name = settings.get("aws_profile") or os.environ.get("AWS_PROFILE_NAME")
        if profile_name:
            settings["aws_profile"] = _selector(profile_name, r"[A-Za-z0-9_.-]+")
        sdk_profile = os.environ.get("AWS_PROFILE")
        endpoint = _endpoint(os.environ.get("AWS_BEDROCK_RUNTIME_ENDPOINT") or
                             f"https://bedrock-runtime.{region}.amazonaws.com" +
                             (".cn" if region.startswith("cn-") else ""))
        destination = {"region": region, "endpoint": endpoint,
                       "awsProfile": profile_name,
                       "sdkProfile": _selector(sdk_profile, r"[A-Za-z0-9_.-]+")
                       if sdk_profile else None}
        api_base = None
        transport_model = "bedrock/" + model.removeprefix("bedrock/")
        credential = {"kind": "aws-runtime-chain", "reference": None}
        if settings.get("api_key"):
            raise NativeAuditError("Unsupported native cloud credential configuration.")
    else:  # vertexai: Session maps it to geap and forwards explicit project/location.
        if "/" in model or not settings.get("project") or not settings.get("location"):
            raise NativeAuditError("Native Vertex routing requires explicit project and location.")
        if not _vertex_gemini_dispatch(model):
            raise NativeAuditError("Unverified native Vertex dispatch; only GEMINI is supported.")
        location = _selector(settings["location"], r"[a-z]+(?:-[a-z0-9]+)*")
        base = _endpoint(base) if base else None
        if not base and os.environ.get("VERTEXAI_API_BASE"):
            raise NativeAuditError("Unsupported ambient native Vertex endpoint override.")
        endpoint = base or ("https://aiplatform.googleapis.com" if location == "global" else
                            f"https://{location}-aiplatform.googleapis.com" if "-" in location else
                            f"https://aiplatform.{location}.rep.googleapis.com")
        destination = {"endpoint": endpoint, "project": settings["project"], "location": location}
        api_base = base
        transport_model = "vertex_ai/" + model
        credential = {"kind": "google-runtime-chain", "reference": None}
        if settings.get("api_key"):
            raise NativeAuditError("Unsupported native cloud credential configuration.")
    settings["base_url"] = base
    destination["apiBase"] = api_base
    return {"version": 1, "runtime": RUNTIME_VERSIONS, "provider": provider, "model": model,
            "transportModel": transport_model, "destination": destination, "profile": profile,
            "reasoningEffort": settings.get("reasoning_effort"), "options": options,
            "credentialSource": credential}


@contextlib.contextmanager
def _bound_transport(route):
    """Guard every released call/retry, including auxiliaries, before transport.

    Scoped hooks never read credential stores. Prevent upstream model discovery
    and sole-model fallback, and reject cached autofix targets before dispatch.
    """
    import litellm
    from swival import agent

    completion = litellm.completion
    model_listing = agent._list_server_models  # pylint: disable=protected-access
    hf_fallback = agent._call_huggingface_text_generation  # pylint: disable=protected-access
    violated = threading.Event()

    def reject(message):
        violated.set()
        raise NativeAuditError(message)

    def check_vertex_route():
        if route["provider"] != "vertexai":
            return
        if not _vertex_gemini_dispatch(route["model"]):
            reject("Unverified native Vertex dispatch; only GEMINI is supported.")
        if (route["destination"]["apiBase"] is None
                and (litellm.api_base or os.environ.get("VERTEXAI_API_BASE"))):
            reject("Unsupported ambient native Vertex endpoint override.")

    def guarded(*args, **kwargs):
        if violated.is_set():
            reject("Native transport route guard failed; no further transport.")
        if args or kwargs.get("model") != route["transportModel"] or kwargs.get("extra_body"):
            reject("Native transport route changed; no fallback.")
        if litellm.use_litellm_proxy or kwargs.get("use_litellm_proxy"):
            reject("Unsupported native transport proxy requirements.")
        destination = route["destination"]
        if kwargs.get("api_base") != destination["apiBase"]:
            reject("Native transport destination changed; no fallback.")
        if route["provider"] == "chatgpt" and _chatgpt_endpoint() != destination["apiBase"]:
            reject("Native ChatGPT endpoint changed downstream; no fallback.")
        if route["provider"] == "bedrock":
            if (kwargs.get("aws_region_name") != destination["region"]
                    or kwargs.get("aws_profile_name") != destination["awsProfile"]):
                reject("Native cloud route changed; no fallback.")
        if route["provider"] == "vertexai":
            check_vertex_route()
            # The released get_vertex_region silently moves unsupported regions.
            # Check its pure metadata predicate without its value-bearing warning.
            supported = litellm.model_cost.get(route["transportModel"], {}).get("supported_regions")
            if (kwargs.get("vertex_project") != destination["project"]
                    or kwargs.get("vertex_location") != destination["location"]
                    or (supported and destination["location"] not in supported)):
                reject("Native cloud location changed; no fallback.")
        return completion(**kwargs)

    def no_discovery(*_args, **_kwargs):
        reject("Native model discovery/replacement is forbidden; no fallback.")

    def no_hf_fallback(*_args, **_kwargs):
        reject("Native HuggingFace text-generation fallback is forbidden; no fallback.")

    litellm.completion = guarded
    agent._list_server_models = no_discovery  # pylint: disable=protected-access
    agent._call_huggingface_text_generation = no_hf_fallback  # pylint: disable=protected-access
    try:
        check_vertex_route()  # Before Session construction, and again on every call.
        with _read_only_chatgpt_auth(route, reject):
            yield
        if violated.is_set():
            raise NativeAuditError("Native transport route guard failed; no fallback.")
    finally:
        litellm.completion = completion
        agent._list_server_models = model_listing  # pylint: disable=protected-access
        agent._call_huggingface_text_generation = hf_fallback  # pylint: disable=protected-access


@contextlib.contextmanager
def _read_only_chatgpt_auth(route, reject):
    """Allow an existing valid token, never automatic login, refresh or auth writes."""
    if route["provider"] != "chatgpt":
        yield
        return
    from litellm.llms.chatgpt.authenticator import Authenticator

    def unavailable(*_args, **_kwargs):
        reject("Native ChatGPT requires prior human login and a valid token; no automatic auth.")

    def auth_record(auth):
        try:
            file = Path(auth.auth_file)
            if not file.is_file() or file.is_symlink() or file.stat().st_size > 64 * 1024:
                raise ValueError("unsupported auth file")
            data = json.loads(file.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("unsupported auth record")
            return data
        except (OSError, ValueError, UnicodeError):
            unavailable()
        return None

    def access_token(auth):
        data = auth_record(auth)
        token = data.get("access_token")
        expiry = data.get("expires_at")
        if not isinstance(expiry, (int, float)) or isinstance(expiry, bool):
            expiry = auth._get_expires_at(token) if isinstance(token, str) else None  # pylint: disable=protected-access
        if (not isinstance(token, str) or not token or not isinstance(expiry, (int, float))
                or not math.isfinite(expiry) or time.time() >= expiry - 60):
            unavailable()
        return token

    def account_id(auth):
        access_token(auth)
        data = auth_record(auth)
        stored = data.get("account_id")
        if isinstance(stored, str) and stored:
            return stored
        token = data.get("id_token") or data.get("access_token")
        return auth._extract_account_id(token if isinstance(token, str) else None)  # pylint: disable=protected-access

    def ensure_dir(auth):
        if not Path(auth.token_dir).is_dir():
            unavailable()

    replacements = {"get_access_token": access_token, "get_account_id": account_id,
                    "_ensure_token_dir": ensure_dir, "_write_auth_file": unavailable,
                    "_login_device_code": unavailable, "_refresh_tokens": unavailable}
    original = {name: getattr(Authenticator, name) for name in replacements}
    try:
        for name, method in replacements.items():
            setattr(Authenticator, name, method)
        yield
    finally:
        for name, method in original.items():
            setattr(Authenticator, name, method)


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
    def incompatible(value):
        return (value.get("sandbox") == "agentfs" or value.get("sandbox_auto_session") is True
                or bool(value.get("sandbox_session"))
                or any(incompatible(item) for item in value.values() if isinstance(item, dict)))

    if incompatible(raw):
        raise NativeAuditError("Unsupported explicit native AgentFS backend/session requirement.")
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

    if (any(importlib.metadata.version(name) != version
            for name, version in RUNTIME_VERSIONS.items()) or sys.version_info < (3, 13)):
        raise NativeAuditError(
            "Unsupported native runtime; require Swival 1.0.46, LiteLLM 1.103.3, Python 3.13+."
        )
    if "USE_LITELLM_PROXY" in os.environ:
        raise NativeAuditError("Unsupported native transport proxy requirements.")
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
    public = _route_binding(settings, profile)
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


def _trusted_root_executable(executable, label="launcher"):
    """Require one canonical, root-owned executable without privilege bits."""
    path = Path(executable)
    try:
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as exc:
        raise NativeAuditError(f"Native {label} identity is unavailable.") from exc
    if (str(path) != str(resolved) or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0 or metadata.st_gid != 0
            or metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH | stat.S_ISUID | stat.S_ISGID)):
        raise NativeAuditError(f"Native {label} identity is not trusted.")
    return resolved, metadata


def _launcher_command(argv, label):
    """Run one already-trusted identity query with fixed limits and environment."""
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
    try:
        result = subprocess.run(argv, cwd="/", env=environment, shell=False,
                                stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=5, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise NativeAuditError(f"Native {label} package identity is unavailable.") from exc
    if (result.returncode or len(result.stdout) > 16 * 1024
            or len(result.stderr) > 16 * 1024):
        raise NativeAuditError(f"Native {label} package identity is unavailable.")
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeError as exc:
        raise NativeAuditError(f"Native {label} package identity is unavailable.") from exc


def _validate_launcher_identity(executable, identity, label):
    """Validate one reviewed Debian launcher before executing the launcher itself."""
    resolved, metadata = _trusted_root_executable(executable, label)
    if str(resolved) != identity["path"] or metadata.st_size > 1024 * 1024:
        raise NativeAuditError(f"Native {label} identity is unsupported.")
    getxattr = getattr(os, "getxattr", None)
    if not callable(getxattr):
        raise NativeAuditError(f"Native {label} file capabilities are unverifiable.")
    try:
        capability = operator.call(
            getxattr, resolved, "security.capability", follow_symlinks=False)
    except OSError as exc:
        if exc.errno != errno.ENODATA:
            raise NativeAuditError(
                f"Native {label} file capabilities are unverifiable.") from exc
    else:
        if capability:
            raise NativeAuditError(f"Native {label} file capabilities are unsupported.")
    digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
    if digest != identity["sha256"]:
        raise NativeAuditError(f"Native {label} executable hash is unsupported.")
    query, _ = _trusted_root_executable("/usr/bin/dpkg-query", "dpkg-query")
    query_format = "-f=${Package}\\t${Version}\\t${Architecture}\\t${db:Status-Status}\\n"
    package = _launcher_command(
        [str(query), "-W", query_format, identity["package"]], label).split("\t")
    if package != [identity["package"], identity["packageVersion"],
                    identity["architecture"], "installed"]:
        raise NativeAuditError(f"Native {label} package identity is unsupported.")
    expected_owner = f'{identity["package"]}: {identity["path"]}'
    if _launcher_command([str(query), "-S", str(resolved)], label) != expected_owner:
        raise NativeAuditError(f"Native {label} package ownership is unsupported.")
    if _launcher_command([str(resolved), "--version"], label) != identity["version"]:
        raise NativeAuditError(f"Native {label} version is unsupported.")
    return dict(identity)


def validate_unshare_identity(executable):
    """Validate the reviewed util-linux executable and Debian package identity."""
    return _validate_launcher_identity(executable, UNSHARE_IDENTITY, "unshare")


def validate_bwrap_identity(executable):
    """Validate the reviewed bubblewrap executable and Debian package identity."""
    return _validate_launcher_identity(executable, BWRAP_IDENTITY, "bubblewrap")


def _trusted_nono_executable(executable, *, host_path=True):
    """Require a canonical executable protected from other-user replacement."""
    if not isinstance(executable, str) or not os.path.isabs(executable):
        raise NativeAuditError("Native nono identity is unavailable.")
    candidate = Path(executable)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise NativeAuditError("Native nono identity is unavailable.") from exc
    if str(candidate) != executable or str(resolved) != executable:
        raise NativeAuditError("Native nono executable is not canonical.")
    trusted_uids = {0, os.getuid()}
    try:
        if host_path:
            for ancestor in reversed(resolved.parents):
                metadata = ancestor.lstat()
                writable = metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
                if (not stat.S_ISDIR(metadata.st_mode) or ancestor.is_symlink()
                        or metadata.st_uid not in trusted_uids
                        or (writable and not metadata.st_mode & stat.S_ISVTX)):
                    raise NativeAuditError("Native nono path ancestry is not trusted.")
        metadata = resolved.lstat()
    except OSError as exc:
        raise NativeAuditError("Native nono path ancestry is unavailable.") from exc
    unsafe = stat.S_IWGRP | stat.S_IWOTH | stat.S_ISUID | stat.S_ISGID
    trusted = all((stat.S_ISREG(metadata.st_mode),
                   not host_path or metadata.st_uid in trusted_uids,
                   not metadata.st_mode & unsafe, bool(metadata.st_mode & 0o111),
                   os.access(resolved, os.X_OK)))
    if not trusted:
        raise NativeAuditError("Native nono executable ownership or mode is not trusted.")
    if metadata.st_size != NONO_ARTIFACT_IDENTITY["bytes"]:
        raise NativeAuditError("Native nono executable size is unsupported.")
    return resolved, metadata


def _verify_nono_capabilities(resolved):
    """Require a supported capability API to prove the xattr is absent."""
    getxattr = getattr(os, "getxattr", None)
    if not callable(getxattr):
        raise NativeAuditError("Native nono file capabilities are unverifiable.")
    try:
        operator.call(getxattr, resolved, "security.capability", follow_symlinks=False)
    except OSError as exc:
        absent = {errno.ENODATA, getattr(errno, "ENOATTR", errno.ENODATA)}
        if exc.errno not in absent:
            raise NativeAuditError(
                "Native nono file capabilities are unverifiable.") from exc
    else:
        raise NativeAuditError("Native nono file capabilities are unsupported.")


def _nono_artifact_digest(resolved, metadata):
    """Hash exactly the reviewed byte count and verify an ARM64 Linux ELF header."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = None
    try:
        descriptor = os.open(resolved, flags)
        opened = os.fstat(descriptor)
        before = (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid,
                  metadata.st_gid, metadata.st_size)
        after = (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid,
                 opened.st_gid, opened.st_size)
        if before != after or not stat.S_ISREG(opened.st_mode):
            raise NativeAuditError("Native nono executable changed during authentication.")
        digest = hashlib.sha256()
        header = bytearray()
        total = 0
        while True:
            chunk = os.read(descriptor, min(1024 * 1024,
                            NONO_ARTIFACT_IDENTITY["bytes"] + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > NONO_ARTIFACT_IDENTITY["bytes"]:
                raise NativeAuditError("Native nono executable size is unsupported.")
            if len(header) < 20:
                header.extend(chunk[:20 - len(header)])
            digest.update(chunk)
    except OSError as exc:
        raise NativeAuditError("Native nono executable bytes are unavailable.") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if total != NONO_ARTIFACT_IDENTITY["bytes"]:
        raise NativeAuditError("Native nono executable size is unsupported.")
    machine = os.uname().machine.lower()
    if (header[:4] != b"\x7fELF" or header[4:7] != bytes((2, 1, 1))
            or int.from_bytes(header[18:20], "little") != 183
            or machine not in {"aarch64", "arm64"}):
        raise NativeAuditError("Native nono ELF architecture is unsupported.")
    return digest.hexdigest()


def _stop_identity_process(process):
    if process is None or process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


# Keep process creation, bounded pipe reads, timeout, and teardown in one scope.
# pylint: disable-next=too-many-branches,too-many-locals
def _bounded_nono_version(resolved):
    """Run only authenticated ``nono --version`` with fixed limits."""
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
                   "NONO_NO_UPDATE_CHECK": "1"}
    process = None
    selector = selectors.DefaultSelector()
    streams = []
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        process = subprocess.Popen(  # pylint: disable=consider-using-with
            [str(resolved), "--version"], cwd="/", env=environment, shell=False,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, close_fds=True)
        streams = [process.stdout, process.stderr]
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        deadline = time.monotonic() + _NONO_COMMAND_TIMEOUT
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(str(resolved), _NONO_COMMAND_TIMEOUT)
            events = selector.select(remaining)
            if not events:
                raise subprocess.TimeoutExpired(str(resolved), _NONO_COMMAND_TIMEOUT)
            for key, _mask in events:
                chunk = os.read(key.fd, 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                buffers[key.data].extend(chunk)
                if len(buffers[key.data]) > _NONO_OUTPUT_LIMIT:
                    raise NativeAuditError("Native nono version output exceeded its limit.")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(str(resolved), _NONO_COMMAND_TIMEOUT)
        returncode = process.wait(timeout=remaining)
    except (OSError, subprocess.SubprocessError, NativeAuditError) as exc:
        _stop_identity_process(process)
        raise NativeAuditError("Native nono version identity is unavailable.") from exc
    finally:
        selector.close()
        for stream in streams:
            if stream is not None and not stream.closed:
                stream.close()
    if returncode or buffers["stderr"]:
        raise NativeAuditError("Native nono version identity is unavailable.")
    return bytes(buffers["stdout"])


def _nono_version(resolved):
    try:
        output = _bounded_nono_version(resolved).decode("utf-8")
    except UnicodeError as exc:
        raise NativeAuditError("Native nono version identity is unavailable.") from exc
    return output[:-1] if output.endswith("\n") and not output.endswith("\n\n") else output


def _supported_nono_config_home():
    """Resolve the one native profile store that the namespace exposes."""
    home_value = os.environ.get("HOME")
    if not isinstance(home_value, str) or not os.path.isabs(home_value):
        raise NativeAuditError("Native nono HOME selection is unsupported.")
    try:
        home = Path(home_value).resolve(strict=True)
        default_config = (home / ".config").resolve(strict=True)
    except OSError as exc:
        raise NativeAuditError("Native nono default profile store is unavailable.") from exc
    if not home.is_dir() or not default_config.is_dir():
        raise NativeAuditError("Native nono default profile store is unavailable.")
    xdg_value = os.environ.get("XDG_CONFIG_HOME")
    if xdg_value is not None:
        if not xdg_value or not os.path.isabs(xdg_value):
            raise NativeAuditError("Native nono XDG profile store is unsupported.")
        try:
            xdg_config = Path(xdg_value).resolve(strict=True)
        except OSError as exc:
            raise NativeAuditError("Native nono XDG profile store is unsupported.") from exc
        if xdg_config != default_config:
            raise NativeAuditError("Native nono XDG profile store is unsupported.")
    return default_config


def _trusted_nono_profile_path(target, *, directory, host_path):
    """Require a canonical local profile input protected from replacement."""
    candidate = Path(target)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise NativeAuditError("Native nono local profile input is unavailable.") from exc
    if not candidate.is_absolute() or candidate != resolved:
        raise NativeAuditError("Native nono local profile path is not canonical.")
    trusted_uids = {0, os.getuid()}
    try:
        for ancestor in reversed(resolved.parents):
            metadata = ancestor.lstat()
            writable = metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
            trusted_owner = not host_path or metadata.st_uid in trusted_uids
            if (not stat.S_ISDIR(metadata.st_mode) or ancestor.is_symlink()
                    or not trusted_owner
                    or (writable and not metadata.st_mode & stat.S_ISVTX)):
                raise NativeAuditError("Native nono local profile ancestry is unsafe.")
        metadata = resolved.lstat()
    except OSError as exc:
        raise NativeAuditError("Native nono local profile input is unavailable.") from exc
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if (not expected_type(metadata.st_mode)
            or (host_path and metadata.st_uid not in trusted_uids)
            or metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
            or resolved.is_symlink()):
        raise NativeAuditError("Native nono local profile input is unsafe.")
    return resolved, metadata


def _bounded_local_json(target, limit, *, host_path):
    resolved, metadata = _trusted_nono_profile_path(
        target, directory=False, host_path=host_path)
    if metadata.st_size > limit:
        raise NativeAuditError("Native nono local profile input exceeded its limit.")
    descriptor = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(resolved, flags)
        opened = os.fstat(descriptor)
        before = (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid,
                  metadata.st_gid, metadata.st_size)
        after = (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid,
                 opened.st_gid, opened.st_size)
        if before != after or not stat.S_ISREG(opened.st_mode):
            raise NativeAuditError("Native nono local profile input changed.")
        contents = bytearray()
        while len(contents) <= limit:
            chunk = os.read(descriptor, min(64 * 1024, limit + 1 - len(contents)))
            if not chunk:
                break
            contents.extend(chunk)
    except OSError as exc:
        raise NativeAuditError("Native nono local profile input is unavailable.") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if len(contents) > limit or len(contents) != metadata.st_size:
        raise NativeAuditError("Native nono local profile input exceeded its limit.")
    try:
        parsed = json.loads(bytes(contents).decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise NativeAuditError("Native nono local profile input is invalid.") from exc
    if not isinstance(parsed, dict):
        raise NativeAuditError("Native nono local profile input is invalid.")
    identity = {"path": str(resolved), "bytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest()}
    return parsed, identity


def validate_nono_profile_identity(*, host_path=True):
    """Validate the exact local pack inputs used by the released profile loader."""
    config = _supported_nono_config_home()
    pack = config / "nono" / "packages" / "jedisct1" / "swival"
    pack, _metadata = _trusted_nono_profile_path(
        pack, directory=True, host_path=host_path)
    manifest, manifest_identity = _bounded_local_json(
        pack / "package.json", _NONO_MANIFEST_LIMIT, host_path=host_path)
    artifacts = manifest.get("artifacts")
    if (not isinstance(manifest.get("schema_version"), int)
            or isinstance(manifest.get("schema_version"), bool)
            or not isinstance(manifest.get("name"), str)
            or not isinstance(artifacts, list) or len(artifacts) > 128):
        raise NativeAuditError("Native nono local package manifest is invalid.")
    profile_artifacts = [artifact for artifact in artifacts
                         if isinstance(artifact, dict)
                         and artifact.get("type") == "profile"]
    if len(profile_artifacts) != 1:
        raise NativeAuditError("Native nono local package profile selection is ambiguous.")
    selected = profile_artifacts[0]
    if (selected.get("install_as") != "swival"
            or not isinstance(selected.get("path"), str) or not selected["path"]):
        raise NativeAuditError("Native nono local package has no Swival profile.")
    profile, profile_identity = _bounded_local_json(
        pack / "profiles" / "swival.json", _NONO_PROFILE_LIMIT, host_path=host_path)
    if not profile:
        raise NativeAuditError("Native nono local Swival profile is invalid.")
    return {"config": str(config), "pack": str(pack),
            "manifest": manifest_identity, "profile": profile_identity}


def _bound_nono_file_identity(item):
    if not isinstance(item, dict) or set(item) != _NONO_FILE_IDENTITY_KEYS:
        return False
    item_path = item.get("path")
    item_bytes = item.get("bytes")
    item_hash = item.get("sha256")
    if not isinstance(item_path, str) or not os.path.isabs(item_path):
        return False
    if (not isinstance(item_bytes, int) or isinstance(item_bytes, bool)
            or item_bytes < 0):
        return False
    return (isinstance(item_hash, str)
            and bool(re.fullmatch(r"[a-f0-9]{64}", item_hash)))


def _bound_nono_profile_identity(identity):
    return (isinstance(identity, dict)
            and set(identity) == _NONO_PROFILE_IDENTITY_KEYS
            and all(isinstance(identity.get(key), str)
                    and os.path.isabs(identity[key]) for key in ("config", "pack"))
            and all(_bound_nono_file_identity(identity.get(key))
                    for key in ("manifest", "profile")))


def validate_nono_identity(executable, *, host_path=True):
    """Authenticate the reviewed nono artifact before any nono execution."""
    resolved, metadata = _trusted_nono_executable(executable, host_path=host_path)
    _verify_nono_capabilities(resolved)
    digest = _nono_artifact_digest(resolved, metadata)
    if digest != NONO_ARTIFACT_IDENTITY["sha256"]:
        raise NativeAuditError("Native nono executable hash is unsupported.")
    if _nono_version(resolved) != f'nono {NONO_ARTIFACT_IDENTITY["version"]}':
        raise NativeAuditError("Native nono version is unsupported.")
    return {"path": str(resolved), **NONO_ARTIFACT_IDENTITY}


def _bound_nono_identity(identity, executable):
    return (isinstance(identity, dict) and set(identity) == _NONO_IDENTITY_KEYS
            and identity.get("path") == executable
            and all(identity.get(key) == value
                    for key, value in NONO_ARTIFACT_IDENTITY.items()))


def _verify_sdk_nono_resolution(executable):
    """Call the pinned SDK resolver and bind its selected target to the request."""
    from swival import sandbox_nono

    try:
        selected = sandbox_nono._find_nono()  # pylint: disable=protected-access
        if not isinstance(selected, str) or not os.path.isabs(selected):
            raise ValueError("non-absolute SDK selection")
        resolved = Path(selected).resolve(strict=True)
    except Exception as exc:
        raise NativeAuditError("Native SDK nono resolution is unavailable.") from exc
    if str(resolved) != executable:
        raise NativeAuditError("Native SDK nono executable changed.")


def _revalidate_nono(request, *, host_path=True):
    identity = validate_nono_identity(request.get("nono"), host_path=host_path)
    if identity != request.get("nonoIdentity"):
        raise NativeAuditError("Native nono identity changed before execution.")
    _verify_sdk_nono_resolution(identity["path"])
    return identity


def _revalidate_nono_profile(request, *, host_path=True):
    identity = validate_nono_profile_identity(host_path=host_path)
    if identity != request.get("nonoProfileIdentity"):
        raise NativeAuditError("Native nono local profile changed before execution.")
    return identity


@contextlib.contextmanager
def _bound_nono_sdk(request):
    """Replace the released unbounded package query after a bounded check."""
    from swival import sandbox_nono

    # Bubblewrap can remap host owner IDs. Probe and launch already verified
    # owner/ancestor policy; the read-only final boundary reauthenticates modes,
    # capabilities, architecture, exact bytes, version, and SDK resolution.
    identity = _revalidate_nono(request, host_path=False)
    if sandbox_nono.WRAPPER_PROFILE != _NONO_WRAPPER_PROFILE:
        raise NativeAuditError("Native SDK nono profile identity changed.")
    _revalidate_nono_profile(request, host_path=False)
    original = sandbox_nono.profile_pack_installed

    def installed(executable, profile):
        try:
            selected = Path(executable)
            resolved = selected.resolve(strict=True)
        except (OSError, TypeError) as exc:
            raise NativeAuditError("Native SDK nono package query changed.") from exc
        if (not selected.is_absolute() or str(resolved) != identity["path"]
                or profile != _NONO_WRAPPER_PROFILE):
            raise NativeAuditError("Native SDK nono package query changed.")
        return True

    sandbox_nono.profile_pack_installed = installed
    try:
        yield
    finally:
        sandbox_nono.profile_pack_installed = original


def run_native(request):
    """Dispatch exactly one /audit with fixed, restrictive Session policies."""
    platform_verified = all((
        sys.platform == "linux", request.get("sandbox") == "bubblewrap",
        request.get("bwrapVersion") == "0.12.0",
        request.get("bwrapIdentity") == BWRAP_IDENTITY,
        request.get("unshareIdentity") == UNSHARE_IDENTITY,
        _bound_nono_identity(request.get("nonoIdentity"), request.get("nono")),
        _bound_nono_profile_identity(request.get("nonoProfileIdentity")),
        request.get("sessionSandbox") == "builtin",
    ))
    if not platform_verified:
        raise NativeAuditError("Unverified native bubblewrap/platform isolation; no fallback.")
    check_boundary()
    settings, public = resolve_native_config(request)
    if request.get("expectedRoute") != public:
        raise NativeAuditError("Native route changed after preflight; no fallback.")
    scope = native_scope(request)
    if not scope["mandatory_files"]:
        return {"status": "empty_scope", "error": "No auditable committed files in scope.",
                "scope": scope}
    if request.get("expectedScope") != scope:
        raise NativeAuditError("Native committed scope changed after preflight.")
    from swival.session import Session

    options = request["audit"]
    command = "/audit " + " ".join([
        *options.get("paths", []), *( ["--all"] if options.get("all") else [] ),
        "--workers", str(options["workers"]), "--patch-max-turns", str(options["patchMaxTurns"]),
    ])
    with (_bound_transport(public),
          _expansion_failures(len(scope["mandatory_files"])) as failures,
          # This final context authenticates nono and its fixed local package
          # query immediately before Session invokes the released SDK path.
          _bound_nono_sdk(request),
          Session(**settings, base_dir=request["snapshot"], files="some", commands="none",
                  sandbox="builtin", sandbox_auto_session=False, network="provider-only",
                  no_instructions=True, no_skills=True, metaskills="off", memory=False,
                  history=False, continue_here=False, subagents=False, lifecycle_enabled=False,
                  mcp_servers=None, a2a_servers=None, trace_dir=None, read_guard=True) as session):
        result = session.ask(command, parse_commands=True)
    return {"status": "failed" if result.exhausted else "partial" if failures else "completed",
            "unrecoveredExpansionFailures": sum(failures), "answer": result.answer,
            "scope": scope, "route": public,
            "provider": public["provider"], "model": public["model"],
            "requestedEffort": public["reasoningEffort"], "network": "provider-only",
            "sandbox": {"external": "bubblewrap", "bwrapVersion": request.get("bwrapVersion"),
                        "bwrapIdentity": request.get("bwrapIdentity"),
                        "nonoIdentity": request.get("nonoIdentity"),
                        "nonoProfileIdentity": request.get("nonoProfileIdentity"),
                        "startup": {"executable": "unshare",
                                    "identity": request.get("unshareIdentity")},
                        "session": "builtin"},
            "verification": "Native verifier judgment; project commands and PoCs cannot execute."}


def _validate_private_mountinfo(text):
    """Mountinfo optional fields describe live propagation edges, not path policy.

    No shared/master/propagate_from edge means subsequent ordinary host mounts
    cannot enter this captured namespace. A privileged host can still change files
    or enter namespaces directly; that is outside this boundary.
    """
    if not isinstance(text, str) or len(text) > 1024 * 1024:
        raise NativeAuditError("Native mount layout is oversized or unavailable.")
    lines = text.splitlines()
    if not lines or len(lines) > 4096:
        raise NativeAuditError("Native mount layout is unsupported.")
    roots = []
    for line in lines:
        fields = line.split()
        try:
            separator = fields.index("-")
            identity_valid = (fields[0].isdigit() and fields[1].isdigit()
                              and re.fullmatch(r"[0-9]+:[0-9]+", fields[2]))
            paths_valid = fields[3].startswith("/") and fields[4].startswith("/")
            if separator < 6 or len(fields) != separator + 4 or not (
                    identity_valid and paths_valid):
                raise ValueError("unsupported mountinfo")
            if any(field != "unbindable" for field in fields[6:separator]):
                raise NativeAuditError(
                    "Native isolation refuses shared/slave or unknown mount propagation. "
                    "Use an approved propagation-free Linux environment; no provider started."
                )
            if fields[4] == "/":
                roots.append(fields[5].split(","))
        except ValueError as exc:
            raise NativeAuditError("Native mount layout is unsupported.") from exc
    if len(roots) != 1 or "ro" not in roots[0] or "rw" in roots[0]:
        raise NativeAuditError("Native original root is not exclusively read-only.")


def _validate_status_boundary(fields):
    """Require NoNewPrivs and zero inheritable, ambient, bounding, and task caps."""
    try:
        valid = (fields.get("NoNewPrivs", "").strip() == "1"
                 and all(int(fields.get(key, "1").strip(), 16) == 0
                         for key in ("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd")))
    except ValueError as exc:
        raise NativeAuditError("Native capability boundary is unsupported.") from exc
    if not valid:
        raise NativeAuditError("Native capability boundary is unsupported.")


def check_boundary():
    """Reached kernel checks; builtin Session policies are not OS enforcement."""
    if sys.platform != "linux" or os.getpid() != 2 or os.getppid() != 1:
        raise NativeAuditError("Native payload did not reach its private PID namespace.")
    status = Path("/proc/self/status").read_text(encoding="utf-8").splitlines()
    fields = dict(line.split(":", 1) for line in status if ":" in line)
    _validate_status_boundary(fields)
    if "AGENTFS" in os.environ:
        raise NativeAuditError("Native environment boundary is unsupported.")
    with Path("/proc/self/mountinfo").open(encoding="utf-8") as stream:
        _validate_private_mountinfo(stream.read(1024 * 1024 + 1))
    try:
        os.unshare(os.CLONE_NEWUSER)  # pylint: disable=no-member
    except OSError:
        return
    raise NativeAuditError("Native nested user namespaces were not disabled.")


def bubblewrap_argv(request, payload):
    """Recursive RO root, private mounts, explicit visibility, then only S/E writes."""
    argv = [request["bwrap"], "--unshare-user", "--disable-userns", "--unshare-pid",
            "--unshare-ipc", "--die-with-parent", "--cap-drop", "ALL", "--ro-bind", "/", "/",
            "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--dev", "/dev", "--proc", "/proc"]
    roots = request.get("readOnlyPaths", [])
    if (not isinstance(roots, list) or len(roots) > 64
            or any(not isinstance(root, str) or not os.path.isabs(root) for root in roots)):
        raise NativeAuditError("Unsupported native read-only visibility.")
    for root in sorted(set(roots), key=lambda value: (len(Path(value).parts), value)):
        if os.path.normpath(root) in {"/", "/tmp", "/var/tmp", "/dev", "/proc", "/dev/shm"}:
            raise NativeAuditError("Native visibility cannot replace a private mount root.")
        argv.extend(["--ro-bind", root, root])
    for key in ("snapshot", "evidence"):
        if key in request:
            argv.extend(["--bind", request[key], request[key]])
    argv.extend(["--chdir", request.get("snapshot", "/"), "--", *payload])
    return argv


def sandbox_argv(request, payload, status_fd, block_fd):
    """Build the exact reviewed unshare prefix around controlled bubblewrap argv."""
    bwrap = bubblewrap_argv(request, payload)
    separator = bwrap.index("--")
    bwrap[separator:separator] = ["--info-fd", str(status_fd),
                                  "--block-fd", str(block_fd)]
    return [request["unshare"], "--user", "--map-current-user", "--mount",
            "--propagation", "private", "--", *bwrap]


# Keep the live namespace ownership, commit pipes and bounded teardown in one scope.
# pylint: disable-next=too-many-locals,too-many-branches,too-many-statements
def supervise_bubblewrap(request, payload, input_bytes=None):
    """Pin init while bwrap blocks; pidfd readability proves namespace teardown.

    The status/block pipes and pidfd remain outside the payload. bwrap 0.12 closes
    the control descriptors before exec. Its monitor exit alone is not proof.
    """
    status_r, status_w = os.pipe()
    block_r, block_w = os.pipe()
    proc = None
    init = None
    stopped = []
    previous = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGTERM, lambda *_args: stopped.append(True))
    # Bind this trusted supervisor to its live wrapper without privilege changes.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() == 1:
        raise NativeAuditError("Native parent-loss control unavailable.")
    verified = False
    launched = False
    try:
        argv = sandbox_argv(request, payload, status_w, block_r)
        proc = subprocess.Popen(  # pylint: disable=consider-using-with
            argv, cwd=request.get("snapshot", "/"), shell=False, close_fds=True,
            pass_fds=(status_w, block_r), stdin=subprocess.PIPE)
        launched = True
        os.close(status_w)
        status_w = None
        os.close(block_r)
        block_r = None
        if not select.select([status_r], [], [], 5)[0]:
            raise NativeAuditError("Native namespace ownership setup timed out.")
        info = json.loads(os.read(status_r, 4096))
        pid = info.get("child-pid")
        if type(pid) is not int or pid <= 1:  # pylint: disable=unidiomatic-typecheck
            raise NativeAuditError("Native namespace ownership status invalid.")
        init = os.pidfd_open(pid)  # pylint: disable=no-member
        fields = dict(line.split(":", 1) for line in
                      Path(f"/proc/{pid}/status").read_text(encoding="utf-8").splitlines()
                      if ":" in line)
        if int(fields["PPid"].strip()) != proc.pid:
            raise NativeAuditError("Native namespace init is not live-owned.")
        if not stopped:
            if request.get("controlProof"):
                os.write(4, b"STARTED\n")
            os.write(block_w, b"1")
            proc.stdin.write(input_bytes or b"")
            proc.stdin.close()
        end = time.monotonic() + request.get("timeoutMs", 10000) / 1000
        while proc.poll() is None and not stopped and time.monotonic() < end:
            time.sleep(0.02)
        if proc.poll() is None:
            proc.terminate()
        try:
            code = proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = proc.wait(timeout=1)
        if not select.select([init], [], [], 1)[0]:
            signal.pidfd_send_signal(init, signal.SIGKILL)  # pylint: disable=no-member
        verified = bool(select.select([init], [], [], 1)[0])
        if not verified:
            raise NativeAuditError("Native namespace init death was not verified.")
        return code if not stopped else 143
    finally:
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=1)
            if init is not None and not verified:
                try:
                    signal.pidfd_send_signal(init, signal.SIGKILL)  # pylint: disable=no-member
                    verified = bool(select.select([init], [], [], 1)[0])
                except OSError:
                    pass
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        for fd in (status_r, status_w, block_r, block_w, init):
            if fd is not None:
                os.close(fd)
        signal.signal(signal.SIGTERM, previous)
        if request.get("controlProof"):
            try:
                os.write(4, b"VERIFIED\n" if verified else
                         b"NOT_STARTED\n" if not launched else b"UNVERIFIED\n")
            except OSError:
                pass  # Lost live control never becomes persisted signalling authority.


def _revalidate_launchers(request):
    """Bind all prepared identities to their executables immediately before launch."""
    if validate_unshare_identity(request.get("unshare")) != request.get("unshareIdentity"):
        raise NativeAuditError("Native unshare identity changed before execution.")
    if validate_bwrap_identity(request.get("bwrap")) != request.get("bwrapIdentity"):
        raise NativeAuditError("Native bubblewrap identity changed before execution.")
    _revalidate_nono(request)
    _revalidate_nono_profile(request)


def launch_native():
    """Wait for live ownership and bounded EXEC/EOF before unshare and bubblewrap."""
    if len(sys.argv) != 6:
        raise NativeAuditError("Unsupported native launcher arguments.")
    unshare, bwrap, snapshot, evidence = sys.argv[2:]
    if not all(os.path.isabs(value) for value in (unshare, bwrap, snapshot, evidence)):
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
    os.close(3)
    os.closerange(5, os.sysconf("SC_OPEN_MAX"))
    request_bytes = sys.stdin.buffer.read(64 * 1024 + 1)
    if len(request_bytes) > 64 * 1024:
        raise NativeAuditError("Native request exceeded its bounded protocol.")
    request = json.loads(request_bytes)
    if any(request.get(key) != value for key, value in
           (("unshare", unshare), ("bwrap", bwrap),
            ("snapshot", snapshot), ("evidence", evidence))):
        raise NativeAuditError("Native launcher scope changed.")
    _revalidate_launchers(request)
    request["controlProof"] = True
    code = supervise_bubblewrap(request, [request["python"], "-I", "-B",
                               str(Path(__file__).resolve()), "--run"], request_bytes)
    sys.exit(code)


# Fixed protocol modes remain explicit and value-free.
# pylint: disable-next=too-many-branches
def main():
    """Run the bounded JSON protocol with value-free diagnostics."""
    if sys.argv[1:2] == ["--launch"]:
        launch_native()
        return
    if sys.argv[1:] == ["--boundary-check"]:
        check_boundary()
        print("Native kernel boundary reached.")
        return
    request = json.loads(sys.stdin.read(64 * 1024))
    if sys.argv[1:] == ["--validate-unshare"]:
        print(json.dumps(validate_unshare_identity(request.get("unshare"))))
    elif sys.argv[1:] == ["--validate-bwrap"]:
        print(json.dumps(validate_bwrap_identity(request.get("bwrap"))))
    elif sys.argv[1:] == ["--validate-nono"]:
        print(json.dumps(validate_nono_identity(request.get("nono"))))
    elif sys.argv[1:] == ["--validate-nono-profile"]:
        print(json.dumps(validate_nono_profile_identity()))
    elif sys.argv[1:] == ["--probe"]:
        _revalidate_launchers(request)
        code = supervise_bubblewrap(request, [request["python"], "-I", "-B",
                                   str(Path(__file__).resolve()), "--boundary-check"])
        if code:
            raise NativeAuditError("Native bubblewrap runtime capability check failed.")
    elif sys.argv[1:] == ["--preflight"]:
        _, public = resolve_native_config(request)
        _supported_nono_config_home()
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
