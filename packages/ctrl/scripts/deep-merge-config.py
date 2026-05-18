#!/usr/bin/env python3
"""Deep-merge /tmp/openclaw-tenant-config.json into the existing openclaw.json."""
import json, os

def deep_merge(base, overlay):
    for k, v in overlay.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base

p = '/mnt/encrypted/openclaw/openclaw.json'
cfg = {}
if os.path.exists(p):
    with open(p) as f:
        cfg = json.load(f)

with open('/tmp/openclaw-tenant-config.json') as f:
    tenant = json.load(f)

deep_merge(cfg, tenant)

with open(p, 'w') as f:
    json.dump(cfg, f, indent=2)

os.remove('/tmp/openclaw-tenant-config.json')
print('Config merged successfully')
