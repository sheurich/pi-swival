"""Startup compatibility shim for Anthropic OAuth and Vertex bearer tokens in Swival/LiteLLM.

Loaded via PYTHONPATH when Swival runs with provider in ("anthropic", "bedrock", "geap").
1. Forces LITELLM_LOCAL_MODEL_COST_MAP=True before importing LiteLLM so startup
   never fetches the remote model cost map over the network.
2. Disables dynamic /v1/models lookup on AnthropicModelInfo and Swival's
   _list_server_models so NotFoundError cannot trigger singleton model
   replacement.
3. Injects the required Claude Code OAuth headers and leading system block
   when an Anthropic OAuth token (sk-ant-oat...) is used.
4. Bridges a host-minted short-lived GOOGLE_OAUTH_ACCESS_TOKEN into LiteLLM's
   VertexBase.load_auth without reading ~/.config/gcloud or ADC files.
5. Backfills LiteLLM model-map entries for Anthropic models newer than the
   pinned LiteLLM release, so reasoning effort is sent instead of dropped.

Hooks 2-4 (and the self-review suppression requested by PI_SWIVAL_NO_SELF_REVIEW)
are required route-identity guards: ``install_required_shim(require_hooks=True)``
verifies every upstream target is present and callable before patching and
records the outcome in ``SHIM_ATTESTATION``. Hook 5 is optional pricing
metadata and never blocks startup.
"""
from __future__ import annotations

# pylint: disable=import-outside-toplevel,broad-exception-caught,protected-access
import importlib.util
import os
from pathlib import Path
import sys
import time

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.290"
REQUIRED_OAUTH_BETAS = ("claude-code-20250219", "oauth-2025-04-20")
CREDENTIAL_EXPIRED_SENTINEL = "PI_SWIVAL_CREDENTIAL_EXPIRED"
SHIM_INSTALL_FAILED_SENTINEL = "PI_SWIVAL_SHIM_INSTALL_FAILED"

# Required hook names -> installed. Updated only by install_required_shim.
SHIM_ATTESTATION: dict[str, bool] = {
    "model_discovery_disabled": False,
    "oauth_headers": False,
    "vertex_bearer": False,
    "self_review_suppressed": False,
}

# model -> (sibling entry to clone, base rates in USD per token).
# LiteLLM drops `output_config.effort` for a model missing from its map.
# An entry LiteLLM already ships is left untouched.
MODEL_MAP_BACKFILL = {
    "claude-mythos-5-2": (
        "claude-mythos-5-1",
        {
            "input_cost_per_token": 8e-06,
            "output_cost_per_token": 4e-05,
            "cache_read_input_token_cost": 2e-07,
            "cache_creation_input_token_cost": 1e-05,
        },
    ),
}


def _emit_credential_expired():
    try:
        sys.stderr.write(f"\n{CREDENTIAL_EXPIRED_SENTINEL}\n")
        sys.stderr.flush()
    except Exception:
        pass


class _StaticVertexBearerCredentials:
    """In-memory bearer token credential for Vertex AI without disk/ADC refresh."""

    def __init__(self, token: str, project_id: str | None, not_after: float | None):
        self.token = token
        self.project_id = project_id
        self.quota_project_id = project_id
        self._not_after = not_after
        self.valid = True

    @property
    def expired(self) -> bool:
        return self._not_after is not None and time.time() >= self._not_after

    def refresh(self, _request=None):
        _emit_credential_expired()
        raise RuntimeError(
            f"{CREDENTIAL_EXPIRED_SENTINEL}: host-injected GOOGLE_OAUTH_ACCESS_TOKEN expired"
        )


def _backfill_model_map(litellm):
    """Optional pricing/effort metadata; failures never block a route-identity hook."""
    for model, (sibling, rates) in MODEL_MAP_BACKFILL.items():
        try:
            if model in litellm.model_cost or sibling not in litellm.model_cost:
                continue
            # Only the base rates are known for the new model; drop the sibling's
            # batch and long-cache rates rather than report them as its own.
            entry = {
                key: value
                for key, value in litellm.model_cost[sibling].items()
                if not key.endswith(("_batches", "_above_1hr"))
            }
            entry.update(rates)
            litellm.register_model({model: entry})
        except Exception:
            pass


def _required_callable(owner, name):
    target = getattr(owner, name, None)
    if not callable(target):
        raise RuntimeError(f"{SHIM_INSTALL_FAILED_SENTINEL}: {name} is unavailable")
    return target


