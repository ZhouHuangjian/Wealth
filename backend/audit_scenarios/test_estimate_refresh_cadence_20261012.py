"""Compatibility entry point for the EST-001 diagnostic, now a default regression.

The original 2 failed / 4 passed reproduction is preserved in the audit evidence.
Use tests/test_estimate_refresh_cadence.py for maintenance and normal acceptance.
"""

from pathlib import Path
from runpy import run_path

_regressions = run_path(
    str(
        Path(__file__).resolve().parents[1]
        / "tests"
        / "test_estimate_refresh_cadence.py"
    )
)
globals().update(
    {name: value for name, value in _regressions.items() if not name.startswith("__")}
)
