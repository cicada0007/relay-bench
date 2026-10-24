"""Writes the task list of one pinned dataset version from Harbor's registry: the file each benchmark's runner reads.

    ~/.local/share/uv/tools/harbor/bin/python -I harbor-agents/dataset_tasks.py swe-bench/swe-bench-verified sha256:<digest> > runner/swebench-verified-tasks.json
    ~/.local/share/uv/tools/harbor/bin/python -I harbor-agents/dataset_tasks.py scale-ai/swe-bench-pro sha256:<digest> > runner/swebench-pro-tasks.json

It only reads the registry (no task is downloaded, nothing runs). tb21_tasks.py is the same for Terminal-Bench 2.1.
"""

import asyncio
import json
import sys

from harbor.registry.client.package import PackageDatasetClient


async def main(dataset: str, ref: str) -> None:
    client = PackageDatasetClient()
    metadata = await client._get_dataset_metadata(f"{dataset}@{ref}")
    org, name = dataset.split("/")
    _package, version = await client._db.resolve_dataset_version(org, name, ref)
    tasks = sorted(({"name": f"{t.org}/{t.name}", "ref": t.ref} for t in metadata.task_ids), key=lambda t: t["name"])
    print(json.dumps({"dataset": dataset, "ref": metadata.version, "revision": version.get("revision"),
                      "publishedAt": version.get("published_at"), "tasks": tasks}, indent=1))


asyncio.run(main(sys.argv[1], sys.argv[2]))
