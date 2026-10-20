"""A stateful Cognee REST stub for the cognee sink tests (shapes follow docs.cognee.ai/cognee_openapi_spec.json).

`cognee_route()` returns a `route(method, path, body) -> (status, json)` function for `stub_server.serving`. The
emulated endpoints and the quirks the sink has to live with:

- `GET /health` -> 200.
- `GET /api/v1/datasets`, `POST /api/v1/datasets {"name"}` (create-or-return, so idempotent). Datasets carry a
  UUID `id` and `name`; the data endpoints take the id, never the name.
- `GET /api/v1/datasets/{id}/data?limit=&offset=` -> items with `id`, `name`, `externalMetadata`, `label`; limit
  above 1000 is a 422, an unknown dataset is a 404. Listing metadata is whatever was stored: a dict, a list of
  objects, or a JSON string of either (`plant` / `seed(..., meta_shape=)`); the sink must accept all three.
- `DELETE /api/v1/datasets/{id}/data/{data_id}` -> 200 also for an id the dataset does not track; 404 when the
  dataset is unknown.
- `POST /api/v1/add` (multipart: `datasetName`, optional `external_metadata` / `labels` JSON arrays, one `data`
  file). Creates the dataset when `datasetName` is new. A file whose name already exists in the dataset with
  different content is a 409 (identical content is a no-op), which is why the sink uploads one name per version.
  Like the real server, identical bytes already in the dataset under another name are deduplicated: the existing
  row (and its metadata) is kept and no row is added, which is why the sink makes every document's text unique.
- `POST /api/v1/cognify {"datasets": [...], "runInBackground"}` -> 200, recorded in `state.cognified`; an unknown
  or empty dataset is a 400 (nothing recorded), because cognify has nothing to process there.

`route.state` exposes the stored data for assertions; `state.fail[(method, path_prefix)] = (status, json)` makes
a matching request fail (until removed), for error-path tests.
"""

import hashlib
import json
import re
import uuid
from urllib.parse import parse_qs, urlsplit

DATA = re.compile(r"^/api/v1/datasets/([^/]+)/data(?:/([^/]+))?$")


class CogneeState:
    def __init__(self) -> None:
        self.datasets: dict[str, dict] = {}
        self.cognified: list[dict] = []
        self.fail: dict[tuple[str, str], tuple[int, dict]] = {}

    def ensure(self, name: str) -> dict:
        for dataset in self.datasets.values():
            if dataset["name"] == name:
                return dataset
        dataset = {"id": str(uuid.uuid4()), "name": name, "data": {}}
        self.datasets[dataset["id"]] = dataset
        return dataset

    def by_name(self, name: str) -> dict | None:
        return next((dataset for dataset in self.datasets.values() if dataset["name"] == name), None)

    def documents(self, name: str) -> list[dict]:
        dataset = self.by_name(name)
        return list(dataset["data"].values()) if dataset else []

    @staticmethod
    def shaped_meta(doc_id: str, shape: str = "dict"):
        """Listing-shaped external metadata: `dict`, `list`, `json_dict`, or `json_list`."""
        obj = {"doc_id": doc_id}
        if shape == "dict":
            return obj
        if shape == "list":
            return [obj]
        if shape == "json_dict":
            return json.dumps(obj)
        if shape == "json_list":
            return json.dumps([obj])
        raise ValueError(f"unknown meta_shape {shape!r}")

    def plant(
        self,
        name: str,
        doc_id: str,
        content: str = "",
        *,
        meta_shape: str = "dict",
        meta_key: str = "externalMetadata",
        data_id: str | None = None,
    ) -> str:
        """Insert one data row with listing metadata in the given shape (for upsert/delete parity tests)."""
        dataset = self.ensure(name)
        data_id = data_id or str(uuid.uuid4())
        dataset["data"][data_id] = {
            "id": data_id,
            "name": f"{doc_id}.md",
            "content": content or f"planted {doc_id}",
            meta_key: self.shaped_meta(doc_id, meta_shape),
            "label": None,
        }
        return data_id

    def seed(self, name: str, count: int, prefix: str = "seed", *, meta_shape: str = "dict") -> None:
        """Add `count` documents straight into the dataset (for paging tests)."""
        dataset = self.ensure(name)
        for index in range(count):
            data_id = str(uuid.uuid4())
            dataset["data"][data_id] = {
                "id": data_id,
                "name": f"{prefix}-{index}.md",
                "content": f"seeded {index}",
                "externalMetadata": self.shaped_meta(f"{prefix}-{index}", meta_shape),
                "label": None,
            }


