"""Offline released-SDK lineage corpus; no native pipeline or provider transport."""
# Released private entry points are intentional compatibility assertions.
# pylint: disable=protected-access,missing-function-docstring,too-many-locals,too-many-branches,too-many-statements
from dataclasses import asdict
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

_import_forbidden = AssertionError("network/auth/inference forbidden during import")
with patch.object(socket, "socket", side_effect=_import_forbidden), \
     patch.object(socket, "create_connection", side_effect=_import_forbidden), \
     patch.object(socket, "getaddrinfo", side_effect=_import_forbidden):
    from swival import audit

_POSITIVE_SCENARIOS = {"keep", "rewrite", "drop", "mixed", "projection-collision"}
_EXPECTED_DECISIONS = {
    "keep": ["keep"],
    "rewrite": ["keep_with_changes"],
    "drop": ["drop"],
    "mixed": ["keep_with_changes", "drop"],
    "projection-collision": ["keep_with_changes", "drop"],
}


def finding(title, *, location="code.py:1", proof="proof", source="code.py"):
    return audit.FindingRecord(
        title=title, finding_type="security", severity="high", locations=[location],
        preconditions=["precondition"], proof=[proof], fix_outline="fix",
        source_file=source, triage_decision=None, threat_model="confirmed actor")


def verified(value):
    return audit.VerifiedFinding(value, "reproduced", "none", {"summary": "REPRODUCED"})


def response(real, finding_value, rewrite=False):
    verdict = (
        "@@ verdict @@\nverdict: real\nthreat_model_relevant: yes\n"
        "severity: high\nreason: confirmed"
        if real else
        "@@ verdict @@\nverdict: false_positive\nthreat_model_relevant: no\n"
        "severity: low\nreason: rejected"
    )
    if not real:
        return [verdict] * 3
    title = f"rewritten {finding_value.title}" if rewrite else finding_value.title
    kind = "narrowed-security" if rewrite else finding_value.finding_type
    threat = (
        "remote actor reaches the preserved proof"
        if rewrite else finding_value.threat_model or "confirmed actor"
    )
    ruling = (f"@@ ruling @@\ntitle: {title}\ntype: {kind}\nseverity: high\n"
              f"precondition: {finding_value.preconditions[0]}\nthreat_model: {threat}\n"
              f"fix_outline: {finding_value.fix_outline}")
    return [verdict] * 3 + [ruling]


def released_phase45(scenario, state, context, first, second):
    """Run and persist the real Phase 4.5 state producer from synthetic Phase 4 input."""
    if scenario in {"keep", "rewrite", "drop"}:
        proposals = [first]
        phase4_findings = [verified(first)]
        modes = [(first, scenario)]
        statuses = {audit._finding_key(first): {"status": "verified"}}
    elif scenario == "mixed":
        third = finding(
            "verification-discarded", location="third.py:3",
            proof="third", source="third.py"
        )
        proposals = [first, second, third]
        phase4_findings = [verified(first), verified(second)]
        modes = [(first, "rewrite"), (second, "drop")]
        statuses = {
            audit._finding_key(first): {"status": "verified"},
            audit._finding_key(second): {"status": "verified"},
            audit._finding_key(third): {"status": "discarded"},
        }
    else:
        # The proposal order is deliberately hostile to greedy matching. Phase 4.5
        # rewrites the second proposal and drops the first.
        second = finding("second")
        proposals = [first, second]
        phase4_findings = [verified(second), verified(first)]
        modes = [(second, "rewrite"), (first, "drop")]
        statuses = {
            audit._finding_key(first): {"status": "verified"},
            audit._finding_key(second): {"status": "verified"},
        }

    state.proposed_findings = proposals
    state.verification_state = statuses
    state.verified_findings = phase4_findings
    state.reviewed_files = set(state.scope.mandatory_files)
    state.candidate_files = list(state.scope.mandatory_files)
    state.deep_reviewed_files = set(state.scope.mandatory_files)
    state.phase = "adjudication"
    answers = []
    for value, mode in modes:
        answers.extend(response(mode != "drop", value, mode == "rewrite"))
    forbidden = AssertionError("network/auth/inference forbidden")
    ui = audit.AuditUI(
        run_id=state.run_id, branch=state.scope.branch, commit=state.scope.commit,
        workers=1, total_files=len(state.scope.mandatory_files)
    )
    with patch.object(audit, "_call_audit_llm", side_effect=answers), \
         patch.object(socket, "socket", side_effect=forbidden), \
         patch.object(socket, "create_connection", side_effect=forbidden), \
         patch.object(socket, "getaddrinfo", side_effect=forbidden), ui:
        audit._phase45_adjudicate(state, context, ui, workers=1)

    # Synthetic Phase 5 scaffolding is separate from the Phase 4.5 lineage fields.
    state.artifact_state = {}
    for index, item in enumerate(state.verified_findings, 1):
        key = audit._finding_key(item.finding)
        state.artifact_state[key] = {
            "status": "written",
            "report_filename": f"{index:03d}-lineage.md",
            "patch_filename": f"{index:03d}-lineage.patch",
        }
    state.phase = "done"
    state.save()
    state_path = state.state_dir / state.run_id / "state.json"
    persisted_text = state_path.read_text(encoding="utf-8")
    persisted = json.loads(persisted_text)

    # Assert that the persisted producer output, not a reconstructed record, has
    # the expected released behavior before exporting it to the TypeScript test.
    if scenario == "keep":
        assert persisted["verified_findings"][0]["finding"] == asdict(first)
    elif scenario == "rewrite":
        rewritten = persisted["verified_findings"][0]["finding"]
        preserved = ("locations", "proof", "source_file", "triage_decision")
        assert rewritten["title"] == "rewritten first"
        assert [rewritten[field] for field in preserved] == [
            asdict(first)[field] for field in preserved
        ]
    elif scenario == "drop":
        assert not persisted["verified_findings"] and len(persisted["adjudication_discarded"]) == 1
    else:
        assert len(persisted["verified_findings"]) == 1
        assert len(persisted["adjudication_discarded"]) == 1
    return {
        "producer": {
            "package": "swival",
            "version": version("swival"),
            "audit_sha256": hashlib.sha256(Path(audit.__file__).read_bytes()).hexdigest(),
            "lineage_function": "swival.audit._phase45_adjudicate",
            "persistence_function": "swival.audit.AuditRunState.save",
            "stubbed_boundary": "swival.audit._call_audit_llm",
        },
        "provenance": {
            "initial_verification": "synthetic proposed/verified/status inputs",
            "lineage_outputs": "actual Phase 4.5 verified_findings and adjudication_discarded",
            "artifact_state": "synthetic post-Phase-4.5 artifact scaffolding",
        },
        "released_decisions": _EXPECTED_DECISIONS[scenario],
        "persisted_state": persisted,
        "persisted_state_text": persisted_text,
        "verified_keys": list(persisted["artifact_state"]),
        "persistence": {
            "source": "persisted-state.json",
            "save_calls": 1,
            "bytes": len(persisted_text.encode()),
            "sha256": hashlib.sha256(persisted_text.encode()).hexdigest(),
        },
    }