def _install_vertex_bearer_shim(vertex_base):
    orig_load_auth = _required_callable(vertex_base, "load_auth")
    if getattr(orig_load_auth, "_pi_swival_vertex_bearer", False) is True:
        return

    def _wrapped_load_auth(self, credentials, project_id):
        token = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "").strip()
        if credentials is None and token:
            not_after_raw = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN_NOT_AFTER", "").strip()
            not_after = float(not_after_raw) if not_after_raw else None
            if not_after is not None and time.time() >= not_after:
                _emit_credential_expired()
                raise RuntimeError(
                    f"{CREDENTIAL_EXPIRED_SENTINEL}: host-injected GOOGLE_OAUTH_ACCESS_TOKEN expired"
                )
            resolved_project = (
                project_id
                or os.environ.get("GOOGLE_CLOUD_PROJECT")
                or os.environ.get("VERTEXAI_PROJECT")
            )
            if not resolved_project or not isinstance(resolved_project, str):
                raise ValueError("Could not resolve project_id")
            return (
                _StaticVertexBearerCredentials(token, resolved_project, not_after),
                resolved_project,
            )
        return orig_load_auth(self, credentials, project_id)

    _wrapped_load_auth._pi_swival_vertex_bearer = True
    vertex_base.load_auth = _wrapped_load_auth


def _install_self_review_suppression(swival_config):
    original_apply = _required_callable(swival_config, "apply_config_to_args")
    if getattr(original_apply, "_pi_swival_no_self_review", False):
        return

    def _apply_without_self_review(args, config):
        # Preserve an explicit CLI choice, including argparse abbreviations
        # and Swival invoked by a reviewer child.
        explicit_self_review = getattr(args, "self_review", None) is True
        result = original_apply(args, config)
        if not explicit_self_review:
            args.self_review = False
        return result

    _apply_without_self_review._pi_swival_no_self_review = True
    swival_config.apply_config_to_args = _apply_without_self_review


def _install_model_discovery_guard(anthropic_model_info, swival_agent):
    for name in ("get_models", "discover_models", "_list_models"):
        _required_callable(anthropic_model_info, name)
    orig_list_models = _required_callable(swival_agent, "_list_server_models")

    def _empty_models(self, *args, **kwargs):
        return []

    anthropic_model_info.get_models = _empty_models
    anthropic_model_info.discover_models = _empty_models
    anthropic_model_info._list_models = _empty_models
    if not getattr(orig_list_models, "_pi_swival_anthropic_guarded", False):
        def _guarded_list_server_models(litellm_provider, *args, **kwargs):
            if litellm_provider in ("anthropic", "bedrock", "vertex_ai"):
                return []
            return orig_list_models(litellm_provider, *args, **kwargs)

        _guarded_list_server_models._pi_swival_anthropic_guarded = True
        swival_agent._list_server_models = _guarded_list_server_models
    if swival_agent._list_server_models("anthropic", None, None) != []:
        raise RuntimeError(f"{SHIM_INSTALL_FAILED_SENTINEL}: model discovery remains active")


def _install_oauth_completion_shim(litellm):
    orig_completion = _required_callable(litellm, "completion")
    if getattr(orig_completion, "_pi_swival_anthropic_oauth", False) is True:
        return

    def _wrapped_completion(*args, **kwargs):
        api_key = kwargs.get("api_key")
        model = kwargs.get("model")
        if (
            isinstance(model, str)
            and model.startswith("anthropic/")
            and isinstance(api_key, str)
            and api_key.startswith("sk-ant-oat")
        ):
            raw_headers = kwargs.get("extra_headers") or {}
            headers = {
                k: v
                for k, v in raw_headers.items()
                if k.lower() not in ("user-agent", "anthropic-beta", "x-app")
            }
            existing_beta = next(
                (v for k, v in raw_headers.items() if k.lower() == "anthropic-beta"),
                "",
            )
            beta_items = [
                item.strip()
                for item in (existing_beta or "").split(",")
                if item.strip()
            ]
            for req in REQUIRED_OAUTH_BETAS:
                if req not in beta_items:
                    beta_items.append(req)
            headers["anthropic-beta"] = ",".join(beta_items)
            headers["User-Agent"] = CLAUDE_CODE_USER_AGENT
            headers["x-app"] = "cli"
            kwargs["extra_headers"] = headers

            orig_msgs = list(kwargs.get("messages") or [])
            if not orig_msgs or orig_msgs[0].get("role") != "system":
                orig_msgs.insert(
                    0,
                    {
                        "role": "system",
                        "content": [{"type": "text", "text": CLAUDE_CODE_SYSTEM_PREFIX}],
                    },
                )
            else:
                sys_msg = dict(orig_msgs[0])
                content = sys_msg.get("content")
                if isinstance(content, str):
                    if content != CLAUDE_CODE_SYSTEM_PREFIX:
                        sys_msg["content"] = [
                            {"type": "text", "text": CLAUDE_CODE_SYSTEM_PREFIX},
                            *(
                                [{"type": "text", "text": content}]
                                if content
                                else []
                            ),
                        ]
                elif isinstance(content, list):
                    first = content[0] if content else None
                    if not (
                        isinstance(first, dict)
                        and first.get("text") == CLAUDE_CODE_SYSTEM_PREFIX
                    ):
                        sys_msg["content"] = [
                            {"type": "text", "text": CLAUDE_CODE_SYSTEM_PREFIX},
                            *content,
                        ]
                orig_msgs[0] = sys_msg
            kwargs["messages"] = orig_msgs
        try:
            return orig_completion(*args, **kwargs)
        except litellm.AuthenticationError:
            if (
                isinstance(model, str)
                and model.startswith("vertex_ai/")
                and os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "").strip()
            ):
                _emit_credential_expired()
            raise

    _wrapped_completion._pi_swival_anthropic_oauth = True
    litellm.completion = _wrapped_completion