def cognee_route():
    state = CogneeState()

    def route(method: str, path: str, body):
        split = urlsplit(path)
        bare = split.path
        query = parse_qs(split.query)
        for (fail_method, prefix), reply in list(state.fail.items()):
            if method == fail_method and bare.startswith(prefix):
                return reply
        if bare == "/health" and method == "GET":
            return 200, {"status": "ready"}
        if bare == "/api/v1/datasets":
            if method == "GET":
                return 200, [{"id": d["id"], "name": d["name"], "createdAt": "2026-01-01T00:00:00Z", "ownerId": "owner"} for d in state.datasets.values()]
            if method == "POST":
                dataset = state.ensure(body["name"])
                return 200, {"id": dataset["id"], "name": dataset["name"], "createdAt": "2026-01-01T00:00:00Z", "ownerId": "owner"}
        if match := DATA.match(bare):
            dataset = state.datasets.get(match.group(1))
            if dataset is None:
                return 404, {"detail": "dataset not found"}
            if method == "GET" and match.group(2) is None:
                limit = int(query.get("limit", ["100"])[0])
                offset = int(query.get("offset", ["0"])[0])
                if not 1 <= limit <= 1000:
                    return 422, {"detail": "limit must be between 1 and 1000"}
                items = list(dataset["data"].values())[offset : offset + limit]
                return 200, [{key: value for key, value in item.items() if key != "content"} for item in items]
            if method == "DELETE" and match.group(2) is not None:
                dataset["data"].pop(match.group(2), None)
                return 200, {}
        if bare == "/api/v1/add" and method == "POST":
            if not isinstance(body, dict) or "fields" not in body:
                return 422, {"detail": "add expects multipart/form-data"}
            fields, files = body["fields"], body["files"]
            if not files or "datasetName" not in fields:
                return 400, {"detail": "datasetName and a data file are required"}
            dataset = state.ensure(fields["datasetName"])
            metadata = json.loads(fields["external_metadata"]) if "external_metadata" in fields else []
            labels = json.loads(fields["labels"]) if "labels" in fields else []
            for index, upload in enumerate(files):
                same_name = [item for item in dataset["data"].values() if item["name"] == upload["filename"]]
                if same_name and any(item["content"] != upload["content"] for item in same_name):
                    return 409, {"detail": "file exists with different content; use PATCH /api/v1/update"}
                if same_name:
                    continue
                digest = hashlib.sha256(upload["content"].encode()).hexdigest()
                if any(hashlib.sha256(item["content"].encode()).hexdigest() == digest for item in dataset["data"].values()):
                    continue
                data_id = str(uuid.uuid4())
                dataset["data"][data_id] = {
                    "id": data_id,
                    "name": upload["filename"],
                    "content": upload["content"],
                    "externalMetadata": metadata[index] if index < len(metadata) else None,
                    "label": labels[index] or None if index < len(labels) else None,
                }
            return 200, {"status": "PipelineRunCompleted", "dataset_id": dataset["id"]}
        if bare == "/api/v1/cognify" and method == "POST":
            for name in body["datasets"]:
                dataset = state.by_name(name)
                if dataset is None or not dataset["data"]:
                    return 400, {"detail": f"dataset {name} has no data to cognify"}
            state.cognified.append(body)
            return 200, {"pipeline_run_id": str(uuid.uuid4())}
        return 500, {"detail": f"unexpected {method} {path}"}

    route.state = state
    return route
