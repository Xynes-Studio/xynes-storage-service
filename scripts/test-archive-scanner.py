#!/usr/bin/env python3
"""Harmless pinned-engine integration; owns and removes only uniquely named containers."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get('ARCHIVE_TEST_IMAGE', 'xynes/archive-scanner:sec-002-test')
FIXTURES = ROOT / 'tests/fixtures/archives'
BASE = dict(StreamMaxLength=16384, MaxFileSize=16384, MaxScanSize=24576,
            MaxFiles=4, MaxRecursion=3, MaxScanTime=100, WallTime=500)
owned = []

def command(*args, **kwargs):
    kwargs.setdefault('stderr', subprocess.STDOUT)
    return subprocess.check_output(args, text=True, timeout=180, **kwargs).strip()

def start(label, policy, raw=False):
    name = 'xyn-sec-002-test-' + label + '-' + uuid.uuid4().hex[:8]
    args = ['docker', 'run', '-d', '--name', name, '--memory=2g', '--cpus=1',
            '--read-only', '--user=1000:1000', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--tmpfs=/tmp:size=256m,mode=1777',
            '-v', str(defs) + ':/var/lib/clamav:ro', '-p', '127.0.0.1::3310']
    for key, value in policy.items():
        args += ['-e', 'CLAMD_CONF_' + key + '=' + str(value)]
    owned.append(name)
    if raw:
        args += ['--entrypoint', 'clamd']
    command(*(args + [IMAGE] + (['--config-file=/var/lib/clamav/raw.conf'] if raw else [])))
    binding = json.loads(command('docker', 'inspect', name))[0]['NetworkSettings']['Ports']['3310/tcp'][0]
    port = int(binding['HostPort'])
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2) as probe:
                probe.sendall(b'zINSTREAM\0' + b'\0' * 4)
                probe.settimeout(2)
                ready = probe.recv(4096)
            if ready == b"stream: OK\0":
                time.sleep(.05)
                return name, port
            time.sleep(.1)
        except OSError:
            time.sleep(.1)
    raise AssertionError('scanner startup failed: ' + command('docker', 'logs', name))

def scan(port, data, mime=None, timeout=3):
    with socket.create_connection(('127.0.0.1', port), timeout=timeout) as connection:
        connection.settimeout(timeout)
        wire = (('zXYNES ' + mime + '\0').encode() if mime else b'') + b'zINSTREAM\0'
        connection.sendall(wire + struct.pack('!I', len(data)) + data + b'\0' * 4)
        reply = b''
        while not reply.endswith(b'\0'):
            chunk = connection.recv(4096)
            if not chunk:
                break
            reply += chunk
        return reply.decode().rstrip('\0')

def pid(name):
    return command('docker', 'exec', name, 'sh', '-c',
                   'for d in /proc/[0-9]*; do read -r c < "$d/comm"; if [ "$c" = clamd ]; then echo "${d##*/}"; fi; done')

try:
    if os.environ.get('ARCHIVE_TEST_SKIP_BUILD') != '1':
        subprocess.run(['docker', 'build', '-t', IMAGE, str(ROOT / 'sidecars/archive-scanner')], check=True)
    with tempfile.TemporaryDirectory(prefix='xyn-sec-002-defs-') as directory:
        defs = Path(directory)
        defs.chmod(0o755)
        # A harmless synthetic signature; no update/network/production-volume writes.
        (defs / 'harmless.ndb').write_text('XynesHarmlessTest:0:*:58594e45535f544553545f5349474e4154555245\n')
        (defs / 'harmless.ndb').chmod(0o644)
        default, _ = start('defaults', {})
        effective = command('docker', 'exec', default, 'clamconf', '-c', '/tmp')
        expected = dict(StreamMaxLength=67108864, MaxFileSize=67108864, MaxScanSize=134217728,
                        MaxFiles=512, MaxRecursion=5, MaxScanTime=5000)
        for key, value in expected.items():
            assert key + ' = "' + str(value) + '"' in effective, (key, effective)
        for key in ['AlertExceedsMax', 'ScanArchive', 'AlertEncrypted']:
            assert key + ' = "yes"' in effective, (key, effective)
        version = command('docker', 'exec', default, 'clamd', '--version')
        assert '1.5.2' in version, version
        print('Pinned engine:', version, '\nEffective production limits verified', flush=True)
        # Bypass preflight only in this isolated engine-behavior fixture.
        config = 'Foreground yes\nTCPSocket 3310\nTCPAddr 0.0.0.0\nDatabaseDirectory /var/lib/clamav\nTemporaryDirectory /tmp\nScanArchive yes\nAlertExceedsMax yes\nAlertEncrypted yes\nMaxThreads 1\n'
        for key, value in BASE.items():
            if key != 'WallTime':
                config += key + ' ' + str(value) + '\n'
        (defs / 'raw.conf').write_text(config)
        raw, raw_port = start('engine', {}, raw=True)
        for fixture, expected in [('ordinary', 'stream: OK'),
                                  ('member-size', 'stream: OK'),
                                  ('members', 'Heuristics.Limits.Exceeded.MaxFiles'),
                                  ('nested', 'Heuristics.Limits.Exceeded.MaxRecursion'),
                                  ('expanded-size', 'Heuristics.Limits.Exceeded.MaxScanSize')]:
            verdict = scan(raw_port, (FIXTURES / (fixture + '.zip')).read_bytes())
            assert expected in verdict, (fixture, verdict)
            print('Raw pinned engine ' + fixture + ': ' + verdict, flush=True)
        low, port = start('low', BASE)
        ordinary = (FIXTURES / 'ordinary.zip').read_bytes()
        verdict = scan(port, ordinary, 'application/zip;charset=utf-8')
        assert verdict == 'stream: OK', (repr(verdict), command('docker', 'logs', low))
        assert 'ArchiveIncomplete' in scan(port, b'broken', 'application/zip;charset=utf-8')
        for fixture, limit in [('member-size', 'MaxFileSize'), ('expanded-size', 'MaxScanSize'),
                               ('members', 'MaxFiles'), ('nested', 'MaxRecursion'),
                               ('incomplete', 'ArchiveIncomplete')]:
            verdict = scan(port, (FIXTURES / (fixture + '.zip')).read_bytes())
            assert limit in verdict and verdict.endswith('FOUND'), (fixture, verdict)
            print(fixture + ': ' + verdict, flush=True)
        assert 'StreamMaxLength' in scan(port, b'A' * 16385)
        engine, engine_port = start('time', dict(BASE, StreamMaxLength=1048576,
                                     MaxFileSize=1048576, MaxScanSize=2097152,
                                     MaxFiles=512, MaxScanTime=1))
        verdict = scan(engine_port, (FIXTURES / 'time.zip').read_bytes())
        assert 'Heuristics.Limits.Exceeded.MaxScanTime' in verdict, verdict
        print('Engine time:', verdict, flush=True)
        subprocess.run(['bun', 'test', 'tests/integration/processors/archive.integration.test.ts'],
                       cwd=ROOT, env=dict(os.environ, XYNES_ARCHIVE_TEST_PORT=str(port)), check=True)
        if os.environ.get('XYNES_SEC001_GATES_REQUIRED') == '1':
            subprocess.run(['bun', 'test', 'tests/integration/processors/archive-sec001-gates.integration.test.ts'],
                           cwd=ROOT, env=dict(os.environ, XYNES_ARCHIVE_TEST_PORT=str(port)), check=True)
        old_pid = pid(low)
        command('docker', 'exec', low, 'sh', '-c', 'kill -STOP "$1"', 'sh', old_pid)
        disconnected = time.monotonic()
        try:
            scan(port, ordinary, timeout=.05)
            raise AssertionError('frozen daemon returned a verdict')
        except socket.timeout:
            pass
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and pid(low) == old_pid:
            time.sleep(.02)
        assert pid(low) != old_pid, 'watchdog failed to reap frozen daemon'
        time.sleep(.1)
        assert 'watchdog reaped daemon' in command('docker', 'logs', low)
        print('Client disconnected at 50ms; frozen daemon reaped after %.3fs' %
              (time.monotonic() - disconnected), flush=True)
        assert scan(port, ordinary) == 'stream: OK', 'scanner restart did not recover'
        assert command('docker', 'exec', low, 'sh', '-c',
                       'for f in /tmp/xynes-scan-*; do [ ! -e "$f" ] || echo "$f"; done') == ''
        print('Archive scanner integration PASS', flush=True)
finally:
    for name in owned:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
