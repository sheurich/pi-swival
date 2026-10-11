"""Offline bubblewrap boundary and no-automatic-login regressions."""
# pylint: disable=import-outside-toplevel,protected-access,missing-function-docstring
import contextlib
import errno
import hashlib
import importlib.util
import io
import json
import operator
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
SPEC = importlib.util.spec_from_file_location(
    'native_bridge', Path(__file__).resolve().parents[1] / 'scripts/native_audit.py')
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


REVIEWED_PACK_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "nono-swival-0.1.2"
REVIEWED_MANIFEST_BYTES = REVIEWED_PACK_FIXTURE.joinpath("package.json").read_bytes()
REVIEWED_PROFILE_BYTES = REVIEWED_PACK_FIXTURE.joinpath("policy.json").read_bytes()
REVIEWED_PROFILE_ARTIFACTS = {
    "manifest": {"bytes": 968,
                 "sha256": "c4873794dd83781a1309f4bbb5ca37c285d19728dcfc5be4c90edc748165dbd2"},
    "profile": {"bytes": 1747,
                "sha256": "719a0a2396377cc9d05b2a9d4d2f39d8c0f07ba5080ff96e1619806794bf338c"},
}
REVIEWED_DEFAULT_POLICY_IDENTITY = {
    "name": "default", "source": "authenticated-nono-0.79.0-embedded-policy",
    "extends": [],
    "nonoSha256": "667fdaea93f77c9f8f45b04a80f4e2fb7e7d7fb104fa1da189ea38f41fbcf57b",
}


def synthetic_profile_identity(config="/trusted/config"):
    """Build a path-only unit mock around the reviewed byte identities."""
    pack = f"{config}/nono/packages/jedisct1/swival"
    return {"config": config, "pack": pack,
            "manifest": {"path": f"{pack}/package.json",
                         **REVIEWED_PROFILE_ARTIFACTS["manifest"]},
            "profile": {"path": f"{pack}/profiles/swival.json",
                        **REVIEWED_PROFILE_ARTIFACTS["profile"]},
            "defaultPolicy": dict(REVIEWED_DEFAULT_POLICY_IDENTITY)}


def write_local_profile_pack(home, *, include_manifest=True, include_profile=True):
    """Install exact reviewed source subjects at their nono loader paths."""
    pack = home / ".config" / "nono" / "packages" / "jedisct1" / "swival"
    profiles = pack / "profiles"
    profiles.mkdir(parents=True)
    if include_manifest:
        (pack / "package.json").write_bytes(REVIEWED_MANIFEST_BYTES)
    if include_profile:
        (profiles / "swival.json").write_bytes(REVIEWED_PROFILE_BYTES)
    return pack


def write_default_override(home, route, policy):
    """Create one real nono 0.79.0 lookup route for the inherited default."""
    config = home / ".config" / "nono"
    selected = config / "packages" / "jedisct1" / "swival"
    contents = json.dumps(policy)
    if route == "sibling":
        (selected / "profiles" / "default.json").write_text(contents, encoding="utf-8")
    elif route in {"user-jsonc", "user-json"}:
        profiles = config / "profiles"
        profiles.mkdir(parents=True, exist_ok=True)
        suffix = ".jsonc" if route == "user-jsonc" else ".json"
        profiles.joinpath(f"default{suffix}").write_text(contents, encoding="utf-8")
    elif route in {"pack-install-as", "pack-alias"}:
        pack = config / "packages" / "attacker" / route
        (pack / "profiles").mkdir(parents=True)
        install_as = "default" if route == "pack-install-as" else "innocent"
        aliases = [] if route == "pack-install-as" else ["default"]
        (pack / "package.json").write_text(json.dumps({
            "schema_version": 1, "name": route,
            "artifacts": [{"type": "profile", "path": "policy.json",
                           "install_as": install_as, "aliases": aliases}],
        }), encoding="utf-8")
        (pack / "profiles" / f"{install_as}.json").write_text(contents, encoding="utf-8")
    else:
        raise AssertionError(f"unknown override route: {route}")


