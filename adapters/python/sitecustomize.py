"""Ambio auto-bootstrap.

CPython's site module imports `sitecustomize` automatically at interpreter
startup. When Ambio launches a target app (or the user opts in by putting this
directory on PYTHONPATH), the presence of AMBIO_RUNTIME_PORT activates the
adapter. Without that variable this module does nothing, so leaving the
directory on PYTHONPATH permanently is harmless.

If the user's environment has its own sitecustomize elsewhere on sys.path,
ours shadows it (Python imports only the first). We chain-load the next one
found so existing setups keep working, and load it before starting Ambio:
Ubuntu's installs apport's sys.excepthook, which would otherwise replace the
recorder's and hide every crash.
"""

import os
import sys


def _bootstrap() -> None:
    # An `investigation run` records in-process and writes evidence at exit.
    # It needs no socket and works on every Python, so it skips the streaming
    # adapter (3.12+ only), whose version warning would land in the user's
    # program output.
    if os.environ.get("AMBIO_EVIDENCE_DIR"):
        try:
            from ambio_adapter import recorder
            recorder.start()
        except Exception:
            pass
        return
    if os.environ.get("AMBIO_RUNTIME_PORT") or os.environ.get("AMBIO_WORKSPACE_ID"):
        try:
            import ambio_adapter
            ambio_adapter.init()
        except Exception:
            pass


def _chain_next_sitecustomize() -> None:
    """Execute the next sitecustomize.py on sys.path (shadowed by this one)."""
    try:
        here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
        for entry in sys.path:
            if not entry:
                continue
            try:
                if os.path.normcase(os.path.abspath(entry)) == here:
                    continue
                candidate = os.path.join(entry, "sitecustomize.py")
                if os.path.isfile(candidate):
                    import runpy
                    result = runpy.run_path(candidate, run_name="sitecustomize")
                    # Expose the chained module's names on THIS module -
                    # code doing `import sitecustomize; sitecustomize.x`
                    # gets our module object, so merge theirs in.
                    for k, v in result.items():
                        if not k.startswith("__"):
                            globals()[k] = v
                    return
            except Exception:
                continue
    except Exception:
        pass


_chain_next_sitecustomize()
_bootstrap()
