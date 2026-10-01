# Harmless SEC-002 archive fixtures

Generated with Python's standard-library zipfile (DEFLATE). No executable or
malware content. Normal member text is `hello harmless archive` or repeated `A`.
All fixtures together are under 60 KiB compressed and 110 KiB expanded.

- ordinary.zip: one 22-byte text member.
- member-size.zip: one 32 KiB member; exceeds a deliberately low 16 KiB test cap.
- expanded-size.zip: three 10,000-byte members; exceeds a 24 KiB cumulative cap.
- members.zip: eight tiny members; exceeds a four-member test cap.
- nested.zip: five archive levels; exceeds a three-level test cap.
- incomplete.zip: 14 malformed bytes; must never be treated as clean.
- time.zip: 500 tiny members (40 KiB expanded); exercises a 1 ms engine budget.

These are limit tests, not resource-exhausting bombs. Production limits remain
much higher. The integration harness enforces Docker CPU/RAM/tmpfs caps.
