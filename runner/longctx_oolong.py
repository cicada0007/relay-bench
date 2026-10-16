# Test G's OOLONG export: every OOLONG-synth test row with dataset "yahoo" and a 131,072-token context window (the
# "OOLONG (yahoo, 128k)" row of Prime Agent's published table), read from the two pinned parquet shards that hold them,
# written as one JSON line per row. Called by runner/longctx-data.mjs; run with
#   uv run --with duckdb==1.3.2 python -I runner/longctx_oolong.py <revision> <out.jsonl>
import json
import sys

import duckdb

revision, out = sys.argv[1], sys.argv[2]
# Found with a full scan of the test split at this revision: these two shards hold all 50 rows (ids 517050021-517050070).
shards = [f"hf://datasets/oolongbench/oolong-synth@{revision}/data/test-{n:05d}-of-00041.parquet" for n in (21, 22)]
rows = duckdb.connect().execute(
    "select id, context_len, dataset, context_window_id, task_group, task, answer_type, input_subset, num_labels, "
    "question, answer, context_window_text from read_parquet(?) where dataset = 'yahoo' and context_len = 131072 "
    "order by id",
    [shards],
)
columns = [d[0] for d in rows.description]
n = 0
with open(out, "w", encoding="utf-8") as f:
    for row in rows.fetchall():
        f.write(json.dumps(dict(zip(columns, row)), ensure_ascii=False) + "\n")
        n += 1
print(n)
