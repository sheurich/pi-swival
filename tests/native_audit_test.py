"""Offline tests against released Swival entry points; every LLM call is stubbed."""
# Release-pinned private entry points are intentional compatibility assertions.
# Keep released multi-phase fixtures and transport regressions in one module.
# pylint: disable=protected-access,missing-function-docstring,too-many-lines

import contextlib
from datetime import datetime, timezone
import importlib.util
import inspect
import json
import os
import shutil
from pathlib import Path
import socket
import subprocess
import sys
import sysconfig
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
# Initialize host Python metadata before tests simulate the supported Linux path.
sysconfig.get_config_vars()
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
with patch.object(socket, "socket", side_effect=AssertionError("network forbidden")), \
     patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")), \
     patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS forbidden")):
    from swival import audit, agent
    from swival.session import Session
    from swival.worktree import make_isolated_loop_kwargs

SPEC = importlib.util.spec_from_file_location(
    "native_audit", Path(__file__).resolve().parents[1] / "scripts" / "native_audit.py"
)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def expansion_response(phase, text, messages, expansion, failed_attempts):
    """Stub expansion outcomes while leaving native parsing and retries intact."""
    if phase == "finding" and expansion in ("lost", "out-of-scope"):
        text += ("\n@@ finding @@\ntitle: Second inventory finding\n"
                 "severity: high\nlocation: code.py:3\n"
                 "attacker: another caller\ntrigger: another non-admin role\n"
                 "impact: role access control fails open\nclaim: second inventory claim")
    if phase == "expansion":
        second = "Title: Second inventory finding" in messages[-1]["content"]
        if ((expansion == "lost" and second)
                or (expansion == "recovered" and not failed_attempts)):
            failed_attempts.append(True)
            raise RuntimeError("private expansion diagnostic must not enter evidence")
        if expansion == "out-of-scope" and second:
            text = text.replace("type: security_control_failure", "type: out-of-scope")
    return text