# Identity, boundary, and auth controls share one release-pinned fixture.
# pylint: disable-next=too-many-public-methods
class NativeBubblewrapTests(unittest.TestCase):
    """Named controls use fixed synthetic inputs, no credentials or HTTP."""

    @staticmethod
    def synthetic_nono(root, machine=183):
        """Build inert ELF-shaped bytes; this fixture is not a live artifact proof."""
        executable = Path(root).resolve() / "nono"
        content = bytearray(96)
        content[:7] = b"\x7fELF\x02\x01\x01"
        content[16:18] = (2).to_bytes(2, "little")
        content[18:20] = machine.to_bytes(2, "little")
        executable.write_bytes(content)
        executable.chmod(0o755)
        identity = {**bridge.NONO_ARTIFACT_IDENTITY, "bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest()}
        return executable, identity

    def test_safe_authenticated_nono_identity_uses_version_only_after_bytes(self):
        validate = getattr(bridge, "validate_nono_identity", None)
        self.assertTrue(callable(validate), "nono needs pre-execution artifact authentication")
        with tempfile.TemporaryDirectory() as root:
            executable, identity = self.synthetic_nono(root)
            missing = OSError(errno.ENODATA, "no capabilities")
            with patch.object(bridge, "NONO_ARTIFACT_IDENTITY", identity), \
                 patch.object(bridge.os, "getxattr", side_effect=missing, create=True), \
                 patch.object(bridge.os, "uname",
                              return_value=SimpleNamespace(machine="arm64")), \
                 patch.object(bridge, "_nono_version",
                              return_value="nono 0.79.0") as version:
                actual = bridge.validate_nono_identity(str(executable))
            self.assertEqual(actual, {"path": str(executable), **identity})
            version.assert_called_once_with(executable)

    def test_nono_rejects_unknown_hash_architecture_and_version(self):
        for failure in ("hash", "architecture", "version"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                executable, identity = self.synthetic_nono(
                    root, machine=62 if failure == "architecture" else 183)
                if failure == "hash":
                    identity["sha256"] = "0" * 64
                missing = OSError(errno.ENODATA, "no capabilities")
                version_value = "nono 9.9.9" if failure == "version" else "nono 0.79.0"
                with patch.object(bridge, "NONO_ARTIFACT_IDENTITY", identity), \
                     patch.object(bridge.os, "getxattr", side_effect=missing, create=True), \
                     patch.object(bridge.os, "uname",
                                  return_value=SimpleNamespace(machine="arm64")), \
                     patch.object(bridge, "_nono_version",
                                  return_value=version_value) as version, \
                     self.assertRaisesRegex(bridge.NativeAuditError, failure):
                    bridge.validate_nono_identity(str(executable))
                if failure == "version":
                    version.assert_called_once_with(executable)
                else:
                    version.assert_not_called()

    def test_nono_rejects_unsafe_owner_mode_ancestry_and_noncanonical_entry(self):
        for failure in ("owner", "group-write", "privilege", "ancestor", "symlink"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                executable, identity = self.synthetic_nono(root)
                selected = executable
                uid = os.getuid()
                if failure == "owner":
                    uid += 10000
                elif failure == "group-write":
                    executable.chmod(0o775)
                elif failure == "privilege":
                    executable.chmod(0o4755)
                elif failure == "ancestor":
                    Path(root).chmod(0o777)
                elif failure == "symlink":
                    selected = Path(root) / "nono-entry"
                    selected.symlink_to(executable)
                with patch.object(bridge, "NONO_ARTIFACT_IDENTITY", identity), \
                     patch.object(bridge.os, "getuid", return_value=uid), \
                     patch.object(bridge, "_nono_version") as version, \
                     self.assertRaises(bridge.NativeAuditError):
                    bridge.validate_nono_identity(str(selected))
                version.assert_not_called()

    def test_nono_capability_inspection_has_no_fallback(self):
        cases = (
            ("absent-api", None),
            ("present", b""),
            ("unverifiable", OSError(errno.EOPNOTSUPP, "unsupported")),
        )
        for name, outcome in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                executable, identity = self.synthetic_nono(root)
                capability = (patch.object(bridge.os, "getxattr", None, create=True)
                              if outcome is None else
                              patch.object(bridge.os, "getxattr",
                                           side_effect=outcome if isinstance(outcome, OSError)
                                           else None, return_value=outcome, create=True))
                with patch.object(bridge, "NONO_ARTIFACT_IDENTITY", identity), capability, \
                     patch.object(bridge, "_nono_version") as version, \
                     self.assertRaisesRegex(bridge.NativeAuditError, "capabilit"):
                    bridge.validate_nono_identity(str(executable))
                version.assert_not_called()

    def test_identity_process_stop_never_signals_an_already_reaped_process(self):
        process = SimpleNamespace(returncode=0, pid=123, kill=Mock(), wait=Mock())
        with patch.object(bridge.os, "killpg") as kill_group:
            bridge._stop_identity_process(process)
        kill_group.assert_not_called()
        process.kill.assert_not_called()
        process.wait.assert_not_called()

    def test_nono_version_query_has_fixed_argv_timeout_and_output_cap(self):
        """Exercise only the inert command helper, not artifact authentication."""
        with tempfile.TemporaryDirectory() as root:
            executable = Path(root).resolve() / "nono"
            executable.write_text(
                f"#!{sys.executable}\nimport os, sys\n"
                "assert sys.argv[1:] == ['--version']\n"
                "assert os.environ.get('NONO_NO_UPDATE_CHECK') == '1'\n"
                "print('nono 0.79.0')\n")
            executable.chmod(0o755)
            self.assertEqual(bridge._nono_version(executable), "nono 0.79.0")
            executable.write_text(
                f"#!{sys.executable}\nprint('x' * {bridge._NONO_OUTPUT_LIMIT + 1})\n")
            with self.assertRaises(bridge.NativeAuditError):
                bridge._nono_version(executable)
            executable.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(1)\n")
            with patch.object(bridge, "_NONO_COMMAND_TIMEOUT", 0.05), \
                 self.assertRaises(bridge.NativeAuditError):
                bridge._nono_version(executable)

    def test_local_profile_uses_default_store_without_lockfile(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            pack = write_local_profile_pack(home)
            for target in (pack / "package.json", pack / "profiles" / "swival.json"):
                target.chmod(0o444)
            for target in (pack / "profiles", pack):
                target.chmod(0o555)
            try:
                with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
                    os.environ.pop("XDG_CONFIG_HOME", None)
                    identity = bridge.validate_nono_profile_identity()
                    self.assertEqual(identity["pack"], str(pack))
                    self.assertFalse((pack.parent.parent / "lockfile.json").exists())
                    with patch.dict(os.environ,
                                    {"XDG_CONFIG_HOME": str(home / ".config")}, clear=False):
                        self.assertEqual(bridge.validate_nono_profile_identity(), identity)
            finally:
                pack.chmod(0o755)
                (pack / "profiles").chmod(0o755)

    def test_local_profile_accepts_reviewed_source_and_installed_representations(self):
        expected = {
            role: {"bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}
            for role, contents in (("manifest", REVIEWED_MANIFEST_BYTES),
                                   ("profile", REVIEWED_PROFILE_BYTES))
        }
        self.assertEqual(expected, REVIEWED_PROFILE_ARTIFACTS)
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            pack = write_local_profile_pack(home)
            self.assertEqual((pack / "package.json").read_bytes(), REVIEWED_MANIFEST_BYTES)
            self.assertEqual((pack / "profiles" / "swival.json").read_bytes(),
                             REVIEWED_PROFILE_BYTES)
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
                os.environ.pop("XDG_CONFIG_HOME", None)
                identity = bridge.validate_nono_profile_identity()
            self.assertEqual({key: {field: identity[key][field]
                                    for field in ("bytes", "sha256")}
                              for key in ("manifest", "profile")}, expected)
            self.assertEqual(identity["defaultPolicy"], REVIEWED_DEFAULT_POLICY_IDENTITY)

    def test_local_profile_rejects_unreviewed_policy_capabilities_without_execution(self):
        marker = Path(tempfile.gettempdir()) / "native-profile-hook-must-not-run"
        marker.unlink(missing_ok=True)
        reviewed = json.loads(REVIEWED_PROFILE_BYTES)
        cases = {
            "external-sandbox": {**reviewed, "linux": {"sandbox_policy": "external"}},
            "connect-port": {**reviewed, "network": {"block": False,
                                                       "connect_port": [443]}},
            "session-hook": {**reviewed, "session_hooks": {
                "before": [f"touch {marker}"]}},
            "benign-unreviewed": {"extends": "default", "meta": {"name": "swival"}},
        }
        for name, policy in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                home = Path(root).resolve() / "home"
                home.mkdir()
                pack = write_local_profile_pack(home)
                (pack / "profiles" / "swival.json").write_text(
                    json.dumps(policy), encoding="utf-8")
                with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                     patch.object(bridge.subprocess, "Popen",
                                  side_effect=AssertionError("process execution forbidden")), \
                     patch.object(socket, "create_connection",
                                  side_effect=AssertionError("network forbidden")), \
                     self.assertRaisesRegex(bridge.NativeAuditError, "identity"):
                    os.environ.pop("XDG_CONFIG_HOME", None)
                    bridge.validate_nono_profile_identity()
        self.assertFalse(marker.exists())

    def test_local_profile_rejects_selected_subject_byte_substitution_before_parsing(self):
        manifest = json.loads(REVIEWED_MANIFEST_BYTES)
        changed_artifact = json.loads(REVIEWED_MANIFEST_BYTES)
        changed_artifact["artifacts"][0]["install_as"] = "other"
        cases = (
            ("manifest-extra", "package.json",
             json.dumps({**manifest, "review_status": "looks-safe"}).encode()),
            ("manifest-artifact", "package.json", json.dumps(changed_artifact).encode()),
            ("manifest-malformed", "package.json", b"{"),
            ("manifest-duplicate", "package.json",
             b'{"schema_version":1,"schema_version":1,"name":"swival"}'),
            ("profile-substitution", "profiles/swival.json", REVIEWED_MANIFEST_BYTES),
            ("profile-malformed", "profiles/swival.json", b"{"),
            ("profile-duplicate", "profiles/swival.json",
             b'{"extends":"default","extends":"default"}'),
        )
        for name, relative, contents in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                home = Path(root).resolve() / "home"
                home.mkdir()
                pack = write_local_profile_pack(home)
                (pack / relative).write_bytes(contents)
                with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                     self.assertRaisesRegex(
                         bridge.NativeAuditError,
                         "Native nono local profile input identity is unsupported"):
                    os.environ.pop("XDG_CONFIG_HOME", None)
                    bridge.validate_nono_profile_identity()

    def test_default_resolver_enforces_namespace_and_total_pack_limits(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            selected = write_local_profile_pack(home)
            store = selected.parent.parent
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                 patch.object(bridge.subprocess, "Popen",
                              side_effect=AssertionError("process execution forbidden")), \
                 patch.object(socket, "create_connection",
                              side_effect=AssertionError("network forbidden")), \
                 patch.object(bridge, "_NONO_PROFILE_NAMESPACE_LIMIT", 1):
                os.environ.pop("XDG_CONFIG_HOME", None)
                self.assertEqual(bridge.validate_nono_profile_identity()["pack"],
                                 str(selected))
                (store / "other").mkdir()
                with self.assertRaisesRegex(
                        bridge.NativeAuditError,
                        "^Native nono default profile resolver exceeded its limit\\.$"):
                    bridge.validate_nono_profile_identity()
            self.assertEqual((selected / "package.json").read_bytes(),
                             REVIEWED_MANIFEST_BYTES)

        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            selected = write_local_profile_pack(home)
            store = selected.parent.parent
            (store / "alpha" / "one").mkdir(parents=True)
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                 patch.object(bridge.subprocess, "Popen",
                              side_effect=AssertionError("process execution forbidden")), \
                 patch.object(socket, "create_connection",
                              side_effect=AssertionError("network forbidden")), \
                 patch.object(bridge, "_NONO_PROFILE_PACK_LIMIT", 2):
                os.environ.pop("XDG_CONFIG_HOME", None)
                self.assertEqual(bridge.validate_nono_profile_identity()["pack"],
                                 str(selected))
                (store / "beta" / "two").mkdir(parents=True)
                with self.assertRaisesRegex(
                        bridge.NativeAuditError,
                        "^Native nono default profile resolver exceeded its limit\\.$"):
                    bridge.validate_nono_profile_identity()

    def test_default_resolver_enforces_manifest_and_artifact_limits(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            selected = write_local_profile_pack(home)
            other = selected.parent.parent / "other" / "manifest-limit"
            other.mkdir(parents=True)
            manifest_path = other / "package.json"
            manifest = b'{"schema_version":1,"name":"at-limit","artifacts":[]}'
            manifest_path.write_bytes(manifest.ljust(968, b" "))
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                 patch.object(bridge.subprocess, "Popen",
                              side_effect=AssertionError("process execution forbidden")), \
                 patch.object(socket, "create_connection",
                              side_effect=AssertionError("network forbidden")), \
                 patch.object(bridge, "_NONO_MANIFEST_LIMIT", 968):
                os.environ.pop("XDG_CONFIG_HOME", None)
                self.assertEqual(bridge.validate_nono_profile_identity()["pack"],
                                 str(selected))
                manifest_path.write_bytes(manifest_path.read_bytes() + b" ")
                with self.assertRaisesRegex(
                        bridge.NativeAuditError,
                        "^Native nono default profile resolver input is invalid\\.$"):
                    bridge.validate_nono_profile_identity()

        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            selected = write_local_profile_pack(home)
            other = selected.parent.parent / "other" / "artifact-limit"
            other.mkdir(parents=True)
            manifest_path = other / "package.json"

            def artifact_manifest(count):
                return json.dumps({"schema_version": 1, "name": "artifact-limit",
                                   "artifacts": [{"type": "instruction",
                                                  "path": f"item-{index}"}
                                                 for index in range(count)]})

            manifest_path.write_text(artifact_manifest(128), encoding="utf-8")
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                 patch.object(bridge.subprocess, "Popen",
                              side_effect=AssertionError("process execution forbidden")), \
                 patch.object(socket, "create_connection",
                              side_effect=AssertionError("network forbidden")):
                os.environ.pop("XDG_CONFIG_HOME", None)
                self.assertEqual(bridge.validate_nono_profile_identity()["pack"],
                                 str(selected))
                manifest_path.write_text(artifact_manifest(129), encoding="utf-8")
                with self.assertRaisesRegex(
                        bridge.NativeAuditError,
                        "^Native nono default profile resolver input is invalid\\.$"):
                    bridge.validate_nono_profile_identity()

    def test_default_resolver_rejects_namespace_and_package_symlinks(self):
        for kind in ("namespace", "package"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                home = Path(root).resolve() / "home"
                home.mkdir()
                selected = write_local_profile_pack(home)
                store = selected.parent.parent
                if kind == "namespace":
                    (store / "linked-namespace").symlink_to(
                        store / "jedisct1", target_is_directory=True)
                else:
                    namespace = store / "other"
                    namespace.mkdir()
                    (namespace / "linked-package").symlink_to(
                        selected, target_is_directory=True)
                with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                     patch.object(bridge.subprocess, "Popen",
                                  side_effect=AssertionError("process execution forbidden")), \
                     patch.object(socket, "create_connection",
                                  side_effect=AssertionError("network forbidden")), \
                     self.assertRaisesRegex(
                         bridge.NativeAuditError,
                         "^Native nono default profile resolver input is invalid\\.$"):
                    os.environ.pop("XDG_CONFIG_HOME", None)
                    bridge.validate_nono_profile_identity()
                self.assertEqual((selected / "profiles" / "swival.json").read_bytes(),
                                 REVIEWED_PROFILE_BYTES)

    def test_default_resolver_strictly_parses_third_party_manifests(self):
        cases = {
            "duplicate": b'{"schema_version":1,"name":"first","name":"second"}',
            "nan": b'{"schema_version":1,"name":"bad","value":NaN}',
            "infinity": b'{"schema_version":1,"name":"bad","value":Infinity}',
            "negative-infinity": b'{"schema_version":1,"name":"bad","value":-Infinity}',
        }
        for name, contents in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                home = Path(root).resolve() / "home"
                home.mkdir()
                selected = write_local_profile_pack(home)
                other = selected.parent.parent / "other" / name
                other.mkdir(parents=True)
                (other / "package.json").write_bytes(contents)
                with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                     patch.object(bridge.subprocess, "Popen",
                                  side_effect=AssertionError("process execution forbidden")), \
                     patch.object(socket, "create_connection",
                                  side_effect=AssertionError("network forbidden")), \
                     patch.object(bridge, "_strict_json_object",
                                  wraps=bridge._strict_json_object) as strict, \
                     self.assertRaisesRegex(
                         bridge.NativeAuditError,
                         "^Native nono default profile resolver input is invalid\\.$"):
                    os.environ.pop("XDG_CONFIG_HOME", None)
                    bridge.validate_nono_profile_identity()
                self.assertTrue(any(call_args.args[0] == contents
                                    for call_args in strict.call_args_list))

    def test_local_profile_rejects_every_default_override_route_without_execution(self):
        self.assertEqual(json.loads(REVIEWED_PROFILE_BYTES)["extends"], "default")
        routes = ("sibling", "user-jsonc", "user-json",
                  "pack-install-as", "pack-alias")
        for route in routes:
            for capability in ("external", "connect-port", "session-hook"):
                with self.subTest(route=route, capability=capability), \
                     tempfile.TemporaryDirectory() as root:
                    home = Path(root).resolve() / "home"
                    home.mkdir()
                    write_local_profile_pack(home)
                    marker = Path(root) / "inherited-hook-must-not-run"
                    policy = {
                        "external": {"linux": {"sandbox_policy": "external"}},
                        "connect-port": {"network": {"connect_port": [443]}},
                        "session-hook": {"session_hooks": {
                            "before": {"script": str(marker)}}},
                    }[capability]
                    write_default_override(home, route, policy)
                    with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                         patch.object(bridge.subprocess, "Popen",
                                      side_effect=AssertionError("hook execution forbidden")), \
                         patch.object(socket, "create_connection",
                                      side_effect=AssertionError("network forbidden")), \
                         self.assertRaisesRegex(
                             bridge.NativeAuditError,
                             "Native nono inherited default profile override is unsupported"):
                        os.environ.pop("XDG_CONFIG_HOME", None)
                        bridge.validate_nono_profile_identity()
                    self.assertFalse(marker.exists())

    def test_local_profile_rejects_ambiguous_symlink_and_malformed_default_inputs(self):
        cases = ("ambiguous-user", "sibling-symlink", "user-symlink",
                 "malformed-pack-manifest")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as root:
                home = Path(root).resolve() / "home"
                home.mkdir()
                pack = write_local_profile_pack(home)
                user_profiles = home / ".config" / "nono" / "profiles"
                if case == "ambiguous-user":
                    user_profiles.mkdir(parents=True)
                    for suffix in ("jsonc", "json"):
                        (user_profiles / f"default.{suffix}").write_text("{}", encoding="utf-8")
                elif case == "sibling-symlink":
                    outside = home / "outside-default.json"
                    outside.write_text("{}", encoding="utf-8")
                    (pack / "profiles" / "default.json").symlink_to(outside)
                elif case == "user-symlink":
                    user_profiles.mkdir(parents=True)
                    outside = home / "outside-default.json"
                    outside.write_text("{}", encoding="utf-8")
                    (user_profiles / "default.jsonc").symlink_to(outside)
                else:
                    other = home / ".config" / "nono" / "packages" / "bad" / "pack"
                    other.mkdir(parents=True)
                    (other / "package.json").write_bytes(b"{")
                expected = ("resolver input is invalid" if case == "malformed-pack-manifest"
                            else "default profile override is unsupported")
                with patch.dict(os.environ, {"HOME": str(home)}, clear=False), \
                     self.assertRaisesRegex(bridge.NativeAuditError, expected):
                    os.environ.pop("XDG_CONFIG_HOME", None)
                    bridge.validate_nono_profile_identity()

    def test_local_profile_default_resolution_drift_fails_revalidation(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            pack = write_local_profile_pack(home)
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
                os.environ.pop("XDG_CONFIG_HOME", None)
                identity = bridge.validate_nono_profile_identity()
                (pack / "profiles" / "default.json").write_text(
                    json.dumps({"network": {"connect_port": [443]}}), encoding="utf-8")
                with self.assertRaisesRegex(bridge.NativeAuditError, "default profile override"):
                    bridge._revalidate_nono_profile({"nonoProfileIdentity": identity})

    def test_local_profile_identity_pin_rejects_substitution_and_drift(self):
        reviewed = synthetic_profile_identity()
        self.assertTrue(bridge._bound_nono_profile_identity(reviewed))
        substituted = json.loads(json.dumps(reviewed))
        substituted["profile"]["sha256"] = "0" * 64
        self.assertFalse(bridge._bound_nono_profile_identity(substituted))
        substituted = json.loads(json.dumps(reviewed))
        substituted["defaultPolicy"]["source"] = "local-file"
        self.assertFalse(bridge._bound_nono_profile_identity(substituted))
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            pack = write_local_profile_pack(home)
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
                os.environ.pop("XDG_CONFIG_HOME", None)
                identity = bridge.validate_nono_profile_identity()
                (pack / "profiles" / "swival.json").write_bytes(
                    REVIEWED_PROFILE_BYTES + b"\n")
                with self.assertRaises(bridge.NativeAuditError):
                    bridge._revalidate_nono_profile({"nonoProfileIdentity": identity})

    def test_local_profile_rejects_stale_lockfile_missing_and_unsafe_inputs(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            pack = write_local_profile_pack(home, include_manifest=False)
            (pack.parent.parent / "lockfile.json").write_text(
                json.dumps({"packages": {"jedisct1/swival": {}}}), encoding="utf-8")
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
                os.environ.pop("XDG_CONFIG_HOME", None)
                with self.assertRaisesRegex(
                        bridge.NativeAuditError,
                        "Native nono local profile input is unavailable\\."):
                    bridge.validate_nono_profile_identity()
                (pack / "package.json").write_bytes(REVIEWED_MANIFEST_BYTES)
                (pack / "profiles" / "swival.json").unlink()
                with self.assertRaisesRegex(
                        bridge.NativeAuditError,
                        "Native nono local profile input is unavailable\\."):
                    bridge.validate_nono_profile_identity()
                outside = home / "outside-profile.json"
                outside.write_text("{}", encoding="utf-8")
                (pack / "profiles" / "swival.json").symlink_to(outside)
                with self.assertRaisesRegex(
                        bridge.NativeAuditError,
                        "Native nono local profile path is not canonical\\."):
                    bridge.validate_nono_profile_identity()

    def test_local_profile_rejects_ambiguous_profile_artifacts(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            pack = write_local_profile_pack(home)
            (pack / "profiles" / "other.json").write_text("{}", encoding="utf-8")
            (pack / "package.json").write_text(json.dumps({
                "schema_version": 1, "name": "swival",
                "artifacts": [
                    {"type": "profile", "path": "other.json", "install_as": "other"},
                    {"type": "profile", "path": "policy.json", "install_as": "swival"},
                ],
            }), encoding="utf-8")
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
                os.environ.pop("XDG_CONFIG_HOME", None)
                with self.assertRaises(bridge.NativeAuditError):
                    bridge.validate_nono_profile_identity()

    def test_nondefault_xdg_rejects_before_executable_or_provider_activity(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root).resolve()
            home = root_path / "home"
            alternate_home = root_path / "alternate-home"
            home.mkdir()
            alternate_home.mkdir()
            write_local_profile_pack(home)
            write_local_profile_pack(alternate_home)
            xdg = alternate_home / ".config"
            route = Mock(return_value=({}, {}))
            executable = Mock(side_effect=AssertionError("nono executable activity"))
            with patch.dict(os.environ, {"HOME": str(home),
                                         "XDG_CONFIG_HOME": str(xdg)}, clear=False), \
                 patch.object(bridge, "resolve_native_config", route), \
                 patch.object(bridge, "_nono_version", executable), \
                 patch.object(bridge.sys, "argv", ["native_audit.py", "--preflight"]), \
                 patch.object(bridge.sys, "stdin", io.StringIO("{}")), \
                 self.assertRaises(bridge.NativeAuditError):
                bridge.main()
            route.assert_called_once_with({})
            executable.assert_not_called()

    def test_bound_nono_sdk_suppresses_the_released_unbounded_package_query(self):
        from swival import sandbox_nono

        with tempfile.TemporaryDirectory() as root:
            executable = Path(root).resolve() / "reviewed-nono"
            executable.write_bytes(b"reviewed")
            identity = {"path": str(executable), **bridge.NONO_ARTIFACT_IDENTITY}
            request = {"nono": str(executable), "nonoIdentity": identity,
                       "nonoProfileIdentity": {"pack": "/trusted/profile"}}
            with patch.object(bridge, "_revalidate_nono", return_value=identity), \
                 patch.object(bridge, "_revalidate_nono_profile") as local_profile, \
                 patch.object(sandbox_nono, "profile_pack_installed",
                              side_effect=AssertionError("unbounded SDK query")) as released:
                with self.assertRaisesRegex(RuntimeError, "session setup"):
                    with bridge._bound_nono_sdk(request):
                        self.assertTrue(sandbox_nono.profile_pack_installed(
                            str(executable), sandbox_nono.WRAPPER_PROFILE))
                        with self.assertRaises(bridge.NativeAuditError):
                            sandbox_nono.profile_pack_installed(str(executable), "other/profile")
                        with patch.object(Path, "resolve",
                                          side_effect=RuntimeError("resolution failure")), \
                             self.assertRaisesRegex(RuntimeError, "resolution failure"):
                            sandbox_nono.profile_pack_installed(
                                str(executable), sandbox_nono.WRAPPER_PROFILE)
                        raise RuntimeError("session setup")
                self.assertIs(sandbox_nono.profile_pack_installed, released)
                local_profile.side_effect = RuntimeError("profile failure")
                with self.assertRaisesRegex(RuntimeError, "profile failure"):
                    with bridge._bound_nono_sdk(request):
                        self.fail("unexpected profile failure was swallowed")
                self.assertIs(sandbox_nono.profile_pack_installed, released)
            self.assertEqual(local_profile.call_args_list,
                             [call(request, host_path=False),
                              call(request, host_path=False)])
            released.assert_not_called()

    def test_sdk_nono_resolution_accepts_only_the_bound_canonical_target(self):
        from swival import sandbox_nono

        with tempfile.TemporaryDirectory() as root:
            canonical_root = Path(root).resolve()
            expected = canonical_root / "reviewed-nono"
            alternate = canonical_root / "alternate-nono"
            expected.write_bytes(b"reviewed")
            alternate.write_bytes(b"alternate")
            entry = canonical_root / "nono"
            entry.symlink_to(expected)
            with patch.object(sandbox_nono, "_find_nono", return_value=str(entry)):
                bridge._verify_sdk_nono_resolution(str(expected))
            with patch.object(sandbox_nono, "_find_nono", return_value=str(alternate)), \
                 self.assertRaisesRegex(bridge.NativeAuditError, "changed"):
                bridge._verify_sdk_nono_resolution(str(expected))

    def test_final_mountinfo_rejects_propagation_and_unknown_optional_fields(self):
        validate = getattr(bridge, '_validate_private_mountinfo', None)
        self.assertTrue(callable(validate), 'Final namespace needs a propagation guard')
        base = '1 0 0:1 / / ro - ext4 /dev/root ro\n'
        for optional in ['shared:7', 'master:9', 'propagate_from:2', 'unknown:1']:
            with self.subTest(optional=optional), self.assertRaises(bridge.NativeAuditError):
                bridge._validate_private_mountinfo(base.replace(' ro - ', ' ro '+optional+' - '))
        bridge._validate_private_mountinfo(base)
        for malformed in ['', '1 0 0:1 / relative ro - ext4 /dev/root ro',
                          '1 0 0:1 / / rw - ext4 /dev/root rw', 'not mountinfo']:
            with (self.subTest(malformed=bool(malformed)),
                  self.assertRaises(bridge.NativeAuditError)):
                bridge._validate_private_mountinfo(malformed)

    def test_final_boundary_rejection_precedes_route_session_and_transport(self):
        request = {'sandbox': 'bubblewrap', 'bwrapVersion': '0.12.0',
                   'bwrapIdentity': dict(bridge.BWRAP_IDENTITY),
                   'unshareIdentity': dict(bridge.UNSHARE_IDENTITY),
                   'nono': '/trusted/nono',
                   'nonoIdentity': {'path': '/trusted/nono',
                                    **bridge.NONO_ARTIFACT_IDENTITY},
                   'nonoProfileIdentity': synthetic_profile_identity(),
                   'sessionSandbox': 'builtin'}
        rejection = bridge.NativeAuditError('synthetic final propagation rejection')
        with patch.object(bridge.sys, 'platform', 'linux'), \
             patch.object(bridge, 'check_boundary', side_effect=rejection) as boundary, \
             patch.object(bridge, 'resolve_native_config',
                          side_effect=AssertionError('route/provider initialized')) as route:
            with self.assertRaisesRegex(bridge.NativeAuditError, 'final propagation'):
                bridge.run_native(request)
        boundary.assert_called_once_with()
        route.assert_not_called()

    def test_bwrap_identity_rejects_shadowed_and_writable_entries_without_execution(self):
        validate = getattr(bridge, 'validate_bwrap_identity', None)
        self.assertTrue(callable(validate), 'Bubblewrap needs pre-execution identity validation')
        for mode in (0o755, 0o777):
            with self.subTest(mode=oct(mode)), tempfile.TemporaryDirectory() as root:
                executable = Path(root) / 'bwrap'
                executable.write_text('#!/bin/sh\necho executed\n')
                executable.chmod(mode)
                with patch.object(bridge, '_launcher_command') as command, \
                     self.assertRaises(bridge.NativeAuditError):
                    operator.call(validate, str(executable))
                command.assert_not_called()

    def test_bwrap_identity_rejects_changed_bytes_without_execution(self):
        validate = getattr(bridge, '_validate_launcher_identity', None)
        self.assertTrue(callable(validate), 'OS launchers need a common identity validator')
        with tempfile.TemporaryDirectory() as root:
            executable = Path(root) / 'bwrap'
            executable.write_bytes(b'changed')
            identity = {**bridge.BWRAP_IDENTITY, 'path': str(executable)}
            missing = OSError(errno.ENODATA, 'no capabilities')
            with patch.object(bridge, '_trusted_root_executable',
                              return_value=(executable, SimpleNamespace(st_size=7))), \
                 patch.object(bridge.os, 'getxattr', side_effect=missing, create=True), \
                 patch.object(bridge, '_launcher_command') as command, \
                 self.assertRaisesRegex(bridge.NativeAuditError, 'hash'):
                operator.call(validate, str(executable), identity, 'bubblewrap')
            command.assert_not_called()

    def test_bwrap_identity_fails_closed_when_capability_api_is_absent(self):
        validate = getattr(bridge, '_validate_launcher_identity', None)
        self.assertTrue(callable(validate), 'OS launchers need a common identity validator')
        executable = Path('/usr/bin/bwrap')
        with patch.object(bridge, '_trusted_root_executable',
                          return_value=(executable, SimpleNamespace(st_size=1))), \
             patch.object(bridge.os, 'getxattr', None, create=True), \
             patch.object(bridge, '_launcher_command') as command, \
             self.assertRaisesRegex(bridge.NativeAuditError, 'capabilit'):
            operator.call(validate, str(executable), bridge.BWRAP_IDENTITY, 'bubblewrap')
        command.assert_not_called()

    def test_bwrap_identity_fails_closed_when_capabilities_are_present(self):
        validate = getattr(bridge, '_validate_launcher_identity', None)
        self.assertTrue(callable(validate), 'OS launchers need a common identity validator')
        executable = Path('/usr/bin/bwrap')
        with patch.object(bridge, '_trusted_root_executable',
                          return_value=(executable, SimpleNamespace(st_size=1))), \
             patch.object(bridge.os, 'getxattr', return_value=b'capability', create=True), \
             patch.object(bridge, '_launcher_command') as command, \
             self.assertRaisesRegex(bridge.NativeAuditError, 'capabilit'):
            operator.call(validate, str(executable), bridge.BWRAP_IDENTITY, 'bubblewrap')
        command.assert_not_called()

    def test_probe_revalidates_all_launchers_before_supervisor(self):
        request = {'unshare': '/usr/bin/unshare', 'bwrap': '/usr/bin/bwrap',
                   'python': '/usr/bin/python3'}
        reached = []

        def revalidate(actual):
            self.assertEqual(actual, request)
            reached.append('identities')

        def supervise(actual, _payload):
            self.assertEqual(actual, request)
            self.assertEqual(reached, ['identities'])
            reached.append('supervisor')
            return 0

        with patch.object(bridge.sys, 'argv', ['native_audit.py', '--probe']), \
             patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(request))), \
             patch.object(bridge, '_revalidate_launchers', side_effect=revalidate), \
             patch.object(bridge, 'supervise_bubblewrap', side_effect=supervise):
            bridge.main()
        self.assertEqual(reached, ['identities', 'supervisor'])

    def test_launcher_revalidation_includes_bound_nono_identity(self):
        request = {"unshare": "/usr/bin/unshare", "bwrap": "/usr/bin/bwrap",
                   "nono": "/trusted/nono",
                   "unshareIdentity": dict(bridge.UNSHARE_IDENTITY),
                   "bwrapIdentity": dict(bridge.BWRAP_IDENTITY),
                   "nonoIdentity": {"path": "/trusted/nono",
                                    **bridge.NONO_ARTIFACT_IDENTITY},
                   "nonoProfileIdentity": synthetic_profile_identity()}
        with patch.object(bridge, "validate_unshare_identity",
                          return_value=request["unshareIdentity"]), \
             patch.object(bridge, "validate_bwrap_identity",
                          return_value=request["bwrapIdentity"]), \
             patch.object(bridge, "_revalidate_nono",
                          return_value=request["nonoIdentity"]) as nono, \
             patch.object(bridge, "_revalidate_nono_profile",
                          return_value=request["nonoProfileIdentity"]) as profile:
            bridge._revalidate_launchers(request)
        nono.assert_called_once_with(request)
        profile.assert_called_once_with(request)

    def test_private_mounts_rebind_canonical_visibility_before_write_grants(self):
        build = getattr(bridge, 'bubblewrap_argv', None)
        self.assertTrue(callable(build), 'Native launch needs direct bubblewrap argv')
        request = {'bwrap': '/usr/bin/bwrap', 'snapshot': '/tmp/run/snapshot',
                   'evidence': '/tmp/run/evidence',
                   'readOnlyPaths': ['/tmp/source', '/tmp/source/.git', '/tmp/venv',
                                     '/tmp/source-prefix', '/var/tmp/config']}
        argv = bridge.bubblewrap_argv(
            request, ['/trusted/python', '-I', '-B', '/trusted/bridge', '--run'])
        self.assertNotIn('agentfs', argv)
        self.assertEqual(argv[:14], ['/usr/bin/bwrap', '--unshare-user', '--disable-userns',
                                    '--unshare-pid', '--unshare-ipc', '--die-with-parent',
                                    '--cap-drop', 'ALL', '--ro-bind', '/', '/',
                                    '--tmpfs', '/tmp', '--tmpfs'])
        private = argv.index('--dev')
        for root in request['readOnlyPaths']:
            position = next(i for i in range(len(argv)-2)
                            if argv[i:i+3] == ['--ro-bind', root, root])
            self.assertGreater(position, private)
            self.assertLess(position, argv.index('--bind'))
        self.assertEqual(argv.count('--bind'), 2)
        self.assertNotIn('/dev/fuse', argv)

    def test_exact_standard_unshare_prefix_wraps_bwrap_after_control_arguments(self):
        build = getattr(bridge, 'sandbox_argv', None)
        self.assertTrue(callable(build), 'Native launch needs the reviewed unshare prefix')
        request = {'unshare': '/usr/bin/unshare', 'bwrap': '/usr/bin/bwrap',
                   'snapshot': '/tmp/run/snapshot', 'evidence': '/tmp/run/evidence',
                   'readOnlyPaths': []}
        argv = bridge.sandbox_argv(request, ['/trusted/python', '--run'], 11, 12)
        self.assertEqual(argv[:8], ['/usr/bin/unshare', '--user', '--map-current-user',
                                   '--mount', '--propagation', 'private', '--',
                                   '/usr/bin/bwrap'])
        separator = argv.index('--', 8)
        self.assertEqual(argv[separator-4:separator],
                         ['--info-fd', '11', '--block-fd', '12'])
        self.assertEqual(argv[separator+1:], ['/trusted/python', '--run'])
        for forbidden in ('--keep-caps', '--fork', '--mount-proc', '--setuid', '--setgid'):
            self.assertNotIn(forbidden, argv[:8])

    def test_final_boundary_requires_all_five_zero_capability_sets(self):
        validate = getattr(bridge, '_validate_status_boundary', None)
        self.assertTrue(callable(validate), 'Final boundary must validate every capability set')
        fields = {'NoNewPrivs': '\t1', 'CapEff': '\t0', 'CapPrm': '\t0',
                  'CapInh': '\t0', 'CapAmb': '\t0', 'CapBnd': '\t0'}
        bridge._validate_status_boundary(fields)
        for capability in ('CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd'):
            with self.subTest(capability=capability), self.assertRaises(bridge.NativeAuditError):
                bridge._validate_status_boundary({**fields, capability: '\t1'})

    def test_rebinding_a_private_mount_root_fails_closed(self):
        for root in ['/', '/tmp', '/var/tmp', '/dev', '/proc', '/dev/shm']:
            with self.subTest(root=root), self.assertRaises(bridge.NativeAuditError):
                bridge.bubblewrap_argv({'bwrap': '/usr/bin/bwrap', 'readOnlyPaths': [root]},
                                      ['/trusted/python'])

    def test_chatgpt_valid_token_is_read_only_and_does_not_use_http(self):
        from litellm.llms.chatgpt.authenticator import Authenticator
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'auth.json'
            data = {'access_token': 'synthetic-token', 'expires_at': time.time()+3600,
                    'account_id': 'synthetic-account'}
            file.write_text(json.dumps(data))
            auth = object.__new__(Authenticator)
            auth.auth_file = str(file)
            route = bridge._route_binding({'provider': 'chatgpt', 'model': 'gpt-offline'}, None)
            with patch.object(Authenticator, '_request_device_code') as login, \
                 patch.object(Authenticator, '_refresh_tokens') as refresh, \
                 bridge._bound_transport(route):
                self.assertEqual(auth.get_access_token(), 'synthetic-token')
                self.assertEqual(auth.get_account_id(), 'synthetic-account')
            login.assert_not_called()
            refresh.assert_not_called()
            self.assertEqual(json.loads(file.read_text()), data)

    def test_chatgpt_missing_malformed_expired_and_incomplete_auth_fail_before_login(self):
        from litellm.llms.chatgpt.authenticator import Authenticator
        for text in [None, '{', '{}', json.dumps({'access_token': 'synthetic-token',
                      'expires_at': time.time()-1, 'refresh_token': 'synthetic-refresh'}),
                     json.dumps({'access_token': 'synthetic-token'})]:
            with self.subTest(case=text is None), tempfile.TemporaryDirectory() as root:
                file = Path(root) / 'auth.json'
                if text is not None:
                    file.write_text(text)
                auth = object.__new__(Authenticator)
                auth.auth_file = str(file)
                output = io.StringIO()
                route = bridge._route_binding({'provider': 'chatgpt', 'model': 'gpt-offline'}, None)
                with patch.object(Authenticator, '_request_device_code',
                                  side_effect=AssertionError('HTTP forbidden')) as login, \
                     patch.object(Authenticator, '_refresh_tokens',
                                  side_effect=AssertionError('Refresh forbidden')) as refresh, \
                     contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    with self.assertRaises(bridge.NativeAuditError), bridge._bound_transport(route):
                        auth.get_access_token()
                login.assert_not_called()
                refresh.assert_not_called()
                self.assertEqual(output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
