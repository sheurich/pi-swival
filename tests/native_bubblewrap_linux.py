"""Repeatable Linux registered-handler containment/lifecycle gate, without inference.

Requires the pinned disposable /srv/native-verification test installation. Run as
its audit user after fixed root-only mount preparation. Source is an immutable
inventoried copy selected at test startup, never a changing checkout.
"""
# pylint: disable=import-outside-toplevel,missing-function-docstring
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/srv/native-verification')
SOURCE = Path(os.environ['PI_SWIVAL_TEST_SOURCE']).resolve()
assert SOURCE.parent == ROOT and SOURCE.name.startswith('source-')
SPEC = importlib.util.spec_from_file_location('pinned_setup', ROOT/'setup_guest.py')
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)
setup.ENV['PI_SWIVAL_TEST_SOURCE'] = str(SOURCE)
setup.ENV['PI_SWIVAL_TEST_OUTSIDE_PID'] = str(os.getpid())
NODE = str(setup.NODE)
GIT = '/usr/bin/git'


def run(args, **kwargs):
    return setup.run(args, timeout=kwargs.pop('timeout', 15), cap=64*1024, **kwargs)


def hashes():
    files = []
    for source in [ROOT/'bwrap-fixture/source', Path('/tmp/native-bwrap-fixture/source')]:
        files.extend([source/'src/code.py', source/'nested/sentinel',
                      source.parent/'common-git/config', source.parent/'source-prefix/sentinel'])
    files.extend([ROOT/'bwrap-alias/sentinel', ROOT/'bwrap-hardlink',
                  Path('/dev/shm/native-bwrap-outside')])
    return {str(file):hashlib.sha256(file.read_bytes()).hexdigest() for file in files}


