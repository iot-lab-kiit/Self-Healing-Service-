"""Discovery shim: `unittest discover` only collects test*.py, the suite lives in validate_configs.py."""

from validate_configs import *  # noqa: F401,F403
