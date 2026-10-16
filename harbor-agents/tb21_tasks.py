"""Writes runner/tb21-tasks.json: the task list of the pinned Terminal-Bench 2.1 dataset version, from Harbor's registry.

    ~/.local/share/uv/tools/harbor/bin/python -I harbor-agents/tb21_tasks.py sha256:<dataset digest> > runner/tb21-tasks.json
"""

import asyncio
import json
import sys

from harbor.registry.client.package import PackageDatasetClient

DATASET = "terminal-bench/terminal-bench-2-1"


async def main(ref: str) -> None:
    client = PackageDatasetClient()
    metadata = await client._get_dataset_metadata(f"{DATASET}@{ref}")
    org, name = DATASET.split("/")
    _package, version = await client._db.resolve_dataset_version(org, name, ref)
    tasks = sorted(({"name": f"{t.org}/{t.name}", "ref": t.ref} for t in metadata.task_ids), key=lambda t: t["name"])
    print(json.dumps({"dataset": DATASET, "ref": metadata.version, "revision": version.get("revision"),
                      "packageVersion": version.get("version"), "tasks": tasks}, indent=1))


asyncio.run(main(sys.argv[1]))
