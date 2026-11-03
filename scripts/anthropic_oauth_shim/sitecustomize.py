"""Startup compatibility shim for Anthropic OAuth tokens in Swival/LiteLLM.

Loaded via PYTHONPATH when Swival runs with provider="anthropic".
1. Disables dynamic /v1/models lookup on AnthropicModelInfo and Swival's
   _list_server_models so NotFoundError cannot trigger singleton model
   replacement.
2. Injects the required Claude Code OAuth headers and leading system block
   when an Anthropic OAuth token (sk-ant-oat...) is used.
"""
# pylint: disable=import-outside-toplevel,broad-exception-caught,protected-access

CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.280"
REQUIRED_OAUTH_BETAS = ("claude-code-20250219", "oauth-2025-04-20")


def _install_anthropic_shim():
    try:
        import litellm
        from litellm.llms.anthropic.common_utils import AnthropicModelInfo
    except Exception:
        return

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
