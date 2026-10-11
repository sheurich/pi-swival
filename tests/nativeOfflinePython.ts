import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Application/IPC fixtures only. This explicitly stubs Linux isolation, not providers. */
export const nativeOfflineUnshareIdentity = Object.freeze({
	path: "/usr/bin/unshare", version: "unshare from util-linux 2.41.5", package: "util-linux",
	packageVersion: "2.41.5-0+deb13u1", architecture: "arm64",
	sha256: "285119fd3989039d50f8904b619b2abb8b795cb56753eb0235c8c031eb880a21",
});
export const nativeOfflineBwrapIdentity = Object.freeze({
	path: "/usr/bin/bwrap", version: "bubblewrap 0.12.0", package: "bubblewrap",
	packageVersion: "0.12.0-1~deb13u1", architecture: "arm64",
	sha256: "b3b829e18a7d43ee589dc37e351cb9480ff7301b493d8227b8c754294638b976",
});
export const nativeOfflineNonoArtifactIdentity = Object.freeze({
	version: "0.79.0", architecture: "aarch64-unknown-linux-gnu", bytes: 26141064,
	sha256: "667fdaea93f77c9f8f45b04a80f4e2fb7e7d7fb104fa1da189ea38f41fbcf57b",
});
export const nativeOfflineNonoIdentity = (executable: string) => ({
	path: fs.realpathSync(executable), ...nativeOfflineNonoArtifactIdentity,
});

export function recordOfflineUnshareIdentity(root: string, executable: string): void {
	const identity = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
	fs.writeFileSync(path.join(root, "offline-python", "unshare.sha256"), identity, { mode: 0o600 });
}

export function recordOfflineNonoIdentity(root: string, executable: string): void {
	const identity = createHash("sha256").update(fs.readFileSync(fs.realpathSync(executable))).digest("hex");
	fs.writeFileSync(path.join(root, "offline-python", "nono.sha256"), identity, { mode: 0o600 });
}

export function installOfflinePython(root: string, python: string): string {
	const entry = path.join(root, "offline-python", "python");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	const unshareState = path.join(root, "offline-python", "unshare.sha256");
	const nonoState = path.join(root, "offline-python", "nono.sha256");
	fs.writeFileSync(entry, `#!${python}
import hashlib, importlib.util, json, os, pathlib, sys, tempfile
args=sys.argv[1:]
if '--probe' in args:
    sys.exit(0)  # No kernel-isolation claim in application/IPC fixtures.
if '--validate-unshare' in args:
    request=json.load(sys.stdin)
    try:
        digest=hashlib.sha256(pathlib.Path(request['unshare']).read_bytes()).hexdigest()
    except (OSError,KeyError,TypeError):
        sys.exit(1)
    pathlib.Path(${JSON.stringify(unshareState)}).write_text(digest,encoding='ascii')
    print(${JSON.stringify(JSON.stringify(nativeOfflineUnshareIdentity))})
    sys.exit(0)  # Identity protocol fixture; real validation runs in Linux gates.
if '--validate-bwrap' in args:
    request=__import__('json').load(sys.stdin)
    try:
        contents=open(request['bwrap'],encoding='utf-8').read(1024*1024+1)
    except (OSError,KeyError,TypeError):
        sys.exit(1)
    if 'bubblewrap 0.12.0' not in contents:
        sys.exit(1)
    print(${JSON.stringify(JSON.stringify(nativeOfflineBwrapIdentity))})
    sys.exit(0)  # Identity protocol fixture; real validation runs in Linux gates.
if '--validate-nono' in args:
    request=json.load(sys.stdin)
    try:
        selected=pathlib.Path(request['nono'])
        resolved=selected.resolve(strict=True)
        expected=pathlib.Path(${JSON.stringify(nonoState)}).read_text(encoding='ascii')
        actual=hashlib.sha256(resolved.read_bytes()).hexdigest()
    except (OSError,KeyError,TypeError):
        sys.exit(1)
    if str(selected) != str(resolved) or actual != expected:
        sys.exit(1)
    print(json.dumps({'path':str(resolved),**${JSON.stringify(nativeOfflineNonoArtifactIdentity)}}))
    sys.exit(0)  # Artifact-identity boundary mock; this is not live ELF/capability proof.
if '--launch' not in args:
    os.execve(${JSON.stringify(python)},[${JSON.stringify(python)},*args],dict(os.environ))
bridge_file=args[args.index('-B')+1]
spec=importlib.util.spec_from_file_location('offline_bridge',bridge_file)
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
def offline_unshare_identity(executable):
    try:
        expected=pathlib.Path(${JSON.stringify(unshareState)}).read_text(encoding='ascii')
        actual=hashlib.sha256(pathlib.Path(executable).read_bytes()).hexdigest()
    except OSError as error:
        raise bridge.NativeAuditError('Offline unshare identity unavailable') from error
    if actual != expected:
        raise bridge.NativeAuditError('Offline unshare identity changed')
    return dict(bridge.UNSHARE_IDENTITY)
bridge.validate_unshare_identity=offline_unshare_identity
bridge.validate_bwrap_identity=lambda _executable: dict(bridge.BWRAP_IDENTITY)
def offline_nono_identity(executable,*,host_path=True):
    try:
        selected=pathlib.Path(executable);resolved=selected.resolve(strict=True)
        expected=pathlib.Path(${JSON.stringify(nonoState)}).read_text(encoding='ascii')
        actual=hashlib.sha256(resolved.read_bytes()).hexdigest()
    except OSError as error:
        raise bridge.NativeAuditError('Offline nono identity unavailable') from error
    if str(selected) != str(resolved) or actual != expected:
        raise bridge.NativeAuditError('Offline nono identity changed')
    return {'path':str(resolved),**bridge.NONO_ARTIFACT_IDENTITY}
bridge.validate_nono_identity=offline_nono_identity  # Boundary mock, not live trust proof.
bridge._revalidate_nono_profile=lambda request,**_kwargs: request.get('nonoProfileIdentity',{})
# Local-profile parsing is covered by direct Python tests, not this isolation mock.
def offline_supervise(request,payload,input_bytes=None):
    expected=pathlib.Path(${JSON.stringify(unshareState)}).read_text(encoding='ascii')
    actual=hashlib.sha256(pathlib.Path(request['unshare']).read_bytes()).hexdigest()
    if actual != expected:
        os.execve(request['unshare'],[request['unshare']],dict(os.environ))
    with tempfile.TemporaryFile() as stream:
        stream.write(input_bytes);stream.seek(0);os.dup2(stream.fileno(),0)
    os.write(4,b'STARTED\\nVERIFIED\\n');os.close(4)
    argv=bridge.bubblewrap_argv(request,payload)
    os.execve(request['bwrap'],argv,dict(os.environ))
bridge.supervise_bubblewrap=offline_supervise
sys.argv=[bridge_file,*args[args.index(bridge_file)+1:]]
bridge.main()
`, { mode: 0o700 });
	return entry;
}
