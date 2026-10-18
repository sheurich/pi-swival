"""Offline released Phase 2 overflow -> valid SKIP compatibility fixture.

Committed content and transport are synthetic; triage, retry/shrink, parsing,
metrics and persistence are the unmodified released Swival implementations.
"""
# Import and call released private phase APIs only after installing network guards.
# pylint: disable=import-outside-toplevel,protected-access
from dataclasses import asdict
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
from unittest.mock import patch


def corpus():
    """Return released truncation evidence from a guarded synthetic triage call."""
    forbidden = AssertionError("network/auth/inference forbidden")
    with patch.object(socket, "socket", side_effect=forbidden), \
         patch.object(socket, "create_connection", side_effect=forbidden), \
         patch.object(socket, "getaddrinfo", side_effect=forbidden):
        from swival import audit, worktree
        from swival.report import ContextOverflowError

        temporary = Path(__file__).resolve().parent / ".scratch" / "tmp"
        temporary.mkdir(parents=True, exist_ok=True)
        assert temporary.resolve() == temporary
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            root = Path(directory)
            state = audit.AuditRunState(
                "abc12345", audit.AuditScope("main", "1" * 40,
                                            ["code.py"], ["code.py"], []),
                ["code.py"], state_dir=root)
            context = SimpleNamespace(base_dir=str(root), loop_kwargs={})
            content = "# harmless prefix\n" * 300 + "# omitted-tail-sentinel\n"
            prompts = []

            def transport(_kwargs, messages, **_options):
                prompts.append(messages[-1]["content"])
                if len(prompts) == 1:
                    raise ContextOverflowError("synthetic overflow")
                assert len(prompts) == 2
                return ("@@ triage @@\npriority: SKIP\nconfidence: high\n"
                        "summary: no issue in supplied prefix\nneeds_followup: no", None)

            with patch.object(audit, "_git_show", return_value=content), \
                 patch.object(worktree, "call_llm_text", side_effect=transport):
                triage = audit._phase2_triage_one("code.py", state, context)
            assert triage.priority == "SKIP" and triage.confidence == "high"
            assert triage.triage_failure_mode is None
            assert "omitted-tail-sentinel" in prompts[0]
            assert "omitted-tail-sentinel" not in prompts[1]
            assert prompts[1] == prompts[0][:len(prompts[0]) // 2] + audit._AUDIT_TRUNCATION_MARKER
            assert state.metrics["truncated_calls"] == 1
            assert isinstance(state.truncated_files, dict)
            assert not state.truncated_files
            # Only terminal coverage scaffolding is synthetic; no full audit runs.
            state.triage_records["code.py"] = triage
            state.reviewed_files = {"code.py"}
            state.phase = "done"
            state.save()
            persisted = json.loads((root / state.run_id / "state.json").read_text())
            return {
                "producer": {"version": version("swival"),
                             "audit_sha256": hashlib.sha256(
                                 Path(audit.__file__).read_bytes()).hexdigest()},
                "triage": asdict(triage), "transport_calls": len(prompts),
                "persisted_state": persisted,
            }


if __name__ == "__main__":
    print(json.dumps(corpus()))