def install_required_shim(*, require_hooks: bool = False) -> dict[str, bool]:
    """Install the route-identity hooks and return their attestation.

    Every required upstream target must exist and be callable before it is
    wrapped. With ``require_hooks`` any missing target (or a non-Swival
    interpreter) raises ``RuntimeError``; otherwise failures stay silent.
    Installation is idempotent.
    """
    attestation = dict.fromkeys(SHIM_ATTESTATION, False)
    SHIM_ATTESTATION.update(attestation)
    if importlib.util.find_spec("swival") is None:
        if require_hooks:
            raise RuntimeError(f"{SHIM_INSTALL_FAILED_SENTINEL}: swival is not importable")
        return attestation
    suppress_self_review = os.environ.get("PI_SWIVAL_NO_SELF_REVIEW") == "1"
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    try:
        import litellm
        from litellm.llms.anthropic.common_utils import AnthropicModelInfo
        from litellm.llms.vertex_ai.vertex_llm_base import VertexBase
        from swival import agent as swival_agent
        if suppress_self_review:
            from swival import config as swival_config
            _install_self_review_suppression(swival_config)
            attestation["self_review_suppressed"] = True
        _install_vertex_bearer_shim(VertexBase)
        attestation["vertex_bearer"] = True
        _install_model_discovery_guard(AnthropicModelInfo, swival_agent)
        attestation["model_discovery_disabled"] = True
        _install_oauth_completion_shim(litellm)
        attestation["oauth_headers"] = True
    except Exception as exc:
        SHIM_ATTESTATION.update(dict.fromkeys(SHIM_ATTESTATION, False))
        if require_hooks:
            raise RuntimeError(SHIM_INSTALL_FAILED_SENTINEL) from exc
        return dict.fromkeys(SHIM_ATTESTATION, False)
    _backfill_model_map(litellm)
    SHIM_ATTESTATION.update(attestation)
    return attestation


def _install_agentfs_evidence_grant():
    """Grant scratch writes at the OS boundary, not in Swival's tool roots."""
    raw = os.environ.get("PI_SWIVAL_EVIDENCE_DIR", "").strip()
    if not raw:
        return
    if Path(raw).is_symlink() or not Path(raw).is_dir():
        raise RuntimeError("Invalid AgentFS evidence directory")
    from swival import sandbox_agentfs
    original = sandbox_agentfs.build_agentfs_argv
    if not callable(original):
        raise RuntimeError("AgentFS argv builder is unavailable")
    if getattr(original, "_pi_swival_evidence_grant", False):
        return
    evidence_dir = str(Path(raw).resolve())

    def _with_evidence_grant(**kwargs):
        argv = original(**kwargs)
        boundary = argv.index("--")
        if not any(argv[i:i + 2] == ["--allow", evidence_dir] for i in range(boundary - 1)):
            argv[boundary:boundary] = ["--allow", evidence_dir]
        return argv

    _with_evidence_grant._pi_swival_evidence_grant = True
    sandbox_agentfs.build_agentfs_argv = _with_evidence_grant


def _install_anthropic_shim():
    """Interpreter-startup entry: mandatory in native and OAuth-bridged Swival children.

    Tool/reviewer children inherit PYTHONPATH but may use a different Python;
    an interpreter without Swival installs nothing and stays silent.
    """
    if importlib.util.find_spec("swival") is None:
        return
    shim_required = (
        os.environ.get("PI_SWIVAL_SHIM_REQUIRED") == "1"
        or os.environ.get("PI_SWIVAL_NO_SELF_REVIEW") == "1"
        or bool(os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "").strip())
    )
    if os.environ.get("PI_SWIVAL_EVIDENCE_DIR", "").strip():
        try:
            _install_agentfs_evidence_grant()
        except Exception as exc:
            raise SystemExit("PI_SWIVAL_SHIM_INSTALL_FAILED") from exc
        if not (shim_required or os.environ.get("ANTHROPIC_API_KEY", "").startswith("sk-ant-oat")
                or os.environ.get("ANTHROPIC_OAUTH_TOKEN", "").strip()):
            return
    try:
        install_required_shim(require_hooks=shim_required)
    except Exception as exc:
        raise SystemExit(SHIM_INSTALL_FAILED_SENTINEL) from exc


_install_anthropic_shim()