def prepare():
    """Create committed fixtures; no source locations move outside private temp."""
    for source in [ROOT/'bwrap-fixture/source', Path('/tmp/native-bwrap-fixture/source')]:
        (source/'src').mkdir(parents=True, exist_ok=True)
        (source/'src/code.py').write_text('def answer(): return 42\n')
        if (source/'.git').exists():
            continue
        run([GIT,'init','--template=', '--separate-git-dir',str(source.parent/'common-git')],
            cwd=source)
        run([GIT,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','add','src'],
            cwd=source)
        run([GIT,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',
             '-c','user.name=Synthetic','-c','user.email=audit@example.invalid',
             'commit','-m','synthetic fixture'],cwd=source)
    original = ROOT/'bwrap-fixture/source/src/code.py'
    if not (ROOT/'bwrap-hardlink').exists():
        os.link(original, ROOT/'bwrap-hardlink')
    assert original.stat().st_ino == (ROOT/'bwrap-hardlink').stat().st_ino
    if not (ROOT/'bwrap-source-link').exists():
        (ROOT/'bwrap-source-link').symlink_to(Path('/tmp/native-bwrap-fixture/source'))
    # Unconfined append controls run before containment, restore exact original bytes.
    before = hashes()
    for filename in before:
        file = Path(filename)
        contents = file.read_bytes()
        with file.open('ab') as stream:
            stream.write(b'unconfined-control')
        assert file.read_bytes() != contents
        file.write_bytes(contents)
    assert hashes() == before
    minimal = ROOT/'without-bwrap'
    minimal.mkdir(exist_ok=True)
    for name, target in [('git','/usr/bin/git'), ('nono',str(setup.NONO))]:
        if not (minimal/name).exists():
            (minimal/name).symlink_to(target)
    for entry in [ROOT/'offline-runtime/bin/python', Path('/tmp/native-bwrap-runtime/bin/python')]:
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text(f'''#!{ROOT}/venv/bin/python
import importlib.util, json, os, sys
from pathlib import Path
import subprocess
original_popen=subprocess.Popen
def traced_popen(argv,*args,**kwargs):
    if argv[0] == '/usr/bin/unshare':
        folder=Path('/srv/native-verification/exact-unshare-bwrap-argv');folder.mkdir(exist_ok=True)
        (folder/(str(os.getpid())+'.json')).write_text(json.dumps({{'argv':argv,
            'close_fds':kwargs.get('close_fds'),'pass_fds':kwargs.get('pass_fds')}}))
    return original_popen(argv,*args,**kwargs)
subprocess.Popen=traced_popen
if sys.argv[-1:] == ['--run']:
    if Path('/srv/native-verification/payload-failure').exists():
        sys.exit(17)
    # Read request once; replay the same bytes to unmodified product main.
    import io
    raw=sys.stdin.read(65536)
    request=json.loads(raw)
    spec=importlib.util.spec_from_file_location('offline_payload',
        {str(SOURCE/'tests/native_bubblewrap_payload.py')!r})
    payload=importlib.util.module_from_spec(spec);spec.loader.exec_module(payload)
    payload.install(request)
    sys.stdin=io.StringIO(raw)
import runpy
args=sys.argv[1:]
file=args[args.index('-B')+1]
sys.argv=[file,*args[args.index(file)+1:]]
runpy.run_path(file,run_name='__main__')
''')
        entry.chmod(0o700)
    return before


def validate_launch_traces():
    traces = sorted((ROOT/'exact-unshare-bwrap-argv').glob('*.json'))
    assert traces, 'No exact unshare-to-bubblewrap launch trace was recorded'
    records = []
    for trace in traces:
        record = json.loads(trace.read_text())
        argv = record['argv']
        if argv == ['/usr/bin/unshare', '--version']:
            continue
        assert argv[:8] == ['/usr/bin/unshare', '--user', '--map-current-user',
                            '--mount', '--propagation', 'private', '--', '/usr/bin/bwrap']
        separator = argv.index('--', 8)
        assert argv[separator-4:separator:2] == ['--info-fd', '--block-fd']
        assert record['close_fds'] is True and len(record['pass_fds']) == 2
        assert not {'--keep-caps', '--fork', '--mount-proc', '--setuid', '--setgid'} & set(argv[:8])
        records.append(record)
    assert records, 'No exact unshare-to-bubblewrap launch was recorded'
    return records


def stopped(mode, before):
    runs = ROOT/f'handler-{mode}'
    entries = list(runs.iterdir())
    assert entries
    run_dir = max(entries, key=lambda entry: entry.stat().st_mtime_ns)
    deadline = time.monotonic()+5
    terminal = run_dir/'completed.json'
    while not terminal.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    record = json.loads(terminal.read_text())
    expected = 'unverified' if mode == 'wrapper-kill' else 'verified'
    assert record['shutdown'] == expected, record
    if expected == 'verified':
        assert record['boundary'] == 'bubblewrap-pidfd'
        assert not (run_dir/'snapshot').exists()
    else:
        assert (run_dir/'snapshot').is_dir()
        assert not (run_dir/'evidence/native-state').exists()
        assert str(run_dir/'snapshot') in record['retainedResources']
    if mode == 'payload-failure':
        assert hashes() == before
        assert not (run_dir/'evidence/native-state').exists()
        return {'mode':mode, 'terminal':record, 'outsideHashes':before}
    canary = json.loads((run_dir/'evidence/boundary-canary.json').read_text())
    assert canary['pid'] == 2 and canary['ppid'] == 1
    status = dict(line.split(':', 1) for line in canary['status'])
    assert status['NoNewPrivs'].strip() == '1'
    assert all(int(status[name].strip(), 16) == 0 for name in
               ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd'])
    for file in Path('/proc').glob('[0-9]*/ns/pid'):
        try:
            assert os.readlink(file) != canary['namespace'], 'Namespace process survived export'
        except (OSError, ProcessLookupError):
            pass
    heartbeat = run_dir/'evidence/descendant-heartbeat'
    saved = heartbeat.read_bytes()
    time.sleep(0.1)
    assert heartbeat.read_bytes() == saved
    assert hashes() == before
    assert not Path('/tmp/private-positive').exists()
    assert not Path('/var/tmp/private-positive').exists()
    assert not Path('/dev/shm/private-positive').exists()
    return {'mode':mode, 'terminal':record, 'canary':canary,
            'outsideHashes':before, 'namespaceProcessesAfterExport':0}


def propagation():
    before = prepare()
    hold = ROOT/'hold-propagation'
    hold.write_text('fixed pre-boundary hold', encoding='utf-8')
    try:
        run([NODE, str(SOURCE/'tests/native_bubblewrap_handler.mjs'), 'propagation'], timeout=15)
        runs = ROOT/'handler-propagation'
        run_dir = max(runs.iterdir(), key=lambda entry: entry.stat().st_mtime_ns)
        terminal = json.loads((run_dir/'completed.json').read_text())
        result = json.loads((ROOT/'result-propagation.json').read_text())
        native = json.loads((run_dir/'evidence/native-result.json').read_text())
        assert not result.get('isError') and terminal['shutdown'] == 'verified', (result, terminal)
        assert terminal['boundary'] == 'bubblewrap-pidfd'
        assert native['status'] == 'completed'
        assert (run_dir/'evidence/boundary-canary.json').exists()
        assert (run_dir/'evidence/offline-transport-reached').exists()
        incoming = ROOT/'bwrap-fixture/source/nested/incoming/sentinel'
        assert incoming.read_text(encoding='utf-8') == 'original'
        assert hashes() == before
        record = {'registeredHandlerPropagationIsolated': True,
                  'finalBoundaryAndOfflineTransportReached': True,
                  'incomingOutsideBytes': incoming.read_text(encoding='utf-8'),
                  'terminal': terminal}
        (ROOT/'propagation-regression.json').write_text(json.dumps(record, indent=2))
        print(json.dumps(record))
    finally:
        hold.unlink(missing_ok=True)


def main():
    before = prepare()
    results = []
    for mode in ['normal','temp','cancel','parent-loss','wrapper-kill','payload-failure','startup']:
        if mode in ['cancel','parent-loss','wrapper-kill']:
            (ROOT/'hold-offline').write_text('fixed test hold')
        if mode == 'payload-failure':
            (ROOT/'payload-failure').write_text('fixed pre-Session failure')
        began = time.time()
        if mode == 'parent-loss':
            proc = subprocess.Popen(  # pylint: disable=consider-using-with
                [NODE,str(SOURCE/'tests/native_bubblewrap_handler.mjs'),mode],
                cwd=ROOT, env=setup.ENV, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False)
            end = time.monotonic()+8
            def reached(started=began):
                return [file for file in (ROOT/'handler-parent-loss').glob(
                    '*/evidence/boundary-canary.json') if file.stat().st_mtime >= started]
            while time.monotonic() < end and not reached():
                time.sleep(0.02)
            assert reached()
            proc.kill()
            proc.wait(timeout=2)
        else:
            run([NODE,str(SOURCE/'tests/native_bubblewrap_handler.mjs'),mode],timeout=15)
        if mode == 'startup':
            assert not (ROOT/'handler-startup').exists()
            assert hashes() == before
            results.append({'mode':mode, 'noWorkerOrArtifacts':True})
        else:
            results.append(stopped(mode,before))
        (ROOT/'hold-offline').unlink(missing_ok=True)
        (ROOT/'payload-failure').unlink(missing_ok=True)
    traces = validate_launch_traces()
    (ROOT/'linux-regression.json').write_text(json.dumps({'source':str(SOURCE),
        'results':results,'launchTraces':traces,
        'inferenceCalls':0,'providerCalls':0},indent=2))
    print(json.dumps({'registeredHandlerScenarios':len(results),'source':str(SOURCE),
                      'exactUnshareBwrapLaunches':len(traces), 'outsidePreserved':True,
                      'namespaceDeathBeforeExport':True, 'inferenceCalls':0}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--propagation']:
        propagation()
    elif not sys.argv[1:]:
        main()
    else:
        raise ValueError('Unsupported fixed Linux regression mode')