# This release-pinned fixture keeps transport guards and phase assertions together.
# pylint: disable-next=too-many-public-methods
class NativeEntryTests(unittest.TestCase):
    """Exercise native dispatch and inherited isolation without transport."""

    def setUp(self):
        # These are API/transport tests, not an assertion of Darwin kernel isolation.
        self.enterContext(patch.object(sys, "platform", "linux"))
        self.enterContext(patch.object(bridge, "check_boundary"))
        # SDK/artifact boundary mock only. Dedicated identity tests exercise the
        # production validator; this released-pipeline fixture is not live trust proof.
        self.enterContext(patch.object(
            bridge, "_revalidate_nono",
            side_effect=lambda request, **_kwargs: request["nonoIdentity"],
        ))
        self.enterContext(patch.object(
            bridge, "_revalidate_nono_profile", return_value={"pack": "/trusted/profile"}))
        # unittest owns the context lifetime through enterContext.
        self.root = Path(self.enterContext(
            tempfile.TemporaryDirectory(prefix="offline-native-")  # pylint: disable=consider-using-with
        ))
        self.repo = self.root / "snapshot"
        self.evidence = self.root / "evidence"
        self.repo.mkdir()
        self.evidence.mkdir()
        self.enterContext(patch.dict(os.environ, {
            "PATH": os.environ["PATH"], "HOME": str(self.root),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
        }, clear=True))
        for name in ("socket", "create_connection", "getaddrinfo"):
            self.enterContext(patch.object(socket, name,
                                          side_effect=AssertionError("provider/network forbidden")))
        for args in (["init", "--template="], ["config", "user.name", "Test"],
                     ["config", "user.email", "test@example.invalid"]):
            self.git(*args)
        (self.repo / "code.py").write_text("def answer(): return 42\n")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")

    def git(self, *args):
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c",
                               "commit.gpgsign=false", *args], cwd=self.repo,
                              capture_output=True, check=True, timeout=5).stdout.decode().strip()

    def request(self):
        config = self.root / "config"
        pack = config / "nono" / "packages" / "jedisct1" / "swival"
        profile_identity = {
            "config": str(config), "pack": str(pack),
            "manifest": {"path": str(pack / "package.json"),
                         **bridge.NONO_PROFILE_ARTIFACT_IDENTITIES["manifest"]},
            "profile": {"path": str(pack / "profiles" / "swival.json"),
                        **bridge.NONO_PROFILE_ARTIFACT_IDENTITIES["profile"]},
            # Explicit unit-boundary mock; live validation is covered separately.
            "defaultPolicy": {
                "name": "default",
                "source": "authenticated-nono-0.79.0-embedded-policy",
                "extends": [],
                "nonoSha256": bridge.NONO_ARTIFACT_IDENTITY["sha256"],
            },
        }
        request = {"source": str(self.repo), "snapshot": str(self.repo),
                   "evidence": str(self.evidence),
                   "routing": {"provider": "lmstudio", "model": "offline-model",
                               "reasoningEffort": "xhigh"},
                   "sandbox": "bubblewrap", "bwrapVersion": "0.12.0",
                   "bwrapIdentity": dict(bridge.BWRAP_IDENTITY),
                   "unshareIdentity": dict(bridge.UNSHARE_IDENTITY),
                   "nono": "/trusted/nono",
                   "nonoIdentity": {"path": "/trusted/nono",
                                    **bridge.NONO_ARTIFACT_IDENTITY},
                   "nonoProfileIdentity": profile_identity,
                   "sessionSandbox": "builtin",
                   "audit": {"paths": [], "all": True, "workers": 1, "patchMaxTurns": 5},
                   "expectedScope": audit._resolve_scope(str(self.repo), []).to_dict()}
        _, request["expectedRoute"] = bridge.resolve_native_config(request)
        return request

    def test_route_drift_is_rejected_before_session_construction(self):
        config_dir = self.root / "config" / "swival"
        config_dir.mkdir(parents=True)
        config = config_dir / "config.toml"
        for field, changed in (("model", 'model="offline-B"'),
                               ("base_url", 'base_url="http://route-b.invalid"'),
                               ("temperature", "temperature=0.25")):
            with self.subTest(field=field):
                config.write_text('[profiles.test]\nprovider="lmstudio"\n'
                                  'model="offline-A"\nbase_url="http://route-a.invalid"\n')
                request = self.request()
                request["routing"] = {"profile": "test"}
                _, request["expectedRoute"] = bridge.resolve_native_config(request)
                lines = config.read_text().splitlines()
                config.write_text("\n".join(line for line in lines
                                            if not line.startswith(field + "=")) + "\n" + changed)
                with patch("swival.session.Session") as session:
                    with self.assertRaisesRegex(bridge.NativeAuditError, "route.*changed"):
                        bridge.run_native(request)
                    session.assert_not_called()

    def test_nono_identity_is_revalidated_immediately_before_session_construction(self):
        request = self.request()
        reached = []

        def revalidate(actual, **kwargs):
            self.assertIs(actual, request)
            self.assertEqual(kwargs, {"host_path": False})
            reached.append("nono")
            return actual["nonoIdentity"]

        def construct(**_kwargs):
            self.assertEqual(reached, ["nono"])
            reached.append("session")
            raise AssertionError("synthetic Session stop")

        with patch.object(bridge, "_revalidate_nono", side_effect=revalidate), \
             patch("swival.session.Session", side_effect=construct):
            with self.assertRaisesRegex(AssertionError, "Session stop"):
                bridge.run_native(request)
        self.assertEqual(reached, ["nono", "session"])

    def test_native_route_binding_materializes_safe_defaults_without_provider(self):
        request = self.request()
        with patch.object(agent, "resolve_provider",
                          side_effect=AssertionError("preflight must not resolve providers")):
            settings, route = bridge.resolve_native_config(request)
        self.assertEqual(route["transportModel"], "openai/offline-model")
        self.assertEqual(route["destination"]["apiBase"], "http://127.0.0.1:1234/v1")
        self.assertEqual(route["options"]["max_turns"], 100)
        self.assertEqual(route["options"]["max_output_tokens"], 32768)
        self.assertEqual(route["options"]["provider_timeout"], 900)
        self.assertEqual(settings["base_url"], "http://127.0.0.1:1234")

    def test_clean_config_daybreak_override_reaches_released_transport(self):
        request = self.request()
        request["routing"] = {"provider": "chatgpt", "model": "gpt-daybreak-blue-latest",
                              "reasoningEffort": "xhigh"}
        clean_environment = {
            "HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "config"),
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
        }
        with patch.dict(os.environ, clean_environment, clear=True), \
             patch.object(agent, "resolve_provider",
                          side_effect=AssertionError("preflight must not resolve providers")):
            settings, route = bridge.resolve_native_config(request)
            self.assertEqual(route["provider"], "chatgpt")
            self.assertEqual(route["model"], "gpt-daybreak-blue-latest")
            self.assertEqual(route["transportModel"], "chatgpt/gpt-daybreak-blue-latest")
            self.assertEqual(route["reasoningEffort"], "xhigh")
            self.assertIsNone(route["profile"])
            self.assertEqual(route["destination"]["apiBase"],
                             "https://chatgpt.com/backend-api/codex")
            self.assertEqual(self.released_chatgpt_selection(settings, route),
                             route["destination"]["apiBase"])
        self.assertFalse((self.root / "config" / "swival" / "config.toml").exists())

    def test_sensitive_route_inputs_never_enter_binding_or_diagnostics(self):
        config_dir = self.root / "config" / "swival"
        config_dir.mkdir(parents=True)
        config = config_dir / "config.toml"
        request = self.request()
        private = "synthetic-never-log-this"
        for unsafe in (f'base_url="https://user:{private}@route.invalid/v1"',
                       f'base_url="https://route.invalid/v1?token={private}"',
                       f'base_url="https://route.invalid/v1#{private}"',
                       f'extra_body={{tenant="{private}"}}'):
            with self.subTest(unsafe=unsafe):
                config.write_text('provider="lmstudio"\nmodel="offline-model"\n' + unsafe)
                with self.assertRaises(bridge.NativeAuditError) as error:
                    bridge.resolve_native_config(request)
                self.assertNotIn(private, str(error.exception))
        config.write_text(f'api_key="{private}"\nuser_agent="{private}"\n')
        settings, route = bridge.resolve_native_config(request)
        self.assertEqual(settings["api_key"], private)
        self.assertEqual(settings["user_agent"], private)
        self.assertNotIn(private, json.dumps(route))

    def test_safe_route_binding_matches_released_transport_models_and_endpoints(self):
        import litellm  # pylint: disable=import-outside-toplevel

        routes = [
            {"provider": "lmstudio", "model": "offline-model"},
            {"provider": "generic", "model": "offline/model",
             "base_url": "http://route.invalid/api"},
            {"provider": "openrouter", "model": "openrouter/openrouter/auto"},
            {"provider": "chatgpt", "model": "chatgpt/chatgpt/gpt-offline"},
            {"provider": "huggingface", "model": "huggingface/offline/model"},
            {"provider": "bedrock", "model": "bedrock/amazon.offline", "base_url": "us-west-2",
             "aws_profile": "offline-profile"},
            {"provider": "vertexai", "model": "gemini-offline", "project": "offline-project",
             "location": "us-central1"},
        ]
        for settings in routes:
            with self.subTest(provider=settings["provider"]):
                route = bridge._route_binding(settings, "offline-profile")
                provider = "geap" if settings["provider"] == "vertexai" else settings["provider"]
                self.assertEqual(route["transportModel"],
                                 agent._resolve_model_str(provider, settings["model"]))
                response = litellm.ModelResponse(choices=[{
                    "message": {"role": "assistant", "content": "synthetic"},
                    "finish_reason": "stop"}])
                with patch.object(litellm, "completion", return_value=response) as transport:
                    with bridge._bound_transport(route):
                        agent.call_llm(settings["base_url"], settings["model"],
                                       [{"role": "user", "content": "synthetic"}],
                                       100, None, None, None, None, False, provider=provider,
                                       aws_profile=settings.get("aws_profile"),
                                       vertex_project=settings.get("project"),
                                       vertex_location=settings.get("location"))
                    self.assertEqual(transport.call_count, 1)
                    self.assertEqual(transport.call_args.kwargs.get("api_base"),
                                     route["destination"]["apiBase"])

    def test_bound_endpoints_match_released_pure_resolvers_without_credential_reads(self):
        # These methods do not initialize provider/auth objects. Never call their
        # constructors: ChatGPT's constructor opens its runtime token directory.
        # pylint: disable=import-outside-toplevel
        from litellm.llms.bedrock.base_aws_llm import BaseAWSLLM
        from litellm.llms.chatgpt.authenticator import Authenticator
        from litellm.llms.chatgpt.responses.transformation import ChatGPTResponsesAPIConfig
        from litellm.llms.huggingface.chat.transformation import HuggingFaceChatConfig
        from litellm.llms.vertex_ai.common_utils import get_vertex_base_url

        with patch.dict(os.environ, {}, clear=True):
            settings = {"provider": "chatgpt", "model": "gpt-offline"}
            route = bridge._route_binding(settings, None)
            self.assertEqual(route["destination"]["apiBase"], Authenticator.get_api_base(None))
            self.assertEqual(ChatGPTResponsesAPIConfig.get_complete_url(
                None, settings["base_url"], {}), route["destination"]["apiBase"] + "/responses")
            settings = {"provider": "huggingface", "model": "offline/model"}
            route = bridge._route_binding(settings, None)
            self.assertEqual(HuggingFaceChatConfig.get_complete_url(
                None, None, None, "offline/model", {}, {}), route["destination"]["apiBase"])
            for region in ("us-west-2", "us-gov-west-1", "cn-north-1"):
                route = bridge._route_binding({"provider": "bedrock", "model": "amazon.offline",
                                               "base_url": region}, None)
                # Bypass the credential-cache constructor; only pure endpoint
                # selection runs, with an explicit region and an empty environment.
                resolver = object.__new__(BaseAWSLLM)
                actual, proxy = resolver.get_runtime_endpoint(None, None, region)
                self.assertEqual((actual, proxy), (route["destination"]["endpoint"],) * 2)
            for location in ("global", "us", "us-central1"):
                route = bridge._route_binding({"provider": "vertexai", "model": "gemini-offline",
                                               "project": "offline-project",
                                               "location": location}, None)
                self.assertEqual(get_vertex_base_url(location), route["destination"]["endpoint"])

    def test_endpoint_environment_drift_changes_the_effective_binding(self):
        for provider, model, variable in (
                ("chatgpt", "gpt-offline", "CHATGPT_API_BASE"),
                ("chatgpt", "gpt-offline", "OPENAI_CHATGPT_API_BASE"),
                ("openrouter", "offline/model", "OPENROUTER_API_BASE"),
                ("huggingface", "offline/model", "HF_API_BASE"),
                ("huggingface", "offline/model", "HUGGINGFACE_API_BASE")):
            with self.subTest(variable=variable), patch.dict(os.environ, {}, clear=True):
                with patch.dict(os.environ, {variable: "https://route-a.invalid/api"}):
                    first = bridge._route_binding({"provider": provider, "model": model}, None)
                with patch.dict(os.environ, {variable: "https://route-b.invalid/api"}):
                    second = bridge._route_binding({"provider": provider, "model": model}, None)
                self.assertNotEqual(first, second)
                self.assertNotEqual(first["destination"], second["destination"])

    def test_native_route_runtime_gate_rejects_unverified_litellm_before_session(self):
        request = self.request()
        version = bridge.importlib.metadata.version
        with patch.object(bridge.importlib.metadata, "version", side_effect=lambda name:
                          "0.0.0" if name == "litellm" else version(name)), \
             patch("swival.session.Session") as session:
            with self.assertRaisesRegex(bridge.NativeAuditError, "Unsupported native runtime"):
                bridge.run_native(request)
            session.assert_not_called()

    def test_native_route_binding_rejects_unrepresentable_cloud_and_model_defaults(self):
        for settings in (
                {"provider": "bedrock", "model": "amazon.offline"},
                {"provider": "bedrock", "model": "amazon.offline",
                 "base_url": "https://bedrock.invalid"},
                {"provider": "vertexai", "model": "offline-model", "location": "us-central1"},
                {"provider": "chatgpt", "model": "unverified-chat-mode"},
                {"provider": "huggingface", "model": "dynamic-provider/offline/model"}):
            with self.subTest(settings=settings), self.assertRaises(bridge.NativeAuditError):
                bridge._route_binding(settings, None)

    def test_native_route_rejects_hidden_proxy_and_alternate_bedrock_endpoint_routes(self):
        import litellm  # pylint: disable=import-outside-toplevel

        request = self.request()
        with patch.dict(os.environ, {"USE_LITELLM_PROXY": "true"}):
            with self.assertRaisesRegex(bridge.NativeAuditError, "proxy"):
                bridge.resolve_native_config(request)
        proxy_names = ("USE_LITELLM_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy",
                       "https_proxy", "all_proxy", "hTtP_pRoXy", "hTtPs_PrOxY", "aLl_PrOxY")
        for name in proxy_names:
            for value in ("", "http://synthetic-proxy.invalid"):
                with self.subTest(name=name, value=bool(value)), \
                     patch.dict(os.environ, {name: value}), \
                     patch("swival.session.Session") as session, \
                     patch.object(litellm, "completion") as transport:
                    with self.assertRaisesRegex(bridge.NativeAuditError,
                                                "Unsupported native transport proxy requirements"):
                        bridge.run_native(request)
                    session.assert_not_called()
                    transport.assert_not_called()
        for prefix in ("mantle", "agent", "agentcore", "claude_platform", "openai"):
            with self.subTest(prefix=prefix), self.assertRaises(bridge.NativeAuditError):
                bridge._route_binding({"provider": "bedrock", "model": prefix + "/offline-model",
                                       "base_url": "us-west-2"}, None)

    def released_chatgpt_selection(self, settings, route):
        """Run the real resolver up to Responses selection, before auth/transport."""
        # pylint: disable=import-outside-toplevel
        import litellm
        from litellm import main
        from litellm.llms.chatgpt.authenticator import Authenticator
        from litellm.llms.chatgpt.chat.transformation import ChatGPTConfig

        class StopSelection(BaseException):
            """Never enter Responses initialization, authentication, or HTTP."""

        selected = {}

        def capture(**kwargs):
            selected["api_base"] = kwargs["api_base"]
            raise StopSelection()

        def stub_auth(config, *_args, **_kwargs):
            config.authenticator = SimpleNamespace(
                get_api_base=lambda: Authenticator.get_api_base(None),
                get_access_token=lambda: "synthetic")

        with patch.object(ChatGPTConfig, "__init__", stub_auth), \
             patch.object(main, "responses_api_bridge_check", side_effect=capture), \
             patch.object(litellm, "completion", inspect.unwrap(litellm.completion)):
            original = litellm.completion
            with self.assertRaises(StopSelection), bridge._bound_transport(route):
                litellm.completion(model=route["transportModel"], api_base=settings["base_url"],
                                   messages=[{"role": "user", "content": "synthetic fixture"}])
            self.assertIs(litellm.completion, original)
        return selected["api_base"]

    def test_chatgpt_configured_endpoint_cannot_override_released_resolver(self):
        request = self.request()
        config = self.root / "config" / "swival" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text('provider="chatgpt"\nmodel="gpt-offline"\n'
                          'base_url="https://route-config.invalid/api"\n')
        request["routing"] = {}
        with patch.dict(os.environ, {"CHATGPT_API_BASE": "https://route-env.invalid/api"}), \
             patch("swival.session.Session") as session:
            with self.assertRaisesRegex(bridge.NativeAuditError, "ChatGPT.*endpoint"):
                bridge.resolve_native_config(request)
            with self.assertRaisesRegex(bridge.NativeAuditError, "ChatGPT.*endpoint"):
                bridge.run_native(request)
            session.assert_not_called()

    def test_chatgpt_downstream_endpoint_matches_binding_and_restores_hooks(self):
        for environment, endpoint in (
                ({}, "https://chatgpt.com/backend-api/codex"),
                ({"OPENAI_CHATGPT_API_BASE": "https://route-legacy.invalid/api"},
                 "https://route-legacy.invalid/api"),
                ({"CHATGPT_API_BASE": "https://route-primary.invalid/api/",
                  "OPENAI_CHATGPT_API_BASE": "https://route-legacy.invalid/api"},
                 "https://route-primary.invalid/api/")):
            with self.subTest(endpoint=endpoint), patch.dict(os.environ,
                    {"LITELLM_LOCAL_MODEL_COST_MAP": "True", **environment}, clear=True):
                settings = {"provider": "chatgpt", "model": "chatgpt/gpt-offline",
                            "base_url": endpoint}
                route = bridge._route_binding(settings, "offline-profile")
                self.assertEqual(self.released_chatgpt_selection(settings, route),
                                 route["destination"]["apiBase"])
                self.assertEqual(route["destination"]["apiBase"], endpoint)

    def test_chatgpt_guard_blocks_downstream_environment_drift(self):
        import litellm  # pylint: disable=import-outside-toplevel

        with patch.dict(os.environ, {"CHATGPT_API_BASE": "https://route-a.invalid/api"}):
            settings = {"provider": "chatgpt", "model": "gpt-offline"}
            route = bridge._route_binding(settings, None)
            with patch.object(litellm, "completion") as transport:
                with self.assertRaisesRegex(bridge.NativeAuditError, "route guard failed"):
                    with bridge._bound_transport(route):
                        with patch.dict(os.environ, {
                                "CHATGPT_API_BASE": "https://route-b.invalid/api"}):
                            with self.assertRaisesRegex(bridge.NativeAuditError,
                                                        "ChatGPT.*changed"):
                                litellm.completion(model=route["transportModel"],
                                                   api_base=settings["base_url"])
                        with self.assertRaisesRegex(bridge.NativeAuditError,
                                                    "no further transport"):
                            litellm.completion(model=route["transportModel"],
                                               api_base=settings["base_url"])
                self.assertIs(litellm.completion, transport)
                transport.assert_not_called()

    def test_vertex_released_endpoint_defaults_reject_ambient_overrides(self):
        # pylint: disable=import-outside-toplevel,too-many-locals
        import litellm
        from litellm import main

        settings = {"provider": "vertexai", "model": "gemini-offline",
                    "project": "offline-project", "location": "us-central1"}
        with patch.dict(os.environ, {}, clear=True), patch.object(litellm, "api_base", None):
            route = bridge._route_binding(dict(settings), None)
            with patch.dict(os.environ, {"VERTEXAI_API_BASE": "https://ambient.invalid/api"}):
                with self.assertRaisesRegex(bridge.NativeAuditError, "Vertex.*endpoint"):
                    bridge._route_binding(dict(settings), None)
            for source in ("environment", "global"):
                with self.subTest(source=source), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(litellm, "completion"))
                    with self.assertRaisesRegex(bridge.NativeAuditError, "Vertex.*endpoint"):
                        with bridge._bound_transport(route):
                            if source == "environment":
                                stack.enter_context(patch.dict(os.environ, {
                                    "VERTEXAI_API_BASE": "https://ambient.invalid/api"}))
                            else:
                                stack.enter_context(patch.object(litellm, "api_base",
                                                                "https://ambient.invalid/api"))
                            litellm.completion(model=route["transportModel"], api_base=None,
                                               vertex_project=settings["project"],
                                               vertex_location=settings["location"])
            with patch.object(litellm, "api_base", "https://ambient.invalid/api"):
                with self.assertRaisesRegex(bridge.NativeAuditError, "Vertex.*endpoint"):
                    with bridge._bound_transport(route):
                        self.fail("A global override must fail before Session construction")
            settings["base_url"] = "https://configured.invalid/v1"
            with patch.dict(os.environ, {"VERTEXAI_API_BASE": "https://ambient.invalid/api"}), \
                 patch.object(litellm, "api_base", "https://global.invalid/api"):
                explicit = bridge._route_binding(settings, None)
                self.assertEqual(main.get_vertex_ai_model_route(settings["model"], {}),
                                 main.VertexAIModelRoute.GEMINI)
                ctx = SimpleNamespace(acompletion=False, api_base=settings["base_url"],
                    custom_llm_provider="vertex_ai", custom_prompt_dict={}, headers={},
                    litellm_params={}, logger_fn=None, logging=None, messages=[],
                    model=settings["model"], model_response=None, stream=False, timeout=1,
                    optional_params={"vertex_project": settings["project"],
                        "vertex_location": settings["location"], "vertex_credentials": "synthetic"})
                with patch.object(main, "_dispatch_client_http", return_value=None), \
                     patch.object(main, "_get_encoding", return_value=None), \
                     patch.object(main.vertex_chat_completion, "completion",
                                  return_value="stub") as sdk, \
                     patch.object(litellm, "completion", side_effect=lambda **_kw:
                                  main._complete_vertex_ai(ctx)):
                    with bridge._bound_transport(explicit):
                        litellm.completion(model=explicit["transportModel"],
                            api_base=settings["base_url"], vertex_project=settings["project"],
                            vertex_location=settings["location"])
                    self.assertEqual(sdk.call_args.kwargs["api_base"],
                                     explicit["destination"]["apiBase"])

    def test_vertex_unverified_dispatch_is_rejected_before_session(self):
        from litellm import main  # pylint: disable=import-outside-toplevel

        request = self.request()
        config = self.root / "config" / "swival" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text('provider="vertexai"\nproject="offline-project"\n'
                          'location="us-central1"\nbase_url="https://route-config.invalid/api"\n')
        for model in ("offline-model", "chat-bison", "claude-offline", "mistral-offline",
                      "bge-offline", "openai-offline", "1234567890"):
            with self.subTest(model=model), patch("swival.session.Session") as session:
                self.assertNotEqual(main.get_vertex_ai_model_route(model, {}),
                                    main.VertexAIModelRoute.GEMINI)
                request["routing"] = {"model": model}
                with self.assertRaisesRegex(bridge.NativeAuditError, "Vertex.*dispatch"):
                    bridge.resolve_native_config(request)
                with self.assertRaisesRegex(bridge.NativeAuditError, "Vertex.*dispatch"):
                    bridge.run_native(request)
                session.assert_not_called()

    def test_vertex_call_boundary_rejects_legacy_dispatch_and_latches_swallowed_errors(self):
        # pylint: disable=import-outside-toplevel
        import litellm
        from litellm import main

        settings = {"provider": "vertexai", "model": "gemini-offline",
                    "project": "offline-project", "location": "us-central1",
                    "base_url": "https://route-config.invalid/api"}
        route = bridge._route_binding(settings, None)
        ctx = SimpleNamespace(acompletion=False, api_base=settings["base_url"],
            custom_llm_provider="vertex_ai", custom_prompt_dict={}, headers={},
            litellm_params={}, logger_fn=None, logging=None, messages=[],
            model="offline-model", model_response=None, stream=False, timeout=1,
            optional_params={"vertex_project": settings["project"],
                "vertex_location": settings["location"], "vertex_credentials": "synthetic"})
        self.assertEqual(main.get_vertex_ai_model_route(ctx.model, {}),
                         main.VertexAIModelRoute.NON_GEMINI)
        with patch.object(main, "_dispatch_client_http", return_value=None), \
             patch.object(main, "_get_encoding", return_value=None), \
             patch.object(main.vertex_ai_non_gemini, "completion", return_value="stub") as sdk, \
             patch.object(litellm, "completion", side_effect=lambda **_kw:
                          main._complete_vertex_ai(ctx)) as transport:
            with self.assertRaisesRegex(bridge.NativeAuditError, "route guard failed"):
                with bridge._bound_transport(route):
                    # A stale binding can match completion arguments yet select
                    # the released legacy SDK. Check again on every transport.
                    route["model"] = ctx.model
                    route["transportModel"] = "vertex_ai/" + ctx.model
                    try:
                        litellm.completion(model=route["transportModel"],
                            api_base=settings["base_url"], vertex_project=settings["project"],
                            vertex_location=settings["location"])
                    except bridge.NativeAuditError:
                        pass
                    route["model"] = "gemini-offline"
                    route["transportModel"] = "vertex_ai/gemini-offline"
                    with self.assertRaisesRegex(bridge.NativeAuditError, "no further transport"):
                        litellm.completion(model=route["transportModel"],
                            api_base=settings["base_url"], vertex_project=settings["project"],
                            vertex_location=settings["location"])
            self.assertIs(litellm.completion, transport)
            transport.assert_not_called()
            sdk.assert_not_called()

    def test_vertex_cold_preflight_import_is_offline_and_restores_environment(self):
        config = self.root / "config" / "swival" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text('provider="vertexai"\nmodel="gemini-offline"\n'
                          'project="offline-project"\nlocation="us-central1"\n')
        # Test a cold whole preflight with Swival's documented flag side effect,
        # then cold LiteLLM imports after config import with synthetic flag resets.
        # Failed helper imports must restore absent/present values too.
        payload = r'''
import builtins
import importlib.util
import json
import os
from pathlib import Path
import sys

counts = {"network": 0, "dotenv": 0, "credentials": 0, "sdk_auth": 0}
def deny(kind):
    counts[kind] += 1
    raise AssertionError("Forbidden cold preflight access: " + kind)
def audit_event(event, args):
    if event.startswith("socket."):
        deny("network")
    if event == "open" and isinstance(args[0], (str, bytes)):
        name = os.fsdecode(args[0])
        if Path(name).name.startswith(".env"):
            deny("dotenv")
        if any(part in name for part in ("/.aws/", "/.ssh/", "/.gnupg/",
                                         "/.config/litellm/chatgpt/", "/.config/gcloud/")):
            deny("credentials")
def profile(frame, event, _arg):
    if event != "call":
        return
    module = frame.f_globals.get("__name__", "")
    name = frame.f_code.co_name
    if module.startswith("dotenv.") and name in ("load_dotenv", "find_dotenv", "dotenv_values"):
        deny("dotenv")
    if module == "litellm.llms.chatgpt.authenticator" and name == "__init__":
        deny("sdk_auth")
    if module.startswith(("google.auth", "google.oauth2")) and name in (
            "default", "load_credentials_from_file", "__init__"):
        deny("sdk_auth")
    if module.startswith(("vertexai.", "google.cloud.aiplatform")) and name == "__init__":
        deny("sdk_auth")
sys.addaudithook(audit_event)
sys.setprofile(profile)
assert "litellm" not in sys.modules
spec = importlib.util.spec_from_file_location("cold_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
flags = ("LITELLM_MODE", "LITELLM_LOCAL_MODEL_COST_MAP")
before = {name: os.environ.get(name) for name in flags}
if sys.argv[3] != "whole":
    # Swival has an existing offline-map setdefault. Keep the whole-process
    # proof separate, then reset only synthetic flags for helper restoration.
    from swival import config
    assert "litellm" not in sys.modules
    for name, value in before.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
original_import = builtins.__import__
blocked = []
if sys.argv[3] == "failure":
    def fail_import(name, *args, **kwargs):
        if name == "litellm.llms.vertex_ai.common_utils":
            assert os.environ["LITELLM_MODE"] == "PRODUCTION"
            assert os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] == "True"
            blocked.append(True)
            raise ImportError("synthetic metadata import failure")
        return original_import(name, *args, **kwargs)
    builtins.__import__ = fail_import
try:
    request = {"source": sys.argv[2], "routing": {}}
    if sys.argv[3] == "failure":
        try:
            bridge.resolve_native_config(request)
        except bridge.NativeAuditError:
            pass
        else:
            raise AssertionError("Import failure must reject preflight")
        assert blocked
    else:
        _, route = bridge.resolve_native_config(request)
        assert route["provider"] == "vertexai"
        from litellm.llms.vertex_ai.common_utils import get_vertex_ai_model_route, VertexAIModelRoute
        assert get_vertex_ai_model_route(route["model"], {}) == VertexAIModelRoute.GEMINI
    after = {name: os.environ.get(name) for name in flags}
    expected = dict(before)
    if sys.argv[3] == "whole":
        expected["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    assert after == expected, (expected, after)
    assert not any(counts.values()), counts
finally:
    builtins.__import__ = original_import
    sys.setprofile(None)
print(json.dumps({"cold": True, "restored": True, "denied_access_counts": counts}))
'''
        for import_mode, flags in (("whole", {}), ("success", {}),
                ("success", {"LITELLM_MODE": "DEV",
                "LITELLM_LOCAL_MODEL_COST_MAP": "false"}), ("failure", {}),
                ("failure", {"LITELLM_MODE": "DEV", "LITELLM_LOCAL_MODEL_COST_MAP": "false"})):
            with self.subTest(mode=import_mode, flags=flags):
                result = subprocess.run([sys.executable, "-I", "-B", "-c", payload,
                    str(Path(bridge.__file__).resolve()), str(self.repo), import_mode],
                    env={"PATH": os.environ["PATH"], "HOME": str(self.root),
                         "XDG_CONFIG_HOME": str(self.root / "config"), **flags},
                    cwd=self.repo, capture_output=True, timeout=15, check=False)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(json.loads(result.stdout)["denied_access_counts"],
                                 {"network": 0, "dotenv": 0, "credentials": 0, "sdk_auth": 0})

    def test_native_transport_blocks_huggingface_text_generation_fallback(self):
        # pylint: disable=import-outside-toplevel
        import huggingface_hub
        import litellm

        settings = {"provider": "huggingface", "model": "offline/model"}
        route = bridge._route_binding(settings, None)
        bad = litellm.BadRequestError("not a chat model", llm_provider="huggingface",
                                      model=route["transportModel"])
        with patch.object(litellm, "completion", side_effect=bad) as transport, \
             patch.object(agent, "_call_huggingface_text_generation",
                          wraps=agent._call_huggingface_text_generation) as fallback, \
             patch.object(huggingface_hub, "HfApi") as discovery, \
             patch.object(huggingface_hub, "InferenceClient") as sdk:
            sdk.return_value.text_generation.return_value = "synthetic response"
            with self.assertRaisesRegex(bridge.NativeAuditError, "HuggingFace.*fallback"):
                with bridge._bound_transport(route):
                    agent.call_llm(settings["base_url"], settings["model"],
                        [{"role": "user", "content": "synthetic fixture"}],
                        100, None, None, None, None, False, provider="huggingface", max_retries=1)
            self.assertEqual(transport.call_count, 1)
            self.assertIs(litellm.completion, transport)
            self.assertIs(agent._call_huggingface_text_generation, fallback)
            fallback.assert_not_called()
            discovery.assert_not_called()
            sdk.assert_not_called()

    def test_native_huggingface_fallback_violation_latches_swallowed_errors(self):
        # pylint: disable=import-outside-toplevel
        import huggingface_hub
        import litellm

        settings = {"provider": "huggingface", "model": "offline/model"}
        route = bridge._route_binding(settings, None)
        bad = litellm.BadRequestError("not a chat model", llm_provider="huggingface",
                                      model=route["transportModel"])
        with patch.object(litellm, "completion", side_effect=bad) as transport, \
             patch.object(huggingface_hub, "InferenceClient") as sdk:
            sdk.return_value.text_generation.return_value = "synthetic response"
            with self.assertRaisesRegex(bridge.NativeAuditError, "route guard failed"):
                with bridge._bound_transport(route):
                    try:
                        agent.call_llm(settings["base_url"], settings["model"],
                            [{"role": "user", "content": "synthetic fixture"}],
                            100, None, None, None, None, False,
                            provider="huggingface", max_retries=1)
                    except bridge.NativeAuditError:
                        pass
            self.assertIs(litellm.completion, transport)
            sdk.assert_not_called()

    def test_native_transport_guard_cannot_attest_swallowed_route_failures(self):
        import litellm  # pylint: disable=import-outside-toplevel

        _, route = bridge.resolve_native_config(self.request())
        with patch.object(litellm, "completion") as transport:
            with self.assertRaisesRegex(bridge.NativeAuditError, "route"):
                with bridge._bound_transport(route):
                    try:
                        litellm.completion(model="openai/alternate",
                                           api_base="http://drift.invalid")
                    except bridge.NativeAuditError:
                        pass
            transport.assert_not_called()

    def test_native_transport_blocks_vertex_location_replacement(self):
        import litellm  # pylint: disable=import-outside-toplevel

        route = bridge._route_binding({"provider": "vertexai", "model": "gemini-offline",
                                       "project": "offline-project",
                                       "location": "us-central1"}, None)
        with patch.dict(litellm.model_cost, {
                "vertex_ai/gemini-offline": {"supported_regions": ["europe-west1"]}}), \
             patch.object(litellm, "completion") as transport:
            with self.assertRaisesRegex(bridge.NativeAuditError, "location changed"):
                with bridge._bound_transport(route):
                    litellm.completion(model=route["transportModel"],
                                       vertex_project="offline-project",
                                       vertex_location="us-central1")
            transport.assert_not_called()

    def test_native_transport_blocks_not_found_discovery_and_replacement(self):
        import litellm  # pylint: disable=import-outside-toplevel

        settings, route = bridge.resolve_native_config(self.request())
        missing = litellm.NotFoundError("offline missing model", llm_provider="openai",
                                       model=route["transportModel"])
        with patch.object(litellm, "completion", side_effect=missing) as transport, \
             patch.object(agent, "_list_server_models", return_value=["alternate"]) as listing:
            with self.assertRaisesRegex(bridge.NativeAuditError, "discovery/replacement"):
                with bridge._bound_transport(route):
                    agent.call_llm(settings["base_url"], settings["model"],
                                   [{"role": "user", "content": "synthetic"}],
                                   100, None, None, None, None, False, max_retries=1)
            self.assertIs(litellm.completion, transport)
            self.assertIs(agent._list_server_models, listing)
            self.assertEqual(transport.call_count, 1)
            self.assertEqual(transport.call_args.kwargs["model"], route["transportModel"])
            listing.assert_not_called()

    def test_native_transport_rejects_cached_autofix_and_destination_drift(self):
        import litellm  # pylint: disable=import-outside-toplevel

        settings, route = bridge.resolve_native_config(self.request())
        key = (settings["base_url"], route["transportModel"])
        with patch.object(litellm, "completion") as transport:
            with self.assertRaisesRegex(Exception, "route changed"):
                with bridge._bound_transport(route), patch.dict(
                        agent._MODEL_AUTOFIX, {key: "openai/alternate"}):
                    agent.call_llm(settings["base_url"], settings["model"],
                                   [{"role": "user", "content": "synthetic"}],
                                   100, None, None, None, None, False, max_retries=1)
            with self.assertRaisesRegex(bridge.NativeAuditError, "destination changed"):
                with bridge._bound_transport(route):
                    litellm.completion(model=route["transportModel"],
                                       api_base="http://drift.invalid")
            transport.assert_not_called()

    def test_released_session_ask_native_pipeline_with_stubbed_llm_and_no_provider(self):
        self.assertTrue(callable(getattr(bridge, "run_native", None)))
        calls = []

        def call_llm(_api, model, messages, *_args, **kwargs):
            self.assertEqual(model, "offline-model")
            self.assertEqual(kwargs.get("provider"), "lmstudio")
            # Auxiliary phases preserve the model/provider, but omit effort.
            self.assertNotIn("reasoning_effort", kwargs)
            text = audit._PHASE1_WORKED_EXAMPLE if not calls else "@@ none @@"
            calls.append(messages)
            return {"role": "assistant", "content": text}, "stop", False, 0, None

        with patch.object(agent, "resolve_provider", return_value=(
            "offline-model", "http://offline.invalid", None, 128000, {"provider": "lmstudio"}
        )), patch.object(agent, "call_llm", side_effect=call_llm), patch(
            "swival.sandbox_nono.check_wrapper_available"
        ), patch("swival.sandbox_nono.build_block_net_wrapper", return_value=["offline-nono"]):
            result = bridge.run_native(self.request())
        self.assertEqual(result["status"], "completed", result)
        self.assertGreater(len(calls), 0)
        states = list((self.repo / ".swival" / "audit").glob("*/state.json"))
        self.assertEqual(len(states), 1)
        state = json.loads(states[0].read_text())
        self.assertEqual(state["phase"], "done")
        self.assertEqual(state["scope"]["commit"], self.git("rev-parse", "HEAD"))
        self.assertEqual(state["reviewed_files"], ["code.py"])
        self.assertEqual(state["deep_reviewed_files"], ["code.py"])
        self.assertEqual(result["requestedEffort"], "xhigh")
        self.assertFalse((self.evidence / "report.json").exists())

    # Keep the released finding-to-artifact sequence in one fixture.
    # pylint: disable-next=too-many-statements,too-many-locals
    def released_finding(self, report_response, export=None, expansion="complete",
                         commit_source=True, transport_guard=False):
        """Real released phases and edit_file with offline transport and OS stubs."""
        source = ('def authorize(role):\n'
                  '    """Role access-control decision: allow only admin."""\n'
                  '    return True\n')
        if commit_source:
            (self.repo / "code.py").write_text(source)
            self.git("add", "code.py")
            self.git("commit", "-m", "synthetic access-control fixture")
        before = self.git("show-ref")
        calls = []
        edits = []
        failed_attempts = []

        responses = {
            "You are preparing a compact repository profile": ("profile", (
                "@@ profile @@\nlanguage: python\n"
                "auth_surface: authorize role access-control decision\n"
                "summary: synthetic role access-control fixture")),
            "You are performing phase 2 security triage": ("triage", audit._PHASE2_WORKED_EXAMPLE),
            "You are performing phase 3 deep security review": ("finding", (
                "@@ finding @@\ntitle: Role authorization accepts non-admin\n"
                "severity: high\nlocation: code.py:3\n"
                "attacker: any caller of the role access-control decision\n"
                "trigger: non-admin role passed to authorize\n"
                "impact: role access control fails open and accepts non-admin roles\n"
                "claim: authorize returns True for every role")),
            "You are expanding one security finding": ("expansion", (
                "@@ expansion @@\ntype: security_control_failure\n"
                "attacker: any caller of the role access-control decision\n"
                "trigger: non-admin role passed to authorize\n"
                "impact: role access control fails open and accepts non-admin roles\n"
                "preconditions: caller invokes authorize\n"
                "proof: authorize implements the role access-control decision; "
                "code.py:3 unconditionally returns True for non-admin roles.\n"
                "fix_outline: return whether role equals admin")),
            "You are verifying one proposed security finding": ("verification", (
                "Source judgment: the role access-control decision fails open.\nREPRODUCED")),
            "You are adjudicating one already-reproduced": ("adjudication", (
                "@@ verdict @@\nverdict: real\nthreat_model_relevant: yes\n"
                "severity: high\nreason: the named role access-control decision "
                "unconditionally accepts non-admin roles")),
            "You are finalizing one security finding": ("ruling", (
                "@@ ruling @@\ntitle: Role authorization accepts non-admin\n"
                "type: security_control_failure\nseverity: high\n"
                "threat_model: the role access-control decision accepts roles "
                "its documented contract requires it to reject\n"
                "fix_outline: return whether role equals admin")),
            "You are fixing a security bug": ("patch", ""),
            "You are writing the final markdown report": ("report", report_response),
        }

        def call_llm(_api, model, messages, *_args, **kwargs):
            self.assertEqual(model, "offline-model")
            self.assertEqual(kwargs.get("provider"), "lmstudio")
            system = messages[0]["content"]
            # Agent loops inherit effort; plain auxiliary calls omit it.
            if system.startswith(("You are verifying", "You are fixing")):
                self.assertEqual(kwargs.get("reasoning_effort"), "xhigh")
            else:
                self.assertNotIn("reasoning_effort", kwargs)
            response = next((value for prefix, value in responses.items()
                             if system.startswith(prefix)), None)
            self.assertIsNotNone(response, "Unexpected LLM phase; no transport fallback")
            phase, text = response
            text = expansion_response(phase, text, messages, expansion, failed_attempts)
            if phase == "patch":
                tool_results = [m for m in messages if agent._msg_get(m, "role") == "tool"]
                if len(tool_results) < 2:
                    calls.append(phase)
                    name = "read_file" if not tool_results else "edit_file"
                    arguments = {"file_path": "code.py"}
                    if tool_results:
                        arguments.update(old_string="return True",
                                         new_string='return role == "admin"')
                    tool = SimpleNamespace(id=f"offline-role-{name}", type="function",
                                           function=SimpleNamespace(
                                               name=name, arguments=json.dumps(arguments)))
                    return (SimpleNamespace(role="assistant", content="", tool_calls=[tool]),
                            "tool_calls", False, 0, None)
                for message in tool_results:
                    self.assertNotIn("error:", message["content"].lower())
                    edits.append(message["content"])
                text = "Patch proposed in the isolated worktree."
            calls.append(phase)
            return (SimpleNamespace(role="assistant", content=text, tool_calls=None),
                    "stop", False, 0, None)

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(agent, "resolve_provider", return_value=(
                "offline-model", "http://127.0.0.1:1234", None, 128000, {"provider": "lmstudio"}
            )))
            if transport_guard:
                transport = self.stub_bound_completion(stack, call_llm)
            else:
                stack.enter_context(patch.object(agent, "call_llm", side_effect=call_llm))
            stack.enter_context(patch("swival.sandbox_nono.check_wrapper_available"))
            stack.enter_context(patch("swival.sandbox_nono.build_block_net_wrapper",
                                      return_value=["offline-nono"]))
            result = bridge.run_native(self.request())
            if transport_guard:
                self.assertIs(sys.modules["litellm"].completion, transport)
        if not export and commit_source:
            self.assertEqual(result["status"],
                             "partial" if expansion == "lost" else "completed", result)
            self.assertEqual(result.get("unrecoveredExpansionFailures", 0),
                             1 if expansion == "lost" else 0)
        self.assertNotIn("private expansion diagnostic", json.dumps(result))
        states = list((self.repo / ".swival" / "audit").glob("*/state.json"))
        self.assertEqual(len(states), 1)
        state = json.loads(states[0].read_text())
        self.assertEqual(state["phase"], "done", state["verification_state"])
        self.assertEqual(len(state["verified_findings"]), 1)
        self.assertEqual(len(state["verification_state"]), 1)
        self.assertEqual(next(iter(state["verification_state"].values()))["status"], "verified")
        self.assert_finding_artifacts(state, report_response)
        self.assertEqual((self.repo / "code.py").read_text(), source)
        self.assertEqual(self.git("show-ref"), before)
        self.assertTrue(edits)
        self.assertTrue(set(("finding", "verification", "patch", "report")).issubset(calls))
        self.assertEqual(calls.count("report"), 4 if not report_response else 1)
        if expansion in ("lost", "recovered"):
            self.assertTrue(failed_attempts)
        if export:
            self.export_finding(export, states[0], state, result)
        (self.evidence / "native-result.json").write_text(json.dumps(result))
        return state

    def stub_bound_completion(self, stack, response):
        import litellm  # pylint: disable=import-outside-toplevel

        _, route = bridge.resolve_native_config(self.request())
        attempts = []

        def completion(**kwargs):
            self.assertIsNot(litellm.completion, transport,
                             "Every phase/retry must traverse the guard")
            self.assertEqual(kwargs["model"], route["transportModel"])
            self.assertEqual(kwargs["api_base"], route["destination"]["apiBase"])
            attempts.append(kwargs)
            if len(attempts) == 1:
                raise litellm.ServiceUnavailableError("offline transient retry",
                                                     llm_provider="openai", model=kwargs["model"])
            message, stop, *_ = response(None, "offline-model", kwargs["messages"],
                                        **{**{key: value for key, value in kwargs.items()
                                              if key not in ("model", "messages")},
                                           "provider": "lmstudio"})
            tools = [{"id": tool.id, "type": tool.type, "function": vars(tool.function)}
                     for tool in (message.tool_calls or [])]
            return litellm.ModelResponse(model=kwargs["model"], choices=[{
                "message": {"role": "assistant", "content": message.content,
                            "tool_calls": tools or None}, "finish_reason": stop}],
                usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})

        transport = stack.enter_context(patch.object(litellm, "completion", side_effect=completion))
        stack.enter_context(patch.object(agent.time, "sleep"))
        self.addCleanup(lambda: self.assertGreater(transport.call_count, 1))
        return transport

    def test_released_primary_auxiliary_and_retry_calls_share_bound_transport(self):
        self.released_finding("# Synthetic bound-transport report\n", transport_guard=True)

    def assert_finding_artifacts(self, state, report_response):
        entry = next(iter(state["artifact_state"].values()))
        self.assertEqual(entry["status"], "written")
        findings = self.repo / "audit-findings"
        self.assertEqual((findings / entry["report_filename"]).read_text(), report_response)
        patch_text = (findings / entry["patch_filename"]).read_text()
        self.assertIn('-    return True', patch_text)
        self.assertIn('+    return role == "admin"', patch_text)

    def export_finding(self, export, state_path, state, result):
        export = Path(export)
        state_dir = export / "evidence" / "native-state" / state_path.parent.name
        state_dir.mkdir(parents=True)
        shutil.copyfile(state_path, state_dir / "state.json")
        shutil.copytree(self.repo / "audit-findings", export / "evidence" / "audit-findings")
        (export / "manifest.json").write_text(json.dumps({
            "scope": state["scope"], "snapshotCommit": state["scope"]["commit"],
            "audit": {"all": True}, "route": result["route"],
            "sandbox": "bubblewrap", "bwrapVersion": "0.12.0",
            "bwrapIdentity": bridge.BWRAP_IDENTITY,
            "unshareIdentity": bridge.UNSHARE_IDENTITY,
            "nono": result["sandbox"]["nonoIdentity"]["path"],
            "nonoIdentity": result["sandbox"]["nonoIdentity"],
            "nonoProfileIdentity": result["sandbox"]["nonoProfileIdentity"],
            "sessionSandbox": "builtin"
        }))
        (export / "request.json").write_text(json.dumps({
            "expectedRoute": result["route"], "sandbox": "bubblewrap",
            "bwrapVersion": "0.12.0", "bwrapIdentity": bridge.BWRAP_IDENTITY,
            "unshareIdentity": bridge.UNSHARE_IDENTITY,
            "nono": result["sandbox"]["nonoIdentity"]["path"],
            "nonoIdentity": result["sandbox"]["nonoIdentity"],
            "nonoProfileIdentity": result["sandbox"]["nonoProfileIdentity"],
            "sessionSandbox": "builtin",
        }))
        (export / "completed.json").write_text(json.dumps({
            "exitCode": 0 if result["status"] == "completed" else 1,
            "exitedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"),
            "shutdown": "verified", "boundary": "bubblewrap-pidfd",
        }))
        (export / "evidence" / "native-result.json").write_text(json.dumps(result))

    def test_released_finding_verification_patch_and_report(self):
        self.released_finding("# Synthetic role access-control report\n\nSource judgment.\n")

    def test_released_two_inventory_findings_preserve_unrecovered_expansion_loss(self):
        self.released_finding("# Synthetic role access-control report\n", expansion="lost")

    def test_released_analytical_retry_recovers_expansion_failure(self):
        self.released_finding("# Synthetic role access-control report\n", expansion="recovered")

    def test_released_out_of_scope_expansion_is_a_legitimate_discard(self):
        self.released_finding("# Synthetic role access-control report\n", expansion="out-of-scope")

    # Check real released input builders and HEAD-derived worktrees, not a
    # substitute content loader. LLM and agent-loop boundaries remain offline.
    # pylint: disable-next=too-many-locals,too-many-statements
    def assert_released_committed_config(self):
        original = self.git("show", "HEAD:swival.toml") + "\n"
        self.assertIn("committed-content-sentinel", original)
        before = (self.git("show-ref"),
                  self.git("status", "--porcelain=v1", "--untracked-files=no"))
        scope = audit._resolve_scope(str(self.repo), [])
        self.assertIn("swival.toml", scope.mandatory_files)
        state = audit.AuditRunState(run_id="12345678", scope=scope,
                                    queued_files=scope.mandatory_files)
        state._content_cache.update(audit._load_file_contents(
            scope.mandatory_files, str(self.repo)))
        self.assertEqual(state._content_cache["swival.toml"], original)
        context = SimpleNamespace(base_dir=str(self.repo), loop_kwargs={
            "files_mode": "some", "network_mode": "provider-only"}, tools=[], trace_dir=None)
        seen = []
        responses = {
            "phase 2": audit._PHASE2_WORKED_EXAMPLE,
            "phase 3a": ("@@ finding @@\ntitle: Synthetic config finding\nseverity: high\n"
                         "location: swival.toml:1\nattacker: synthetic actor\n"
                         "trigger: synthetic trigger\nimpact: synthetic impact\n"
                         "claim: synthetic claim"),
            "phase 3b": ("@@ expansion @@\ntype: security_control_failure\n"
                         "attacker: synthetic actor\ntrigger: synthetic trigger\n"
                         "impact: synthetic impact\npreconditions: synthetic\n"
                         "proof: synthetic committed config evidence\n"
                         "fix_outline: synthetic patch"),
            "phase 4.5 review": audit._PHASE45_WORKED_EXAMPLE,
            "phase 4.5 consolidate": audit._PHASE45_RULING_WORKED_EXAMPLE,
            "phase 5 report": "# Synthetic config report\n",
        }

        def response(_context, messages, **kwargs):
            task = kwargs["trace_task"]
            self.assertIn(original, messages[-1]["content"], task)
            self.assertNotIn("Native audit runtime configuration is inert", messages[-1]["content"])
            phase = next((prefix for prefix in responses if prefix in task), None)
            self.assertIsNotNone(phase, "Unexpected phase; no provider fallback")
            seen.append(phase)
            return responses[phase]

        def loop(messages, _tools, **kwargs):
            self.assertIn(original, messages[-1]["content"])
            worktree = Path(kwargs["base_dir"])
            self.assertNotEqual(worktree, self.repo)
            self.assertEqual((worktree / "swival.toml").read_text(), original)
            self.assertEqual(kwargs["files_mode"], "some")
            self.assertEqual(kwargs["network_mode"], "provider-only")
            if messages[0]["content"].startswith("You are fixing"):
                seen.append("patch")
                (worktree / "swival.toml").write_text(original + "# synthetic patch\n")
                return "Synthetic patch", False
            seen.append("verification")
            return "Synthetic source judgment\nREPRODUCED", False

        with (patch.object(agent, "resolve_provider",
                           side_effect=AssertionError("provider forbidden")),
              patch.object(agent, "call_llm", side_effect=AssertionError("transport forbidden")),
              patch.object(audit, "_call_audit_llm", side_effect=response),
              patch.object(agent, "run_agent_loop", side_effect=loop)):
            state.triage_records["swival.toml"] = audit._phase2_triage_one(
                "swival.toml", state, context)
            audit._phase2_confirm_one("swival.toml", state, context)
            findings = audit._phase3_deep_review("swival.toml", state, context)
            self.assertEqual(len(findings), 1)
            finding = findings[0]
            evidence, count = audit._gather_evidence(finding, state, context)
            self.assertIn(original, evidence)
            self.assertEqual(count, 1)
            proof = audit._phase4c_reproduce(
                finding, state, context, self.repo / ".swival" / "verify")
            self.assertTrue(proof["reproduced"])
            verified = audit.VerifiedFinding(finding, "synthetic", "synthetic", proof)
            proposed = audit._phase5_patch(verified, context, state, patch_max_turns=1)
            self.assertIn("+# synthetic patch", proposed.patch_text)
            review = audit._phase45_review_one(finding, "synthetic", "synthetic", evidence,
                                               "synthetic", state, context)
            audit._phase45_consolidate(finding, [review], "synthetic", evidence, state, context)
            report = audit._phase5_report(verified, "001-test.patch", proposed.patch_text,
                                           state, context)
            self.assertEqual(report, "# Synthetic config report\n")
        self.assertTrue(set(responses).union({"verification", "patch"}).issubset(seen))
        self.assertEqual(audit._load_audit_config(str(self.repo)), ([], {}, None))
        self.assertEqual(self.git("show", "HEAD:swival.toml") + "\n", original)
        self.assertEqual(self.git("show-ref"), before[0])
        self.assertEqual(self.git("status", "--porcelain=v1", "--untracked-files=no"), before[1])

    def test_released_committed_config_is_auditable_while_runtime_copy_is_inert(self):
        (self.repo / "swival.toml").write_text(
            '# committed-content-sentinel\n[audit]\nforce_review=["code.py"]\n')
        self.git("add", "swival.toml")
        self.git("commit", "-m", "tracked config fixture")
        (self.repo / "swival.toml").write_text("# Native audit runtime configuration is inert.\n")
        self.assert_released_committed_config()

    def test_expansion_observer_is_bounded_and_restored_on_error(self):
        with patch.object(audit, "_ui_warning") as warning:
            with self.assertRaisesRegex(bridge.NativeAuditError, "expansion evidence limit"):
                with bridge._expansion_failures(1) as failures:
                    audit._ui_warning(None, "expansion failed for code.py: private diagnostic")
                    audit._ui_warning(None, "  code.py: 1/2 expansion(s) failed, "
                                      "1 finding(s) retained")
                    self.assertEqual(failures, [1])
                    audit._ui_warning(None, "  other.py: 1/2 expansion(s) failed, "
                                      "1 finding(s) retained")
            self.assertIs(audit._ui_warning, warning)

    def test_released_empty_report_exhausts_four_model_responses(self):
        state = self.released_finding("")
        self.assertEqual(state["metrics"]["empty_response_retries"], 4)

    def test_released_whitespace_report_is_written_but_not_substantive(self):
        self.released_finding(" \n\t")

    def test_non_linux_bubblewrap_is_blocked_before_session_or_provider(self):
        with patch.object(sys, "platform", "darwin"), patch(
            "swival.session.Session",
            side_effect=AssertionError("unsupported platform must not spawn")
        ), self.assertRaisesRegex(bridge.NativeAuditError, "bubblewrap/platform"):
            bridge.run_native(self.request())

    def test_unstubbed_socket_connection_and_dns_fail_closed(self):
        for function, args in ((socket.socket, ()),
                               (socket.create_connection, (("offline.invalid", 443),)),
                               (socket.getaddrinfo, ("offline.invalid", 443))):
            with self.assertRaisesRegex(AssertionError, "provider/network forbidden"):
                function(*args)

    def test_native_empty_scope_does_not_initialize_session_or_provider(self):
        self.assertTrue(callable(getattr(bridge, "run_native", None)))
        request = self.request()
        request["audit"]["paths"] = ["missing.py"]
        with patch("swival.session.Session",
                   side_effect=AssertionError("no Session for empty scope")):
            result = bridge.run_native(request)
        self.assertEqual(result["status"], "empty_scope")

    def test_native_verifier_and_patch_inherit_restricted_parent_modes(self):
        session = Session(base_dir=str(self.repo), files="some", commands="none",
                          network="provider-only", no_instructions=True, no_skills=True,
                          memory=False, history=False,
                          subagents=False, lifecycle_enabled=False)
        with patch.object(agent, "resolve_provider", return_value=(
            "offline-model", None, None, 128000, {"provider": "lmstudio"}
        )), patch("swival.sandbox_nono.check_wrapper_available"), patch(
            "swival.sandbox_nono.build_block_net_wrapper", return_value=["offline-nono"]
        ):
            session._setup()
        state = session._make_per_run_state(system_content="offline")
        context = session._make_input_context(state)
        isolated = make_isolated_loop_kwargs(context, self.root / "worktree",
                                            files_mode=None, network_mode=None)
        self.assertEqual(isolated["files_mode"], "some")
        self.assertEqual(isolated["network_mode"], "provider-only")
        self.assertFalse(isolated["shell_allowed"])
        self.assertEqual(isolated["command_policy"].mode, "none")
        self.assertNotIn("subagent_manager", isolated)
        session.close()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--export-finding":
        fixture = NativeEntryTests("test_released_finding_verification_patch_and_report")
        try:
            fixture.setUp()
            reports = {"complete": "# Synthetic role access-control report\n",
                       "empty": "", "whitespace": " \n\t"}
            mode = sys.argv[3]
            fixture.released_finding(reports.get(mode, reports["complete"]), export=sys.argv[2],
                                     expansion=mode if mode in ("lost", "recovered", "out-of-scope")
                                     else "complete")
        finally:
            fixture.doCleanups()
    elif len(sys.argv) == 3 and sys.argv[1] == "--check-content":
        fixture = NativeEntryTests(
            "test_released_committed_config_is_auditable_while_runtime_copy_is_inert")
        try:
            fixture.setUp()
            fixture.repo = Path(sys.argv[2])
            fixture.assert_released_committed_config()
            print("Released committed config phases passed")
        finally:
            fixture.doCleanups()
    elif sys.argv[1:] == ["--run-finding"]:
        fixture = NativeEntryTests("test_released_finding_verification_patch_and_report")
        try:
            fixture.setUp()
            incoming = json.loads(sys.stdin.read(64 * 1024))
            fixture.repo = Path(incoming["snapshot"])
            fixture.evidence = Path(incoming["evidence"])
            fixture.request = lambda: incoming
            fixture.released_finding("# Synthetic role access-control report\n",
                                     expansion="lost", commit_source=False)
        finally:
            fixture.doCleanups()
    else:
        unittest.main()
