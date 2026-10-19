"""Offline released-CLI, source-only tools, routing, and standard auth fixtures.

All HTTP responses and LLM calls are synthetic. The CLI sandbox bootstrap is
stubbed here; nativeAgentfs.test.ts separately exercises the real bootstrap.
"""
# pylint: disable=protected-access,import-outside-toplevel,missing-function-docstring
# pylint: disable=too-many-locals,too-many-statements,too-many-public-methods
import base64
import contextlib
from copy import deepcopy
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
os.environ["LITELLM_MODE"] = "PRODUCTION"
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["NONO_NO_UPDATE_CHECK"] = "1"
FORBIDDEN = AssertionError("network/auth/inference forbidden")
with patch.object(socket, "socket", side_effect=FORBIDDEN), \
     patch.object(socket, "create_connection", side_effect=FORBIDDEN), \
     patch.object(socket, "getaddrinfo", side_effect=FORBIDDEN):
    from swival import audit, agent, tools
    from swival.session import Session
    from swival.worktree import call_llm_text, make_isolated_loop_kwargs
    import httpx
    import litellm
    from litellm.llms.chatgpt import authenticator

WORKTREE = Path(__file__).resolve().parents[1]
TEMP = WORKTREE / "tests" / ".scratch" / "tmp"
TEMP.mkdir(parents=True, exist_ok=True)
assert TEMP.resolve() == TEMP
SPEC = importlib.util.spec_from_file_location("native_audit", WORKTREE / "scripts/native_audit.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class NativeEntryTests(unittest.TestCase):
    """Run released code without real sockets, auth, or provider calls."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(  # pylint: disable=consider-using-with
            dir=TEMP, prefix="native-python-")
        self.root = Path(self.enterContext(temporary))
        self.repo = self.root / "snapshot"
        self.evidence = self.root / "evidence"
        self.repo.mkdir()
        self.evidence.mkdir()
        self.enterContext(patch.dict(os.environ, {"PATH": os.environ["PATH"],
            "HOME": str(self.root),
            "XDG_CONFIG_HOME": str(self.root / "config"), "TMPDIR": str(TEMP),
            "LITELLM_LOCAL_MODEL_COST_MAP": "True", "NONO_NO_UPDATE_CHECK": "1"}, clear=True))
        for name in ("socket", "create_connection", "getaddrinfo"):
            self.enterContext(patch.object(socket, name, side_effect=FORBIDDEN))
        for args in (["init", "--template="], ["config", "user.name", "Test"],
                     ["config", "user.email", "test@example.invalid"]):
            self.git(*args)
        (self.repo / "code.py").write_text("def answer(): return 42\n")
        self.git("add", ".")
        self.git("commit", "-m", "synthetic fixture")
        self.enterContext(patch.object(agent, "_MODEL_AUTOFIX", {}))
        self.routing = {"provider": "chatgpt", "model": "gpt-offline", "reasoningEffort": "xhigh"}
        self.write_config('max_context_tokens=128000\n')

    def git(self, *args):
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c",
            "core.fsmonitor=false",
                               "-c", "commit.gpgsign=false", *args], cwd=self.repo,
                              capture_output=True, check=True, timeout=5).stdout.decode().strip()

    def request(self):
        return {"source": str(self.repo), "routing": dict(self.routing)}

    def cli(self, diagnostic_path=None, all_files=True):
        """Real CLI parsing and native phases; synthetic bootstrap/transport only."""
        command = "/audit " + ("--all " if all_files else "") + "--workers 1 --patch-max-turns 5"
        session = "native-" + "1" * 32
        argv = [
            "swival", "--base-dir", str(self.repo), "--sandbox", "builtin",
            "--network", "provider-only", "--commands", "none", "--files", "some",
            "--oneshot-commands", "--no-sandbox-auto-session", "--no-instructions",
            "--no-skills", "--no-metaskills", "--no-mcp", "--no-a2a", "--no-subagents",
            "--no-lifecycle", "--no-history", "--no-continue", "--no-memory",
            *[item for key, value in self.routing.items() for item in
              ["--" + bridge.OVERRIDE_KEYS.get(key, key).replace("_", "-"), str(value)]],
            "--report", str(self.repo / "native-cli-report.json"), "--", command,
        ]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(output), \
             contextlib.redirect_stderr(output):
            try:
                agent.main()
            except SystemExit as exc:
                self.assertIn(exc.code, (None, 0), output.getvalue())
        text = output.getvalue()
        self.assertLess(len(text.encode()), 65536)
        if diagnostic_path is not None:
            Path(diagnostic_path).write_text(text, encoding="utf-8")
        losses = sum(int(match[0]) for match in re.findall(
            r"([0-9]+)/([0-9]+) expansion\(s\) failed, ([0-9]+) finding\(s\) retained", text))
        return {"status": "completed", "expansionFailures": losses, "command": command,
            "session": session}

    def export_finding(self, export, state_path, state, result):
        export = Path(export)
        state_dir = export / "evidence" / "native-state" / state_path.parent.name
        state_dir.mkdir(parents=True)
        shutil.copyfile(state_path, state_dir / "state.json")
        shutil.copytree(self.repo / "audit-findings", export / "evidence" / "audit-findings")
        report = json.loads((self.repo / "native-cli-report.json").read_text())
        route = bridge.resolve_native_config(self.request())
        self.assertEqual(route["reportIdentity"], {"provider": report["provider"],
            "model": report["model"]})
        (export / "manifest.json").write_text(json.dumps({
            "snapshotCommit": state["scope"]["commit"],
            "files": state["scope"]["tracked_files"], "scope": state["scope"], "route": route,
            "sandbox": "agentfs", "session": result["session"], "command": result["command"],
                "audit": {"all": "--all" in result["command"].split()}}))
        (export / "evidence" / "native-cli-report.json").write_text(json.dumps(report))
        # Synthetic shutdown/diagnostic envelope only. Terminal adjudication tests
        # replace diagnostics with the production collector's replayed result.
        (export / "diagnostics.json").write_text(json.dumps({"closed": True, "bytes": 100,
            "ambiguous": False, "authPersistenceFailure": False,
            "adjudicationFailure": False, "adjudicationRepairFailure": False,
            "expansionFailures": result["expansionFailures"]}))
        (export / "completed.json").write_text(json.dumps({"exitCode": 0,
            "exitedAt": "2026-01-01T00:00:00.000Z", "shutdown": "verified",
                "boundary": "agentfs-cli"}))

    def test_released_zero_finding_cli(self):
        calls = []
        def completion(_api, _model, messages, *_args, **_kwargs):
            text = audit._PHASE1_WORKED_EXAMPLE if not calls else "@@ none @@"
            calls.append(messages)
            return {"role": "assistant", "content": text}, "stop", False, 0, None
        with patch.object(agent, "resolve_provider", return_value=("gpt-offline", None, None,
            128000, {"provider": "chatgpt"})), \
             patch.object(agent, "call_llm", side_effect=completion), \
             patch("swival.sandbox_nono.check_wrapper_available"), \
             patch("swival.sandbox_nono.build_block_net_wrapper", return_value=["offline-nono"]):
            self.cli()
        states = list((self.repo / ".swival/audit").glob("*/state.json"))
        self.assertEqual(len(states), 1)
        state = json.loads(states[0].read_text())
        self.assertEqual(state["phase"], "done")
        self.assertEqual(state["verified_findings"], [])
        self.assertEqual(state["deep_reviewed_files"], ["code.py"])

    def test_released_tool_and_isolated_loop_denials(self):
        session = Session(base_dir=str(self.repo), files="some", commands="none",
            network="provider-only",
            no_instructions=True, no_skills=True, memory=False, history=False,
                subagents=False, lifecycle_enabled=False)
        with patch.object(agent, "resolve_provider", return_value=("gpt-offline", None, None,
            128000, {"provider": "chatgpt"})), \
             patch("swival.sandbox_nono.check_wrapper_available"), \
             patch("swival.sandbox_nono.build_block_net_wrapper", return_value=["offline-nono"]):
            session._setup()
        self.addCleanup(session.close)
        context = session._make_input_context(session._make_per_run_state(system_content="offline"))
        isolated = make_isolated_loop_kwargs(context, self.root / "worktree", files_mode=None,
            network_mode=None)
        self.assertEqual(isolated["files_mode"], "some")
        self.assertEqual(isolated["network_mode"], "provider-only")
        self.assertFalse(isolated["shell_allowed"])
        self.assertEqual(isolated["command_policy"].mode, "none")
        with patch.object(subprocess, "Popen",
            side_effect=AssertionError("model execution forbidden")):
            for name, args in [("run_command", {"command": ["id"]}), ("run_python",
                {"code": "print(42)"}),
                               ("run_shell_command", {"command": "id"}), ("fetch_url",
                                   {"url": "https://offline.invalid"})]:
                result = tools.dispatch(name, args, str(self.repo), **{k: v for k,
                    v in isolated.items() if k != "base_dir"})
                self.assertTrue(result.startswith("error:"), name)

    def test_chatgpt_not_found_never_replaces_model(self):
        self.assertGreater(len(set(agent._list_server_models("chatgpt", None, None))), 1)
        failure = litellm.NotFoundError("synthetic missing model", llm_provider="chatgpt",
            model="gpt-offline")
        with patch.object(litellm, "completion", side_effect=failure) as completion:
            with self.assertRaises(agent.AgentError):
                agent.call_llm(None, "gpt-offline", [{"role": "user", "content": "synthetic"}],
                               100, None, None, None, None, False, provider="chatgpt",
                                   max_retries=1)
        self.assertEqual({call.kwargs["model"] for call in completion.call_args_list},
            {"chatgpt/gpt-offline"})
        self.assertFalse(agent._MODEL_AUTOFIX)

    def test_chatgpt_retry_preserves_route(self):
        reply = litellm.ModelResponse(model="chatgpt/gpt-offline",
            choices=[{"message": {"role": "assistant", "content": "synthetic"},
                "finish_reason": "stop"}])
        failure = litellm.ServiceUnavailableError("synthetic retry", llm_provider="chatgpt",
            model="gpt-offline")
        with patch.object(litellm, "completion", side_effect=[failure,
            reply]) as completion, patch.object(agent.time, "sleep"):
            agent.call_llm(None, "gpt-offline", [{"role": "user", "content": "synthetic"}],
                           100, None, None, None, None, False, provider="chatgpt", max_retries=2)
        self.assertEqual(completion.call_count, 2)
        self.assertEqual({call.kwargs["model"] for call in completion.call_args_list},
            {"chatgpt/gpt-offline"})
        self.assertEqual({call.kwargs.get("api_base") for call in completion.call_args_list},
            {None})

    def write_config(self, text):
        directory = Path(os.environ["XDG_CONFIG_HOME"]) / "swival"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "config.toml").write_text(text)

    def test_configured_defaults_and_specialist_precedence(self):
        self.write_config('provider="openrouter"\nmodel="example/default"\n'
            'active_profile="ordinary"\nmax_context_tokens=128000\n'
            '[profiles.ordinary]\nprovider="chatgpt"\nmodel="chatgpt/gpt-active"\n'
            '[profiles.specialist]\nprovider="openrouter"\nmodel="example/specialist"\n'
            'reasoning_effort="high"\n')
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "synthetic-key"}), \
             patch.object(agent, "resolve_provider", side_effect=FORBIDDEN), \
             patch.object(authenticator, "Authenticator", side_effect=FORBIDDEN):
            default = bridge.resolve_native_config({"source": str(self.repo)})
            self.assertEqual(default["model"], "chatgpt/gpt-active")
            self.assertEqual(default["selection"]["profileSource"], "active")
            route = bridge.resolve_native_config({"source": str(self.repo),
                "routing": {"profile": "specialist"}})
            self.assertEqual(route["version"], 2)
            self.assertEqual((route["provider"], route["model"], route["reasoningEffort"]),
                ("openrouter", "example/specialist", "high"))
            self.assertEqual(route["selection"], {"profileSource": "explicit",
                "explicitFields": ["profile"]})
            selected = bridge.resolve_native_config({"source": str(self.repo),
                "routing": {"profile": "specialist", "model": "example/override",
                    "reasoningEffort": "xhigh"}})
            self.assertEqual(selected["model"], "example/override")
            self.assertEqual(selected["reasoningEffort"], "xhigh")
        self.assertFalse(agent._MODEL_AUTOFIX)

    def test_default_api_and_explicit_local_endpoint(self):
        self.write_config('provider="openrouter"\nmodel="example/concrete"\n'
                          'max_context_tokens=128000\n')
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "synthetic-dedicated-key"}), \
             patch.object(agent, "resolve_provider", side_effect=FORBIDDEN), \
             patch.object(authenticator, "Authenticator", side_effect=FORBIDDEN):
            for endpoint in (None, "https://caller.invalid/v1", "http://127.0.0.1:8444/v1"):
                with self.subTest(endpoint=endpoint):
                    with self.assertRaises(bridge.NativeAuditError) as error:
                        bridge.resolve_native_config({"source": str(self.repo),
                                                      "routing": {"baseUrl": endpoint}})
                    self.assertEqual(error.exception.reason, "CONFIG_INVALID")

        for endpoint in (None, "http://127.0.0.1:8444/v1"):
            with self.subTest(endpoint=endpoint):
                self.write_config('provider="openrouter"\nmodel="example/concrete"\n'
                    'max_context_tokens=128000\n' +
                    (f'base_url="{endpoint}"\n' if endpoint else ''))
                with patch.dict(os.environ, {"OPENROUTER_API_KEY": "synthetic-dedicated-key"}):
                    route = bridge.resolve_native_config({"source": str(self.repo)})
                self.assertEqual(route["provider"], "openrouter")
                self.assertEqual(route["endpoint"], endpoint)
                self.assertEqual(route["selection"]["profileSource"], None)
                self.assertNotIn("synthetic-dedicated-key", json.dumps(route))

    def test_selection_and_capability_failures_are_precise(self):
        chatgpt = 'provider="chatgpt"\nmodel="gpt-offline"'
        api = 'provider="openrouter"\nmodel="concrete"'
        cases = [
            ('', {}, "ROUTE_INCOMPLETE"),
            ('provider="chatgpt"', {}, "ROUTE_INCOMPLETE"),
            ('model="gpt-offline"', {}, "ROUTE_INCOMPLETE"),
            (chatgpt, {"profile": "missing"}, "PROFILE_UNAVAILABLE"),
            ('[profiles.test]\nmodel="gpt-offline"', {"profile": "test"}, "PROFILE_UNAVAILABLE"),
            ('[profiles.test]\n' + chatgpt, {"profile": ""}, "PROFILE_UNAVAILABLE"),
            ('provider="unfamiliar"\nmodel="concrete"', {}, "CONFIG_INVALID"),
            ('provider="generic"\nmodel="concrete"', {}, "MODEL_REPLACEMENT_UNCONTROLLABLE"),
            ('provider="lmstudio"\nmodel="concrete"', {}, "MODEL_REPLACEMENT_UNCONTROLLABLE"),
            ('provider="llamacpp"\nmodel="concrete"', {}, "MODEL_REPLACEMENT_UNCONTROLLABLE"),
            ('provider="google"\nmodel="concrete"', {}, "MODEL_REPLACEMENT_UNCONTROLLABLE"),
            ('provider="bedrock"\nmodel="concrete"', {}, "CREDENTIAL_INTERFACE_UNSUPPORTED"),
            ('provider="command"\nmodel="concrete"', {}, "COMMAND_EXECUTION_REQUIRED"),
            (api + '\nbase_url="https://offline.invalid/' + 'x' * 48 + '"',
                {}, "CONFIG_INVALID"),
            ('provider="openrouter"\nmodel="openrouter/auto"', {}, "ROUTE_SELECTOR_UNSUPPORTED"),
            ('provider="openrouter"\nmodel="openrouter/openrouter/auto:floor"',
                {}, "ROUTE_SELECTOR_UNSUPPORTED"),
            ('api_key="synthetic-secret"\n[profiles.test]\nprovider="openrouter"\nmodel="concrete"',
                {"profile": "test"}, "CREDENTIAL_INTERFACE_UNSUPPORTED"),
            ('base_url="https://offline.invalid/v1"\n[profiles.test]\n' + chatgpt,
                {"profile": "test"}, "ENDPOINT_REQUIREMENT_UNSUPPORTED"),
            (api + '\napi_key="synthetic-secret"', {}, "CREDENTIAL_INTERFACE_UNSUPPORTED"),
            (chatgpt + '\nreasoning_effort="invalid"', {}, "CONFIG_INVALID"),
            (chatgpt + '\nbase_url="https://user:synthetic-secret@offline.invalid"',
                {}, "CONFIG_INVALID"),
        ]
        for config, routing, reason in cases:
            with self.subTest(reason=reason, routing=routing):
                self.write_config(config)
                with patch.dict(os.environ, {"OPENROUTER_API_KEY": "synthetic-key"}), \
                     self.assertRaisesRegex(bridge.NativeAuditError, reason):
                    bridge.resolve_native_config({"source": str(self.repo), "routing": routing})
        with patch.object(bridge.importlib.metadata, "version", return_value="unsupported"):
            with self.assertRaisesRegex(bridge.NativeAuditError, "RUNTIME_UNSUPPORTED"):
                bridge.resolve_native_config(self.request())

    def test_nonpropagated_policy_fields_are_value_free(self):
        for key, value in {"encrypt_secrets": "true", "llm_filter": '"synthetic-secret"',
            "secret_shield": "true", "extra_body": '{ routing="synthetic-secret" }',
            "prompt_cache": "false", "sanitize_thinking": "true", "show_thinking": "true",
            "sandbox_strict_read": "true", "sandbox_session": '"synthetic-secret"',
            "reasoning_effort_all_phases": "true", "retries_all_phases": "true",
            "retries": "1"}.items():
            with self.subTest(field=key):
                self.write_config(f'provider="chatgpt"\nmodel="gpt-offline"\n{key}={value}\n')
                with self.assertRaises(bridge.NativeAuditError) as raised:
                    bridge.resolve_native_config({"source": str(self.repo)})
                self.assertEqual(getattr(raised.exception, "reason", None), "POLICY_NOT_PROPAGATED")
                self.assertEqual(getattr(raised.exception, "field", None), key)
                self.assertNotIn("synthetic-secret", str(raised.exception))

    def test_unknown_policy_field_names_are_not_returned(self):
        self.write_config('provider="chatgpt"\nmodel="gpt-offline"\n'
            'nono_synthetic_private_field=true\n')
        with self.assertRaises(bridge.NativeAuditError) as raised:
            bridge.resolve_native_config({"source": str(self.repo)})
        self.assertEqual(raised.exception.reason, "CONFIG_INVALID")
        self.assertNotIn("synthetic_private_field", json.dumps(raised.exception.response()))

    def representative(self, provider, endpoint=None):
        self.write_config(f'provider="{provider}"\nmodel="example/concrete"\n'
            'max_context_tokens=128000\nreasoning_effort="xhigh"\n' +
            (f'base_url="{endpoint}"\n' if endpoint else ''))
        self.routing = {}
        self.enterContext(patch.dict(os.environ, {"OPENROUTER_API_KEY": "synthetic-dedicated-key"}))
        return bridge.resolve_native_config(self.request())

    def test_released_default_active_and_explicit_profile_dispatch(self):
        config = ('provider="openrouter"\nmodel="example/default"\nmax_context_tokens=128000\n'
            '[profiles.ordinary]\nprovider="chatgpt"\nmodel="chatgpt/gpt-active"\n'
            '[profiles.specialist]\nprovider="openrouter"\nmodel="example/specialist"\n'
            'reasoning_effort="high"\n')
        for active, routing, expected in (
                (False, {}, ("openrouter", "example/default")),
                (True, {}, ("chatgpt", "chatgpt/gpt-active")),
                (True, {"profile": "specialist"}, ("openrouter", "example/specialist"))):
            self.write_config(('active_profile="ordinary"\n' if active else '') + config)
            self.routing = routing
            calls = []
            with patch.dict(os.environ, {"OPENROUTER_API_KEY": "synthetic-selected-key"}), \
                 patch.object(agent, "call_llm", side_effect=zero_finding_reply(calls)), \
                 patch("swival.sandbox_nono.check_wrapper_available"), \
                 patch("swival.sandbox_nono.build_block_net_wrapper",
                       return_value=["offline-nono"]):
                self.cli()
            self.assertTrue(calls)
            self.assertEqual(set(calls), {expected})
            self.assertFalse(agent._MODEL_AUTOFIX)
            shutil.rmtree(self.repo / ".swival")

    def test_released_api_and_local_full_finding_phases(self):
        for endpoint in (None, "http://127.0.0.1:8444/v1"):
            with self.subTest(endpoint=endpoint):
                self.representative("openrouter", endpoint)
                self.released_finding("# Synthetic source-only report\n",
                    commit_source=endpoint is None)
                shutil.rmtree(self.repo / ".swival")
                shutil.rmtree(self.repo / "audit-findings")
                self.assertFalse((self.root / ".config/litellm/chatgpt").exists())
                self.assertFalse(agent._MODEL_AUTOFIX)

    def test_released_terminal_errors_timeouts_and_notfound_keep_selected_route(self):
        for provider, endpoint in (("chatgpt", None), ("openrouter", None),
                ("openrouter", "http://127.0.0.1:8444/v1")):
            route = self.representative(provider, endpoint)
            model, api_base, key, _context, kwargs = agent.resolve_provider(provider,
                route["model"], None, endpoint, 128000, False)
            self.assertEqual(model, route["model"])
            self.assertEqual(api_base, endpoint)
            expected_model = agent._resolve_model_str(provider, model)
            for error_type in (litellm.AuthenticationError, litellm.PermissionDeniedError,
                    litellm.ContentPolicyViolationError, litellm.Timeout,
                    litellm.APIConnectionError, litellm.NotFoundError):
                with self.subTest(provider=provider, endpoint=endpoint,
                        failure=error_type.__name__):
                    extra = {}
                    if error_type is litellm.PermissionDeniedError:
                        extra["response"] = httpx.Response(403, request=httpx.Request(
                            "POST", "https://offline.invalid"))
                    failure = error_type("synthetic selected-route failure",
                        llm_provider=provider, model=model, **extra)
                    with patch.object(litellm, "completion", side_effect=failure) as completion, \
                         patch.object(agent.time, "sleep"):
                        with self.assertRaises(agent.AgentError):
                            agent.call_llm(api_base, model,
                                [{"role": "user", "content": "synthetic"}],
                                100, None, None, None, None, False, api_key=key,
                                provider=kwargs["provider"], max_retries=1)
                    self.assertGreater(completion.call_count, 0)
                    self.assertEqual({call.kwargs["model"] for call in completion.call_args_list},
                        {expected_model})
                    self.assertEqual({call.kwargs.get("api_base")
                        for call in completion.call_args_list}, {endpoint})
                    self.assertFalse(agent._MODEL_AUTOFIX)
            reply = litellm.ModelResponse(model=expected_model, choices=[{
                "message": {"role": "assistant", "content": "synthetic"}, "finish_reason": "stop"}])
            transient = litellm.ServiceUnavailableError("synthetic transient",
                llm_provider=provider, model=model)
            with patch.object(litellm, "completion",
                    side_effect=[transient, reply]) as completion, \
                 patch.object(agent.time, "sleep"):
                agent.call_llm(api_base, model, [{"role": "user", "content": "synthetic"}],
                    100, None, None, None, None, False, api_key=key,
                    provider=provider, max_retries=2)
            self.assertEqual(completion.call_count, 2)
            self.assertEqual({call.kwargs["model"] for call in completion.call_args_list},
                {expected_model})
            self.assertEqual({call.kwargs.get("api_base") for call in completion.call_args_list},
                {endpoint})

    def test_offline_recognized_policy_error_then_success_inherits_same_route_native_retries(self):
        """Characterize inherited retry success, not immediate refusal-stop or a done audit."""
        self.assert_offline_policy_error_retries(exhausted=False)

    def test_offline_recognized_policy_error_exhaustion_remains_terminal_without_fallback(self):
        self.assert_offline_policy_error_retries(exhausted=True)

    def assert_offline_policy_error_retries(self, *, exhausted):
        self.enterContext(patch.object(authenticator, "Authenticator", side_effect=FORBIDDEN))
        for provider, endpoint in (("chatgpt", None), ("openrouter", None),
                ("openrouter", "http://127.0.0.1:8444/v1")):
            route = self.representative(provider, endpoint)
            for error_type in (litellm.BadRequestError, litellm.APIError):
                for entry in ("primary", "auxiliary"):
                    with self.subTest(provider=provider, endpoint=endpoint,
                            error=error_type.__name__, entry=entry, exhausted=exhausted):
                        self.assert_offline_policy_error_case(route, error_type, entry,
                            exhausted=exhausted)

    def assert_offline_policy_error_case(self, route, error_type, entry, *, exhausted):
        options = route["options"]
        self.assertEqual(options["retries"], 5)
        self.assertEqual(inspect.signature(agent.call_llm).parameters["max_retries"].default,
            options["retries"])
        model, api_base, key, _context, kwargs = agent.resolve_provider(route["provider"],
            route["model"], None, route["endpoint"], options["max_context_tokens"], False)
        self.assertEqual((model, api_base, kwargs["provider"]),
            (route["model"], route["endpoint"], route["provider"]))
        llm_kwargs = {**kwargs, "api_key": key, "max_retries": options["retries"],
            "provider_timeout": options["provider_timeout"],
            "reasoning_effort": route["reasoningEffort"]}
        loop_kwargs = {"api_base": api_base, "model_id": model,
            "max_output_tokens": options["max_output_tokens"], "top_p": options["top_p"],
            "seed": options["seed"], "llm_kwargs": llm_kwargs}
        expected_model = agent._resolve_model_str(route["provider"], model)
        messages = [{"role": "user", "content": "synthetic policy retry fixture"}]
        original = deepcopy(messages)
        extra = {"status_code": 400, "request": httpx.Request(
            "POST", "https://offline.invalid")} if error_type is litellm.APIError \
            else {}
        failure = error_type(message="Invalid prompt: your prompt was flagged as "
            "potentially violating our usage policy", llm_provider=route["provider"],
            model=model, **extra)
        self.assertTrue(agent._is_prompt_rejection(failure))
        sentinel = "synthetic inherited same-route success"
        reply = litellm.ModelResponse(model=expected_model, choices=[{
            "message": {"role": "assistant", "content": sentinel},
            "finish_reason": "stop"}])
        requests = []
        def completion(**request):
            requests.append(deepcopy(request))
            if exhausted or len(requests) == 1:
                raise failure
            return reply
        def invoke():
            if entry == "auxiliary":
                # Use the real helper: it omits max_retries and keeps upstream's
                # default, which equals the admitted native retry setting.
                return call_llm_text(loop_kwargs, messages,
                    temperature=options["temperature"])[0]
            result = agent.call_llm(api_base, model, messages,
                options["max_output_tokens"], options["temperature"],
                options["top_p"], options["seed"], None, False, **llm_kwargs)
            self.assertEqual(result[3], 1)
            return agent._msg_get(result[0], "content")
        with patch.object(litellm, "completion", side_effect=completion), \
             patch.object(agent.time, "sleep") as sleep:
            if exhausted:
                with self.assertRaises(agent.AgentError) as raised:
                    invoke()
                self.assertEqual(raised.exception._provider_retries,
                    options["retries"] - 1)
            else:
                self.assertEqual(invoke(), sentinel)
        expected_attempts = options["retries"] if exhausted else 2
        self.assertEqual(len(requests), expected_attempts)
        self.assertEqual(sleep.call_count, expected_attempts - 1)
        self.assertEqual(messages, original)
        self.assertEqual(requests[0]["messages"], original)
        self.assertEqual(requests[0]["model"], expected_model)
        self.assertEqual(requests[0].get("api_base"), route["endpoint"])
        for request in requests[1:]:
            self.assertEqual(request, requests[0])
        self.assertFalse(agent._MODEL_AUTOFIX)

    def test_explicit_local_endpoint_uses_mock_http_without_remote_dispatch(self):
        endpoint = "http://127.0.0.1:8444/v1"
        route = self.representative("openrouter", endpoint)
        model, api_base, key, _context, kwargs = agent.resolve_provider(route["provider"],
            route["model"], None, endpoint, 128000, False)
        requests = []
        def response(request, **_kwargs):
            requests.append(request)
            return httpx.Response(200, request=request, json={"id": "synthetic",
                "object": "chat.completion",
                "created": 1, "model": model, "choices": [{"index": 0, "message": {
                    "role": "assistant", "content": "synthetic local reply"},
                    "finish_reason": "stop"}]})
        with patch.object(httpx.Client, "send", side_effect=response):
            message, _finish, _tokens, _cost, _usage = agent.call_llm(api_base, model,
                [{"role": "user", "content": "synthetic"}], 100, None, None, None, None, False,
                api_key=key, provider=kwargs["provider"], max_retries=1)
        self.assertEqual(agent._msg_get(message, "content"), "synthetic local reply")
        self.assertEqual(len(requests), 1)
        self.assertEqual(str(requests[0].url), endpoint + "/chat/completions")
        self.assertEqual(json.loads(requests[0].content)["model"], model)
        self.assertFalse(agent._MODEL_AUTOFIX)

    def test_dynamic_singleton_is_rejected_before_any_dispatch(self):
        self.write_config('provider="generic"\nmodel="selected"\n'
            'base_url="http://127.0.0.1:8444/v1"\nmax_context_tokens=128000\n')
        with patch.object(agent, "_list_server_models", return_value=["replacement"]) as listing, \
             patch.object(agent, "resolve_provider", side_effect=FORBIDDEN) as resolver, \
             patch.object(litellm, "completion", side_effect=FORBIDDEN) as completion:
            with self.assertRaisesRegex(bridge.NativeAuditError,
                    "MODEL_REPLACEMENT_UNCONTROLLABLE"):
                bridge.resolve_native_config({"source": str(self.repo)})
        listing.assert_not_called()
        resolver.assert_not_called()
        completion.assert_not_called()

    def auth_fixture(self, responses):
        token_dir = self.root / "synthetic-auth"
        self.enterContext(patch.dict(os.environ, {"CHATGPT_TOKEN_DIR": str(token_dir)}))
        calls = []
        def handler(request):
            calls.append(request)
            response = responses[len(calls) - 1]
            if isinstance(response, BaseException):
                raise response
            return httpx.Response(200, json=response)
        client = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(client.close)
        self.enterContext(patch.object(authenticator, "_get_httpx_client", return_value=client))
        self.enterContext(patch.object(authenticator.time, "time", return_value=100))
        auth = authenticator.Authenticator()
        return auth, calls

    def test_standard_chatgpt_refresh_and_auth_write(self):
        token = synthetic_jwt()
        auth, calls = self.auth_fixture([{"access_token": token, "id_token": token,
            "refresh_token": "synthetic-new-refresh"}])
        auth._write_auth_file({"access_token": "synthetic-expired", "expires_at": 1,
            "refresh_token": "synthetic-old-refresh"})
        self.assertEqual(auth.get_access_token(), token)
        self.assertEqual(len(calls), 1)
        self.assertEqual(auth._read_auth_file()["refresh_token"], "synthetic-new-refresh")
        self.assertEqual(auth.get_account_id(), "synthetic-account")

    def test_standard_chatgpt_login_and_auth_write(self):
        token = synthetic_jwt()
        auth, calls = self.auth_fixture([{"device_auth_id": "synthetic-device",
            "user_code": "synthetic-code", "interval": 1},
            {"authorization_code": "synthetic-authorization",
                "code_challenge": "synthetic-challenge", "code_verifier": "synthetic-verifier"},
            {"access_token": token, "id_token": token, "refresh_token": "synthetic-refresh"}])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(auth.get_access_token(), token)
        self.assertEqual(len(calls), 3)
        self.assertEqual(auth._read_auth_file()["account_id"], "synthetic-account")

    def test_standard_chatgpt_auth_error_and_cancellation_propagate(self):
        auth, _calls = self.auth_fixture([RuntimeError("synthetic auth failure")])
        with self.assertRaises(authenticator.GetDeviceCodeError):
            auth.get_access_token()
        self.assertFalse(Path(auth.auth_file).exists())
        with patch.object(authenticator, "_get_httpx_client", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                auth.get_access_token()

    def released_finding(self, report_response, export=None, expansion="complete",
                         commit_source=True, recovery="complete"):
        """Real released phases and edit_file with offline transport and OS stubs."""
        triage_failure = recovery == "triage-promoted"
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
        adjudication_errors = []
        malformed_calls = []
        repair_calls = []
        title = "Role authorization accepts non-admin"
        if recovery in ("reviewer-error", "consolidate-error"):
            # Exact titles from the parent Rich probe split each fixed marker at width 80.
            title = "Synthetic " + "x" * (35 if recovery == "reviewer-error" else 32)
        route = bridge.resolve_native_config(self.request())
        released_auxiliary = audit._call_audit_llm

        def auxiliary(context, messages, **kwargs):
            task = kwargs.get("trace_task", "")
            if triage_failure and "phase 2 triage" in task:
                raise agent.AgentError("synthetic triage infrastructure failure")
            if ((recovery == "reviewer-error" and "phase 4.5 review" in task)
                    or (recovery == "consolidate-error" and "phase 4.5 consolidate" in task)):
                adjudication_errors.append(task)
                raise agent.AgentError("synthetic-terminal-adjudication-value-never-export")
            return released_auxiliary(context, messages, **kwargs)

        responses = {
            "You are preparing a compact repository profile": ("profile", (
                "@@ profile @@\nlanguage: python\n"
                "auth_surface: authorize role access-control decision\n"
                "summary: synthetic role access-control fixture")),
            "You are performing phase 2 security triage": ("triage", audit._PHASE2_WORKED_EXAMPLE),
            "You are performing phase 3 deep security review": ("finding", (
                f"@@ finding @@\ntitle: {title}\n"
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
                f"@@ ruling @@\ntitle: {title}\n"
                "type: security_control_failure\nseverity: high\n"
                "threat_model: the role access-control decision accepts roles "
                "its documented contract requires it to reject\n"
                "fix_outline: return whether role equals admin")),
            "You are fixing a security bug": ("patch", ""),
            "You are writing the final markdown report": ("report", report_response),
        }

        def call_llm(_api, model, messages, *_args, **kwargs):
            self.assertEqual(model, route["model"])
            self.assertEqual(kwargs.get("provider"), route["provider"])
            self.assertEqual(_api, route["endpoint"])
            system = messages[0]["content"]
            # Agent loops inherit effort; plain auxiliary calls omit it.
            if system.startswith(("You are verifying", "You are fixing")):
                self.assertEqual(kwargs.get("reasoning_effort"), "xhigh")
            else:
                self.assertNotIn("reasoning_effort", kwargs)
            target = "ruling" if recovery.endswith("consolidation") else "adjudication"
            if system == audit._RECORD_REPAIR_SYSTEM:
                repair_calls.append(target)
                prefix = ("You are finalizing one security finding" if target == "ruling"
                          else "You are adjudicating one already-reproduced")
                response = ("repair", responses[prefix][1] if recovery.startswith("repaired-")
                            else "synthetic-malformed-adjudication-value-never-export")
            else:
                response = next((value for prefix, value in responses.items()
                                 if system.startswith(prefix)), None)
            self.assertIsNotNone(response, "Unexpected LLM phase; no transport fallback")
            phase, text = response
            if phase == target and (recovery.startswith(("malformed-", "repaired-")) or
                    (recovery == "reviewer-retry-recovered" and not malformed_calls)):
                malformed_calls.append(phase)
                text = "synthetic-malformed-adjudication-value-never-export"
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
            stack.enter_context(patch.object(agent, "call_llm", side_effect=call_llm))
            stack.enter_context(patch.object(audit, "_call_audit_llm", side_effect=auxiliary))
            stack.enter_context(patch("swival.sandbox_nono.check_wrapper_available"))
            stack.enter_context(patch("swival.sandbox_nono.build_block_net_wrapper",
                                      return_value=["offline-nono"]))
            result = self.cli(Path(export) / "released-diagnostics.txt" if export else None,
                              all_files=not triage_failure)
        self.assertEqual(len(adjudication_errors), {"reviewer-error": 6,
            "consolidate-error": 1}.get(recovery, 0))
        self.assertFalse(agent._MODEL_AUTOFIX)
        if not export and commit_source:
            self.assertEqual(result["status"], "completed", result)
            self.assertEqual(result.get("expansionFailures", 0),
                             1 if expansion == "lost" else 0)
        self.assertNotIn("private expansion diagnostic", json.dumps(result))
        states = list((self.repo / ".swival" / "audit").glob("*/state.json"))
        self.assertEqual(len(states), 1)
        state = json.loads(states[0].read_text())
        self.assertEqual(state["phase"], "done", state["verification_state"])
        malformed_count = {"malformed-reviewers": 6, "malformed-consolidation": 1,
            "repaired-reviewers": 3, "repaired-consolidation": 1,
            "reviewer-retry-recovered": 1}.get(recovery, 0)
        self.assertEqual(len(malformed_calls), malformed_count)
        self.assertEqual(len(repair_calls), malformed_count)
        self.assertEqual(state["metrics"]["repair_failures"],
                         0 if recovery.startswith("repaired-") else malformed_count)
        self.assertEqual(state["metrics"]["repair_successes"],
                         malformed_count if recovery.startswith("repaired-") else 0)
        if malformed_count:
            record = "ruling" if recovery.endswith("consolidation") else "verdict"
            self.assertEqual(state["metrics"]["parse_failures_" + record], malformed_count)
        if recovery == "reviewer-retry-recovered":
            self.assertEqual(state["metrics"]["phase45_lens_retries"], 1)
            self.assertEqual(calls.count("adjudication"), 4)
        if triage_failure:
            self.assertTrue(set(state["scope"]["mandatory_files"]).issubset(
                state["deep_reviewed_files"]))
            self.assertEqual(state["candidate_files"], state["deep_reviewed_files"])
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
        return state
    def assert_finding_artifacts(self, state, report_response):
        entry = next(iter(state["artifact_state"].values()))
        self.assertEqual(entry["status"], "written")
        findings = self.repo / "audit-findings"
        self.assertEqual((findings / entry["report_filename"]).read_text(), report_response)
        patch_text = (findings / entry["patch_filename"]).read_text()
        self.assertIn('-    return True', patch_text)
        self.assertIn('+    return role == "admin"', patch_text)
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

    def test_released_finding_report(self):
        self.released_finding("# Synthetic source-only report\n")

    def test_released_lost_expansion_is_visible_without_hooks(self):
        self.released_finding("# Synthetic source-only report\n", expansion="lost")

    def test_released_recovered_expansion_is_not_loss(self):
        self.released_finding("# Synthetic source-only report\n", expansion="recovered")

    def test_released_terminal_reviewer_errors_still_write_successful_artifacts(self):
        self.released_finding("# Synthetic source-only report\n", recovery="reviewer-error")

    def test_released_terminal_consolidation_error_still_writes_successful_artifacts(self):
        self.released_finding("# Synthetic source-only report\n", recovery="consolidate-error")

    def test_released_exhausted_adjudication_format_repair_still_writes_artifacts(self):
        for mode in ("malformed-reviewers", "malformed-consolidation"):
            with self.subTest(mode=mode):
                self.released_finding("# Synthetic source-only report\n", recovery=mode,
                                      commit_source=mode == "malformed-reviewers")
                shutil.rmtree(self.repo / ".swival")
                shutil.rmtree(self.repo / "audit-findings")

    def test_released_successful_adjudication_format_repair_writes_artifacts(self):
        for mode in ("repaired-reviewers", "repaired-consolidation", "reviewer-retry-recovered"):
            with self.subTest(mode=mode):
                self.released_finding("# Synthetic source-only report\n", recovery=mode,
                                      commit_source=mode == "repaired-reviewers")
                shutil.rmtree(self.repo / ".swival")
                shutil.rmtree(self.repo / "audit-findings")

    def test_released_triage_promotion_preserves_full_deep_review(self):
        self.released_finding("# Synthetic source-only report\n", recovery="triage-promoted")


def zero_finding_reply(captured):
    """Bind each CLI run's request capture without sharing mutable defaults."""
    def completion(_api, model, _messages, *_args, **kwargs):
        captured.append((kwargs["provider"], model))
        text = audit._PHASE1_WORKED_EXAMPLE if len(captured) == 1 else "@@ none @@"
        return {"role": "assistant", "content": text}, "stop", False, 0, None
    return completion


def synthetic_jwt():
    claims = {"exp": 10000,
        "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-account"}}
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"synthetic.{encoded}.synthetic"


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

if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--export-finding":
        fixture = NativeEntryTests("test_released_finding_report")
        try:
            fixture.setUp()
            reports = {"complete": "# Synthetic report\n", "empty": "", "whitespace": " \n\t"}
            export_mode = sys.argv[3]
            fixture.released_finding(reports.get(export_mode, reports["complete"]),
                export=sys.argv[2], expansion=(export_mode if export_mode in (
                    "lost", "recovered", "out-of-scope") else "complete"),
                recovery=(export_mode if export_mode in ("reviewer-error", "consolidate-error",
                    "malformed-reviewers", "malformed-consolidation", "repaired-reviewers",
                    "repaired-consolidation", "reviewer-retry-recovered", "triage-promoted")
                    else "complete"))
        finally:
            fixture.doCleanups()
    elif len(sys.argv) == 3 and sys.argv[1] == "--check-content":
        fixture = NativeEntryTests("test_released_finding_report")
        try:
            fixture.setUp()
            fixture.repo = Path(sys.argv[2])
            fixture.assert_released_committed_config()
            print("Released committed config phases passed")
        finally:
            fixture.doCleanups()
    else:
        unittest.main()
