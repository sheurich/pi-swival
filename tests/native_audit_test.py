"""Offline tests against released Swival entry points; every LLM call is stubbed."""
# Release-pinned private entry points are intentional compatibility assertions.
# pylint: disable=protected-access,missing-function-docstring

from datetime import datetime, timezone
import importlib.util
import json
import os
import shutil
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
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


class NativeEntryTests(unittest.TestCase):
    """Exercise native dispatch and inherited isolation without transport."""

    def setUp(self):
        # These are API/transport tests, not an assertion of Darwin kernel isolation.
        self.enterContext(patch.object(sys, "platform", "linux"))
        # unittest owns the context lifetime through enterContext.
        self.root = Path(self.enterContext(
            tempfile.TemporaryDirectory(prefix="offline-native-")  # pylint: disable=consider-using-with
        ))
        self.repo = self.root / "snapshot"
        self.evidence = self.root / "evidence"
        self.repo.mkdir()
        self.evidence.mkdir()
        self.enterContext(patch.dict(os.environ, {
            "HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "config"), "AGENTFS": "1"
        }))
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
        return {"source": str(self.repo), "snapshot": str(self.repo),
                "evidence": str(self.evidence),
                "routing": {"provider": "lmstudio", "model": "offline-model",
                            "reasoningEffort": "xhigh"},
                "agentfsVersion": "0.6.4",
                "audit": {"paths": [], "all": True, "workers": 1, "patchMaxTurns": 5},
                "expectedScope": audit._resolve_scope(str(self.repo), []).to_dict()}

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
    # pylint: disable-next=too-many-statements
    def released_finding(self, report_response, export=None, expansion="complete",
                         commit_source=True):
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

        with patch.object(agent, "resolve_provider", return_value=(
            "offline-model", "http://offline.invalid", None, 128000, {"provider": "lmstudio"}
        )), patch.object(agent, "call_llm", side_effect=call_llm), patch(
            "swival.sandbox_nono.check_wrapper_available"
        ), patch("swival.sandbox_nono.build_block_net_wrapper", return_value=["offline-nono"]):
            result = bridge.run_native(self.request())
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
            "audit": {"all": True}
        }))
        (export / "completed.json").write_text(json.dumps({
            "exitCode": 0 if result["status"] == "completed" else 1,
            "exitedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"),
            "shutdown": "verified",
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

    def test_darwin_agentfs_is_blocked_before_session_or_provider(self):
        with patch.object(sys, "platform", "darwin"), patch(
            "swival.session.Session",
            side_effect=AssertionError("unsupported platform must not spawn")
        ), self.assertRaisesRegex(bridge.NativeAuditError, "blocked on Darwin"):
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