def corpus(scenario):
    first = finding("first")
    second = finding("second", location="other.py:2", proof="other", source="other.py")
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "code.py").write_text("value = 1\n", encoding="utf-8")
        (root / "other.py").write_text("value = 2\n", encoding="utf-8")
        subprocess.run(["git", "init", "--template="], cwd=root, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                        "add", "."], cwd=root, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                        "commit", "-m", "fixture"], cwd=root, check=True, stdout=subprocess.DEVNULL)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True,
                                text=True, stdout=subprocess.PIPE).stdout.strip()
        state = audit.AuditRunState("lineage", audit.AuditScope("master", commit,
                                    ["code.py", "other.py"], ["code.py", "other.py"], []),
                                    ["code.py", "other.py"], state_dir=root / ".state")
        context = SimpleNamespace(base_dir=str(root))
        if scenario in _POSITIVE_SCENARIOS:
            return released_phase45(scenario, state, context, first, second)

        proposals = [first]
        statuses = {audit._finding_key(first): {"status": "verified"}}
        survivors = []
        drops = []
        if scenario == "unlinked":
            survivors = [verified(second)]
        elif scenario == "discarded-survivor":
            statuses[audit._finding_key(first)]["status"] = "discarded"
            survivors = [verified(first)]
        elif scenario == "vanished":
            pass
        elif scenario == "fabricated-drop":
            drops = [{"title": "fabricated", "severity": "critical",
                      "source_file": "fabricated.py", "reason": "fabricated"}]
        elif scenario == "malformed-drop":
            drops = ["not-a-record"]
        elif scenario == "malformed-drop-missing":
            drops = [{"title": first.title, "severity": first.severity,
                      "source_file": first.source_file}]
        elif scenario == "malformed-drop-extra":
            drops = [{"title": first.title, "severity": first.severity,
                      "source_file": first.source_file, "reason": "rejected", "extra": "field"}]
        elif scenario == "malformed-drop-type":
            drops = [{"title": first.title, "severity": first.severity,
                      "source_file": first.source_file, "reason": 7}]
        elif scenario == "mismatched-drop":
            drops = [{"title": "other", "severity": first.severity,
                      "source_file": first.source_file, "reason": "rejected"}]
        elif scenario == "extra-drop":
            survivors = [verified(first)]
            drops = [{"title": "extra", "severity": "high",
                      "source_file": "extra.py", "reason": "rejected"}]
        elif scenario == "overlap-reuse":
            proposals = [first, second]
            statuses = {
                audit._finding_key(item): {"status": "verified"}
                for item in proposals
            }
            survivors = [verified(finding("rewritten first"))]
            drops = [{"title": first.title, "severity": first.severity,
                      "source_file": first.source_file, "reason": "duplicate allocation"}]
        elif scenario == "proposal-limit":
            proposals = [finding(f"limit-{index}") for index in range(513)]
            statuses = {
                audit._finding_key(item): {"status": "verified"}
                for item in proposals
            }
            survivors = [verified(item) for item in proposals]
        elif scenario == "null-drops":
            statuses[audit._finding_key(first)]["status"] = "discarded"
            drops = None
        else:
            raise ValueError("unknown lineage scenario")
    return {
        "producer": {
            "package": "synthetic-invalid-lineage",
            "version": 1,
            "lineage_function": "handwritten-negative-state",
        },
        "provenance": {
            "initial_verification": "synthetic",
            "lineage_outputs": "synthetic invalid state",
            "artifact_state": "synthetic",
        },
        "released_decisions": [],
        "proposed_findings": [asdict(item) for item in proposals],
        "verification_state": statuses,
        "verified_findings": [{"finding": asdict(item.finding),
                                "correctness_reason": item.correctness_reason,
                                "rebuttal_reason": item.rebuttal_reason,
                                "reproducer": item.reproducer} for item in survivors],
        "verified_keys": [audit._finding_key(item.finding) for item in survivors],
        "adjudication_discarded": drops,
    }


if __name__ == "__main__":
    print(json.dumps(corpus(sys.argv[1])))
