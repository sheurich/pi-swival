"""Restricted bridge to the released native /audit entry point.

Preflight never creates a Session or resolves provider credentials. Only validated
non-secret route metadata leaves memory; diagnostics never include configuration values.
"""

# Swival imports remain lazy so preflight cannot initialize a provider.
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
import select
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
        yield
        if violated.is_set():
            raise NativeAuditError("Native transport route guard failed; no fallback.")
    finally:
        litellm.completion = completion
        agent._list_server_models = model_listing  # pylint: disable=protected-access
        agent._call_huggingface_text_generation = hf_fallback  # pylint: disable=protected-access


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


def run_native(request):
    """Dispatch exactly one /audit with fixed, restrictive Session policies."""
    if sys.platform == "darwin" and request.get("agentfsVersion") == "0.6.4":
        raise NativeAuditError(
            "Native audit is blocked on Darwin/macOS with AgentFS 0.6.4: writable temporary roots."
        )
    if sys.platform != "linux" or request.get("agentfsVersion") != "0.6.4":
        raise NativeAuditError("Unverified native AgentFS/platform isolation; no fallback.")
    settings, public = resolve_native_config(request)
    if request.get("expectedRoute") != public:
        raise NativeAuditError("Native route changed after preflight; no fallback.")
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
    with (_bound_transport(public),
          _expansion_failures(len(scope["mandatory_files"])) as failures,
          Session(**settings, base_dir=request["snapshot"], files="some", commands="none",
                  sandbox="agentfs", sandbox_auto_session=False, network="provider-only",
                  no_instructions=True, no_skills=True, metaskills="off", memory=False,
                  history=False, continue_here=False, subagents=False, lifecycle_enabled=False,
                  mcp_servers=None, a2a_servers=None, trace_dir=None, read_guard=True) as session):
        result = session.ask(command, parse_commands=True)
    return {"status": "failed" if result.exhausted else "partial" if failures else "completed",
            "unrecoveredExpansionFailures": sum(failures), "answer": result.answer,
            "scope": scope, "route": public,
            "provider": public["provider"], "model": public["model"],
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
