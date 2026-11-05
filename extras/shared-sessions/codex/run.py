"""Portable, opt-in Windows Codex shared backend. Never edits T3 state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent


def load_config():
    c = json.loads((ROOT / 'config.json').read_text(encoding='utf-8-sig'))
    for key in ('node', 'binary', 'app'):
        p = Path(c[key])
        if not p.is_absolute() or not p.is_file():
            raise ValueError(f'{key}: supply an existing absolute executable path')
    if not Path(c['home']).is_absolute() or not Path(c['home']).is_dir():
        raise ValueError('home: supply your existing absolute CODEX_HOME directory')
    u = urlparse(c['url'])
    if (u.scheme != 'ws' or u.hostname != '127.0.0.1' or not u.port
            or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment):
        raise ValueError('url must be ws://127.0.0.1:<port>')
    return c


def fingerprints(c):
    result = {}
    for key in ('node', 'binary', 'app'):
        with Path(c[key]).open('rb') as stream:
            result[key] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return result


def open_port(c):
    u = urlparse(c['url'])
    try:
        with socket.create_connection((u.hostname, u.port), timeout=0.3):
            return True
    except OSError:
        return False


def ensure_app_closed(c):
    result = subprocess.run(
        ['powershell', '-NoProfile', '-Command',
         'Get-CimInstance Win32_Process | Select-Object ExecutablePath | ConvertTo-Json -Compress'],
        capture_output=True, text=True, check=True,
        creationflags=subprocess.CREATE_NO_WINDOW)
    rows = json.loads(result.stdout or '[]')
    if isinstance(rows, dict):
        rows = [rows]
    wanted = os.path.normcase(os.path.abspath(c['app']))
    if any(r.get('ExecutablePath') and
           os.path.normcase(os.path.abspath(r['ExecutablePath'])) == wanted for r in rows):
        raise RuntimeError('Fully quit Codex App before starting. No process was stopped.')


def setup(c):
    if any(ch in c['node'] or ch in str(ROOT) for ch in ('%', '!', '\n', '\r')):
        raise ValueError('Use paths without %, ! or newline characters for this CMD bridge')
    probe = subprocess.run([c['node'], '-e',
                            "if(typeof WebSocket!=='function')process.exit(1)"], check=False)
    if probe.returncode:
        raise RuntimeError('Node must provide the global WebSocket API (use Node 22+)')
    (ROOT / 'approved-versions.json').write_text(
        json.dumps(fingerprints(c), indent=2), encoding='utf8')
    (ROOT / 'codex-shared.cmd').write_text(
        '@echo off\n"' + c['node'] + '" "%~dp0bridge.cjs" %*\n', encoding='utf8')
    print('Prepared. Set T3 Codex Binary path to:', ROOT / 'codex-shared.cmd')
    print('Set its Home path to:', c['home'])
    print('This records file versions; it does not certify protocol compatibility.')


def run(c):
    approved = json.loads((ROOT / 'approved-versions.json').read_text())
    if fingerprints(c) != approved:
        raise RuntimeError('An executable changed. Recheck compatibility before running setup again.')
    ensure_app_closed(c)
    if open_port(c):
        raise RuntimeError('Port already occupied. Refusing to attach an unknown backend.')
    env = os.environ.copy()
    for key in ('ELECTRON_RUN_AS_NODE', 'CODEX_ELECTRON_USER_DATA_PATH',
                'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL'):
        env.pop(key, None)
    env['CODEX_HOME'] = c['home']
    # Keep this control terminal open. Only the process created here is stopped.
    with (ROOT / 'backend.log').open('ab') as log:
        backend = subprocess.Popen(
            [c['binary'], '-c', 'features.code_mode_host=true', 'app-server',
             '--listen', c['url'], '-c', 'features.prefer_mxc=true', '-c',
             'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'],
            cwd=c['home'], env=env, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            for _ in range(100):
                if backend.poll() is not None:
                    raise RuntimeError('Backend exited; inspect backend.log')
                if open_port(c):
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('Backend startup timeout')
            env['CODEX_APP_SERVER_WS_URL'] = c['url']
            subprocess.Popen([c['app']], cwd=c['home'], env=env)
            print('Shared backend started. Open your custom T3 now.')
            print('Keep this terminal open. Finish tasks and quit BOTH apps before Ctrl+C.')
            while backend.poll() is None:
                time.sleep(0.5)
        finally:
            if backend.poll() is None:
                backend.terminate()
                backend.wait(timeout=15)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'setup', 'run'])
    args = parser.parse_args()
    try:
        config = load_config()
        if args.command == 'setup':
            setup(config)
        elif args.command == 'run':
            run(config)
        else:
            print('Configuration paths and loopback URL are valid. No applications started.')
    except KeyboardInterrupt:
        print('Owned shared backend stopped.')
    except Exception as error:
        parser.exit(1, f'ERROR: {error}\n')
