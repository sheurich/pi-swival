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


def synthetic_profile_identity(config="/trusted/config"):
    pack = f"{config}/nono/packages/jedisct1/swival"
    return {"config": config, "pack": pack,
            "manifest": {"path": f"{pack}/package.json", "bytes": 1,
                         "sha256": "2" * 64},
            "profile": {"path": f"{pack}/profiles/swival.json", "bytes": 1,
                        "sha256": "3" * 64}}


def write_local_profile_pack(home, *, include_manifest=True, include_profile=True):
    """Create only the loader inputs, without a parent package lockfile."""
    pack = home / ".config" / "nono" / "packages" / "jedisct1" / "swival"
    profiles = pack / "profiles"
    profiles.mkdir(parents=True)
    if include_manifest:
        (pack / "package.json").write_text(json.dumps({
            "schema_version": 1, "name": "swival",
            "artifacts": [{"type": "profile", "path": "policy.json",
                           "install_as": "swival"}],
        }), encoding="utf-8")
    if include_profile:
        (profiles / "swival.json").write_text(
            json.dumps({"extends": "default", "meta": {"name": "swival"}}),
            encoding="utf-8")
    return pack


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

    def test_local_profile_rejects_stale_lockfile_missing_and_unsafe_inputs(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve() / "home"
            home.mkdir()
            pack = write_local_profile_pack(home, include_manifest=False)
            (pack.parent.parent / "lockfile.json").write_text(
                json.dumps({"packages": {"jedisct1/swival": {}}}), encoding="utf-8")
            with patch.dict(os.environ, {"HOME": str(home)}, clear=False):
                os.environ.pop("XDG_CONFIG_HOME", None)
                with self.assertRaises(bridge.NativeAuditError):
                    bridge.validate_nono_profile_identity()
                (pack / "package.json").write_text(json.dumps({
                    "schema_version": 1, "name": "swival",
                    "artifacts": [{"type": "profile", "path": "policy.json",
                                   "install_as": "swival"}],
                }), encoding="utf-8")
                (pack / "profiles" / "swival.json").unlink()
                with self.assertRaises(bridge.NativeAuditError):
                    bridge.validate_nono_profile_identity()
                outside = home / "outside-profile.json"
                outside.write_text("{}", encoding="utf-8")
                (pack / "profiles" / "swival.json").symlink_to(outside)
                with self.assertRaises(bridge.NativeAuditError):
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
