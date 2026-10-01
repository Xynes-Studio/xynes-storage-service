# Bounded archive scanner

Build with `docker build -t xynes/archive-scanner:0.1.0 .`. The static supervisor
uses a pinned ClamAV 1.5.2 image, runs as UID 1000, owns its private daemon, and
serves bounded INSTREAM requests on 3310. Mount readable definitions at
`/var/lib/clamav`; mount `/tmp` as a 256 MiB tmpfs and use the canonical resource
and security limits. A raw ClamAV container is not an interchangeable endpoint.

See [the archive policy](../../docs/XYN-SEC-002-archive-policy.md) for budgets,
supported formats, protocol, fail-closed recovery and the SEC-001 integration gate.

Local verification:

```sh
go test -race -coverprofile=coverage.out ./...
python3 coverage-gate.py coverage.out
cd ../..
python3 scripts/test-archive-scanner.py
```

The test harness builds the image, verifies effective clamd configuration, runs
harmless low-limit fixtures and proves frozen daemon termination after client
disconnection. It removes only its uniquely named containers. No deployment or
production-volume changes are performed.
