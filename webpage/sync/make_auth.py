#!/usr/bin/env python3
"""One-time auth.json creator. Usage: python3 make_auth.py <password>"""
import json
import os
import secrets
import sys

if len(sys.argv) < 2:
    sys.exit("usage: make_auth.py <password>")

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "auth.json")
data = {"password": sys.argv[1], "secret": secrets.token_hex(32)}
with open(out, "w") as f:
    json.dump(data, f)
os.chmod(out, 0o600)
print(f"wrote {out}")
