"""Fixed offline transport plus reached hostile writes in the actual native payload."""
# pylint: disable=import-outside-toplevel,protected-access,missing-function-docstring
import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import time


# Keep reached writes, namespace identity and descendant creation in one canary.
# pylint: disable-next=too-many-locals,too-many-branches,too-many-statements
def canary(request):
    """Only snapshot/evidence persist; record every reached operation and errno."""
    snapshot = Path(request['snapshot'])
    evidence = Path(request['evidence'])
    source = Path(request['source'])
    common = Path(request['sourceGitDir'])
    outside = [source/'src/code.py', common/'config', source/'nested/sentinel',
               Path('/srv/native-verification/bwrap-alias/sentinel'),
               source.parent/'source-prefix/sentinel',
               Path('/srv/native-verification/bwrap-hardlink'),
               Path('/srv/native-verification/bwrap-source-link/src/code.py')]
    records = []
    assert (source/'src/code.py').read_text(encoding='utf-8') == 'def answer(): return 42\n'
    assert '[core]' in (common/'config').read_text(encoding='utf-8')
    assert (source/'nested/sentinel').read_text(encoding='utf-8') == 'original\n'
    if Path('/srv/native-verification/hold-propagation').exists():
        (evidence/'propagation-final-ready').write_text('ready', encoding='utf-8')
        deadline = time.monotonic() + 5
        while not (evidence/'propagation-release').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert (evidence/'propagation-release').exists(), 'Propagation injection was not released'
    incoming = source/'nested/incoming/sentinel'
    assert not incoming.exists(), 'A later outside mount propagated into the private namespace'
    records.append({'operation':'later-shared-mount', 'visible':False})
    host_pid = int(os.environ['PI_SWIVAL_TEST_OUTSIDE_PID'])
    outside.extend([Path(f'/proc/{host_pid}/root')/str(source/'src/code.py').lstrip('/'),
                    Path(f'/proc/{host_pid}/cwd/src/code.py'),
                    Path(f'/proc/{host_pid}/fd/3')])
    for fd in range(3, 16):
        try:
            os.fstat(fd)
        except OSError as error:
            assert error.errno == errno.EBADF
        else:
            raise AssertionError('Payload inherited private control descriptor')
    for file in outside + [Path('/proc/1/root')/str(source/'src/code.py').lstrip('/'),
                           Path('/proc/1/cwd/../request.json')]:
        try:
            if str(file).startswith('/tmp/') and 'source-prefix' in str(file):
                file.parent.mkdir(parents=True, exist_ok=True)
            with file.open('a', encoding='utf-8') as stream:
                stream.write('outside-write')
        except OSError as error:
            records.append({'operation':'append', 'path':str(file), 'errno':error.errno})
        else:
            # A prefix outside the rebound original under /tmp is private, not denial.
            assert str(file).startswith('/tmp/') and 'source-prefix' in str(file)
            records.append({'operation':'append', 'path':str(file), 'privateWrite':True})
    link = snapshot/'symlink-to-original'
    link.symlink_to(source/'src/code.py')
    try:
        link.write_text('outside-write')
    except OSError as error:
        records.append({'operation':'symlink-write', 'errno':error.errno})
    else:
        raise AssertionError('Symlink outside write succeeded')
    link.unlink()
    try:
        os.link(source/'src/code.py', snapshot/'hardlink-to-original')
    except OSError as error:
        records.append({'operation':'hardlink', 'errno':error.errno})
    else:
        raise AssertionError('Outside inode entered writable snapshot')
    assert not Path('/dev/shm/native-bwrap-outside').exists()
    for file in [snapshot/'positive', evidence/'positive', Path('/tmp/private-positive'),
                 Path('/var/tmp/private-positive'), Path('/dev/shm/private-positive')]:
        file.write_text('positive', encoding='utf-8')
        records.append({'operation':'positive-write', 'path':str(file)})
    worktree = snapshot/'.swival/positive-worktree'
    subprocess.run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', 'worktree',
                    'add', '--detach', str(worktree), 'HEAD'], cwd=snapshot,
                   check=True, capture_output=True, timeout=5)
    (worktree/'positive').write_text('positive', encoding='utf-8')
    records.append({'operation':'independent-git-worktree-write', 'written':True})
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.mount(None, b'/', None, 32 | 4096, None)
    assert result == -1
    records.append({'operation':'remount', 'errno':ctypes.get_errno()})
    try:
        os.unshare(os.CLONE_NEWUSER)  # pylint: disable=no-member
    except OSError as error:
        records.append({'operation':'nested-userns', 'errno':error.errno})
    else:
        raise AssertionError('Nested user namespace succeeded')
    # proc descriptors must expose no outside writable files or control channels.
    records.append({'operation':'proc-fds', 'self':os.listdir('/proc/self/fd'),
                    'init':os.listdir('/proc/1/fd')})
    namespace = os.readlink('/proc/self/ns/pid')
    # setsid plus double-fork escapes process groups, not this PID namespace.
    pid = os.fork()
    if pid == 0:
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for fd in (0, 1, 2):
            os.close(fd)
        while True:
            (evidence/'descendant-heartbeat').write_text(str(time.monotonic()), encoding='utf-8')
            time.sleep(0.02)
    os.waitpid(pid, 0)
    status_lines = Path('/proc/self/status').read_text(encoding='utf-8').splitlines()
    (evidence/'boundary-canary.json').write_text(json.dumps({
        'reached':records, 'namespace':namespace, 'pid':os.getpid(), 'ppid':os.getppid(),
        'status':[line for line in status_lines
                  if line.startswith(('Cap','NoNewPrivs'))]}), encoding='utf-8')


def install(request):
    """Stub transport only; run real Session, route guards, bwrap, and handler bytes."""
    import litellm
    from swival import agent, audit
    agent.resolve_provider = lambda *_args, **_kwargs: (
        'offline-model', 'http://127.0.0.1:1234', None, 128000, {'provider':'lmstudio'})
    reached = []

    def completion(**kwargs):
        assert kwargs['model'] == 'openai/offline-model'
        assert kwargs['api_base'] == 'http://127.0.0.1:1234/v1'
        (Path(request['evidence'])/'offline-transport-reached').write_text('reached')
        if not reached:
            canary(request)
            reached.append(True)
        if Path('/srv/native-verification/hold-offline').exists():
            time.sleep(30)
        text = (audit._PHASE1_WORKED_EXAMPLE if
                kwargs['messages'][0]['content'].startswith('You are preparing')
                else '@@ none @@')
        return litellm.ModelResponse(choices=[{'message':{'role':'assistant','content':text},
                                             'finish_reason':'stop'}])

    litellm.completion = completion
