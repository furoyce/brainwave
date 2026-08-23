"""Frontend logic tests: public/main.js evaluated in a Node vm against a fake
DOM (tests/frontend/dom_harness.js). Each suite exits non-zero on failure, so
pytest stays the single entry point for the whole repo."""

import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parent / "frontend"
SUITES = sorted(p.name for p in FRONTEND.glob("test_*.js"))


@pytest.mark.parametrize("suite", SUITES)
def test_frontend_suite(suite):
    result = subprocess.run(
        ["node", suite],
        cwd=FRONTEND,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"{suite} failed:\n{result.stdout}\n{result.stderr}"


def test_suites_were_discovered():
    assert len(SUITES) >= 5
