# SEC-002 archive inspection policy

SEC-002 reconciles actual provider length and bounds provider reads. Archive
inspection adds independent expansion and execution limits; a compressed-length
check does not bound decompression work. SEC-001 owns download and native-processing
scan-success gates. It is published as [storage PR32](https://github.com/Xynes-Studio/xynes-storage-service/pull/32)
and is not included in this independent branch. The isolated PR32 gate overlay
passes, but full upload-finalization merge validation remains required. The user
has authorized draft PR publication; no deployment has been performed.

## Compatible budgets

| Resource | Production maximum | Reason |
| --- | --- | --- |
| Original scanner input / `StreamMaxLength` | 64 MiB | Bounds transfer, original tempfile and scanner buffers |
| Each extracted member / `MaxFileSize` | 64 MiB | A member cannot exceed the original-input budget |
| Cumulative expanded bytes / `MaxScanSize` | 128 MiB | Bounds actual inflation across the entire tree, including nested containers |
| Members / `MaxFiles` | 512 | Includes empty members and directories; bounds metadata work |
| Archive depth / `MaxRecursion` | 5 | Supports ordinary nesting; rejects deep chains |
| Engine scan / `MaxScanTime` | 5,000 ms | Cooperative ClamAV execution limit |
| Validation + engine wall time | 10,000 ms | Supervisor kills and reaps unfinished work |
| Input transfer | 10 seconds | Absolute socket deadline, including framing |
| Storage client default timeout | 25 seconds | Margin around bounded transfer plus scanner work |
| Scanner resources | 2 GiB RAM, one CPU, 256 MiB `/tmp` | Deployment backstops; one active request, no expensive waiting queue |

The scan runner applies the 64 MiB cap to every input, regardless of declared
MIME. Existing upload caps remain image 50 MiB, video 2 GiB, document 100 MiB and
other 5 GiB; recognized archive MIME types use 64 MiB at completion. Consequently,
files over 64 MiB that previously fit a video/document/other upload cap cannot
pass scan validation. This is a deliberate bounded policy, not large-file scan
support. Invalid actual-length reconciliation and bounded reads still apply.

Limits may be lowered through the explicit `CLAMD_CONF_*` deployment values.
Zero, invalid, increased or incompatible values fail startup. Input <= member <=
expanded and engine time < wall time are enforced. Archive inspection,
exceed-limit alerts and encrypted-archive alerts cannot be disabled.

## Inspection and execution

The supervisor owns the pinned ClamAV 1.5.2 daemon on loopback port 3311; Storage
uses only supervisor port 3310. Storage supplies bounded content-type metadata
with `zXYNES <contentType>\0`, followed by INSTREAM. MIME parameters are normalized
before declared-format checks. Bare INSTREAM is supported for direct diagnostics.
A raw clamd endpoint does not implement this metadata protocol and fails closed.

A separate killable process validates ZIP, TAR and GZIP before ClamAV inspection.
It counts actual inflated bytes and members across nested containers, checks CRCs,
lengths and ZIP directory records before allocation, and rejects malformed,
encrypted, multi-disk/ZIP64 ZIPs and TAR links/devices/sparse files. No member files
are extracted to disk. Detected unsupported formats (including RAR, 7z, bzip2,
XZ, CAB, ISO and disk images) are rejected. This conservative supported-format
policy may reject unusual legitimate archives. Detection does not certify every
polyglot or arbitrary file format; ClamAV remains inside the hard execution and
resource bounds for inputs the preflight does not recognize.

ClamAV's AlertExceedsMax alone is insufficient: the pinned engine accepted a
155-byte ZIP containing a 32 KiB member with MaxFileSize=16 KiB. Preflight rejects
that same case. Real tests also verified member count, recursion and engine-time
alerts; the cumulative expanded-size check is enforced by preflight.
See the pinned [engine source](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.2/libclamav/others.c)
and [configuration](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.2/etc/clamd.conf.sample).

On timeout or a private scanner transport error the supervisor kills and waits
for the owned daemon before returning a terminal rejection. It holds the serial
slot through bounded restart. Restart failure closes the public server. Graceful
shutdown cancels private socket IO and validation children before reaping. Client
disconnection does not cancel the independent wall-time watchdog. Tests freeze
the owned daemon, disconnect after 50 ms and verify the old PID is reaped within
the deliberately low 500 ms test wall budget plus scheduling margin.

## Quarantine and recovery

Limit, unsupported, encrypted and incomplete archive verdicts become
`ARCHIVE_INSPECTION_REJECTED`, non-retryable. A required scan job fails and its
parent object becomes `failed`; worker polling cannot repeat that expensive job.
Ambiguous/error responses never become clean. Client timeout is inconclusive and
terminal; ordinary availability errors remain bounded by existing retry policy.

SEC-001 must deny signed downloads and native jobs unless the required scan
succeeded. The opt-in `archive-sec001-gates.integration.test.ts` exercises both
consumers after real archive rejection. It deliberately fails in this checkout
until SEC-001 lands; the archive policy is not a complete release remediation
without those gates. No duplicate consumer gates were added here.

Rejected provider bytes remain for audited operator retention/cleanup. Do not
blindly reset deterministic limit failures. Recover by a compliant replacement
upload, or an explicitly reviewed policy change and deliberate rescan after
capacity assessment. Scanner restart permits subsequent compliant jobs; it does
not change a quarantined object's state. Temporary original uploads are removed
on every handled outcome. Container tmpfs and memory caps cover abrupt termination.

## Deployment and evidence limits

Compose builds the custom image from the adjacent storage repository. Kubernetes
is a draft using the same image tag and policy; publishing that custom image and
substituting a registry digest remain release work. Runtime scanner UID 1000,
read-only root, dropped capabilities, read-only definitions and private probes are
explicit. Freshclam alone keeps the writable definitions volume and upstream
entrypoint. Its signature freshness and production volume permissions require
operator checks. Tests use a synthetic harmless signature, not production feeds.

Run `python3 scripts/test-archive-scanner.py` for isolated pinned-engine tests.
It uses small committed fixtures, resource caps, random loopback ports and unique
container names, and cleans its containers. Run Go race tests and
`coverage-gate.py` for >=80% coverage in each production Go file. CI provisions
these checks in `archive-safety`. Enable `XYNES_SEC001_GATES_REQUIRED=1` when the
SEC-001 changes are available to require combined consumer integration.
