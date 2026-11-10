"""Released parser only: forbid sockets, process execution, and command dispatch."""
import importlib.metadata
import json
import socket
import subprocess
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
forbidden = AssertionError("network/process execution forbidden")
with patch.object(socket, "socket", side_effect=forbidden), \
     patch.object(socket, "create_connection", side_effect=forbidden), \
     patch.object(socket, "getaddrinfo", side_effect=forbidden), \
     patch.object(subprocess, "Popen", side_effect=forbidden):
    from swival.input_dispatch import parse_input_line
    assert importlib.metadata.version("swival") == "1.9.3"
    for command in ("/audit --all", "!echo should-not-run"):
        parsed = parse_input_line(command)
        assert parsed.is_command or parsed.is_custom_command, parsed
    prompts = json.load(sys.stdin)
    for prompt in prompts:
        parsed = parse_input_line(prompt)
        assert not parsed.is_command and not parsed.is_custom_command, parsed
        assert parsed.raw == prompt
    json.dump(prompts, sys.stdout)
