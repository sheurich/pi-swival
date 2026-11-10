"""Startup compatibility shim for Anthropic OAuth tokens in Swival/LiteLLM.

Loaded via PYTHONPATH when Swival runs with provider="anthropic".
1. Disables dynamic /v1/models lookup on AnthropicModelInfo and Swival's
   _list_server_models so NotFoundError cannot trigger singleton model
   replacement.
2. Injects the required Claude Code OAuth headers and leading system block
   when an Anthropic OAuth token (sk-ant-oat...) is used.
3. Backfills LiteLLM model-map entries for Anthropic models newer than the
   pinned LiteLLM release, so reasoning effort is sent instead of dropped.
"""
# pylint: disable=import-outside-toplevel,broad-exception-caught,protected-access

CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.290"
REQUIRED_OAUTH_BETAS = ("claude-code-20250219", "oauth-2025-04-20")

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


def _backfill_model_map(litellm):
    for model, (sibling, rates) in MODEL_MAP_BACKFILL.items():
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
        try:
            litellm.register_model({model: entry})
        except Exception:
            pass


def _install_anthropic_shim():
    try:
        import litellm
        from litellm.llms.anthropic.common_utils import AnthropicModelInfo
    except Exception:
        return

    _backfill_model_map(litellm)

    empty_models = lambda self, *args, **kwargs: []
    AnthropicModelInfo.get_models = empty_models
    AnthropicModelInfo.discover_models = empty_models
    AnthropicModelInfo._list_models = empty_models

    try:
        from swival import agent as swival_agent
        orig_list_models = getattr(swival_agent, "_list_server_models", None)
        if callable(orig_list_models) and not getattr(
            orig_list_models, "_pi_swival_anthropic_guarded", False
        ):
            def _guarded_list_server_models(litellm_provider, *args, **kwargs):
                if litellm_provider == "anthropic":
                    return []
                return orig_list_models(litellm_provider, *args, **kwargs)

            _guarded_list_server_models._pi_swival_anthropic_guarded = True
            swival_agent._list_server_models = _guarded_list_server_models
    except Exception:
        pass

    orig_completion = litellm.completion
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
        return orig_completion(*args, **kwargs)

    _wrapped_completion._pi_swival_anthropic_oauth = True
    litellm.completion = _wrapped_completion


_install_anthropic_shim()
