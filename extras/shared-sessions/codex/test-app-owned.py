"""Isolated real app-server tests; never connect to the live shared endpoint."""
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent
BASE = json.loads(Path(os.environ.get('T3_SHARED_CODEX_CONFIG', ROOT / 'config.json')).read_text(encoding='utf-8-sig'))
TEST = Path(tempfile.mkdtemp(prefix='t3-app-owned-'))
(TEST / 'home').mkdir()
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    PORT = reservation.getsockname()[1]
CONFIG = {**BASE, 'home': str(TEST / 'home'), 'url': f'ws://127.0.0.1:{PORT}'}
(TEST / 'config.json').write_text(json.dumps(CONFIG), encoding='utf8')
ENV = {**os.environ, 'T3_SHARED_CODEX_CONFIG': str(TEST / 'config.json'),
       'CODEX_HOME': CONFIG['home']}
processes = []
checks = []


def listening():
    try:
        with socket.create_connection(('127.0.0.1', PORT), timeout=.2):
            return True
    except OSError:
        return False


def wait_stopped():
    for _ in range(100):
        if not listening():
            return
        time.sleep(.05)
    raise AssertionError('Owned backend leaked after adapter shutdown')


def launch(command):
    child = subprocess.Popen(command, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, encoding='utf8',
                             creationflags=subprocess.CREATE_NO_WINDOW)
    processes.append(child)
    child.messages = queue.Queue()
    child.errors = []
    def read_output():
        for line in child.stdout:
            child.messages.put(json.loads(line))
    def read_errors():
        for line in child.stderr:
            child.errors.append(line)
    threading.Thread(target=read_output, daemon=True).start()
    threading.Thread(target=read_errors, daemon=True).start()
    return child


def send(child, message):
    child.stdin.write(json.dumps(message) + '\n')
    child.stdin.flush()


def request(child, request_id, method, params):
    send(child, {'id': request_id, 'method': method, 'params': params})
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            message = child.messages.get(timeout=max(.1, deadline - time.monotonic()))
        except queue.Empty:
            raise AssertionError('No protocol response; exit=%s; diagnostic=%s' %
                                 (child.poll(), ''.join(child.errors[-8:])))
        if message.get('id') == request_id:
            assert 'error' not in message, message
            return message['result']
    raise AssertionError('No protocol response')


def initialize(child, name):
    request(child, 1, 'initialize', {'clientInfo': {'name': name, 'version': '1.0'},
                                  'capabilities': {'experimentalApi': True}})
    send(child, {'method': 'initialized', 'params': {}})


try:
    version = subprocess.run([str(ROOT / 'codex-app-owned.exe'), '--version'], env=ENV,
                             capture_output=True, text=True, timeout=10)
    assert version.returncode == 0 and 'codex-cli' in version.stdout
    checks.append('Non-server CLI requests delegate to the real binary')
    owner = launch([str(ROOT / 'codex-app-owned.exe'), '-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'])
    initialize(owner, 'owned_adapter_test')
    assert listening()
    request(owner, 2, 'thread/list', {'limit': 1})
    checks.append('Desktop-style stdio initializes and reads from the real shared backend')
    runtime = json.loads((TEST / 'app-owned-runtime.json').read_text())
    assert runtime['mode'] == 'app-owned'
    bridge = launch([BASE['node'], str(ROOT / 'bridge.cjs'), 'app-server'])
    initialize(bridge, 't3_bridge_test')
    request(bridge, 2, 'thread/list', {'limit': 1})
    checks.append('An independent T3-style bridge connects concurrently')
    created = request(owner, 3, 'thread/start', {'cwd': CONFIG['home']})
    shared = request(bridge, 3, 'thread/read', {'threadId': created['thread']['id'], 'includeTurns': False})
    assert shared['thread']['id'] == created['thread']['id']
    checks.append('T3-style connection reads the same thread created through Desktop-style stdio')
    helper = launch([str(ROOT / 'codex-app-owned.exe'), 'app-server', '--listen', 'stdio://'])
    initialize(helper, 'cua_helper_test')
    helper.stdin.close()
    assert helper.wait(timeout=5) == 0
    assert listening()
    checks.append('CUA helper stdio app-server remains independent while shared endpoint is occupied')
    collision = subprocess.run([str(ROOT / 'codex-app-owned.exe'), 'app-server', '--analytics-default-enabled'], env=ENV,
                               input='', capture_output=True, text=True, timeout=10)
    assert collision.returncode != 0 and 'EADDRINUSE' in collision.stderr
    checks.append('Second owner refuses an occupied endpoint')
    bridge.stdin.close()
    assert bridge.wait(timeout=5) == 0
    assert listening()
    checks.append('Disconnecting T3 does not stop the App-owned backend')
    owner.stdin.close()
    assert owner.wait(timeout=5) == 0
    wait_stopped()
    checks.append('Normal App stdin closure removes the owned backend')
    owner2 = launch([str(ROOT / 'codex-app-owned.exe'), 'app-server', '--analytics-default-enabled'])
    initialize(owner2, 'forced_exit_test')
    owner2.kill()
    owner2.wait(timeout=5)
    wait_stopped()
    checks.append('Windows job cleans up descendants on forced adapter termination')
    bad_env = {**ENV, 'CODEX_HOME': str(TEST / 'wrong-home')}
    wrong_home = subprocess.run([str(ROOT / 'codex-app-owned.exe'), 'app-server', '--analytics-default-enabled'], env=bad_env,
                               input='', capture_output=True, text=True, timeout=10)
    assert wrong_home.returncode != 0 and 'does not match' in wrong_home.stderr
    checks.append('Mismatched CODEX_HOME rejected')
    result = {'passed': True, 'checks': checks, 'testDirectory': str(TEST),
              'notTested': ['Desktop browser authentication', 'actual model turns', 'Desktop relaunch']}
    (ROOT / 'app-owned-validation.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result, indent=2))
finally:
    for child in processes:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
