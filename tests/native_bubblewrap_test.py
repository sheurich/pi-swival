"""Offline bubblewrap boundary and no-automatic-login regressions."""
# pylint: disable=import-outside-toplevel,protected-access,missing-function-docstring
import contextlib
import errno
import importlib.util
import io
import json
import operator
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
SPEC = importlib.util.spec_from_file_location(
    'native_bridge', Path(__file__).resolve().parents[1] / 'scripts/native_audit.py')
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class NativeBubblewrapTests(unittest.TestCase):
    """Named controls use fixed synthetic inputs, no credentials or HTTP."""

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

    def test_probe_revalidates_both_launchers_before_supervisor(self):
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
