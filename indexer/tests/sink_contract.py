"""Reusable contract test for `sinks.Sink` implementations (Hindsight, mem0, cognee, ...).

A provider test supplies two factories and calls `run_sink_contract`:

    from sink_contract import run_sink_contract
    from stub_server import serving

    def test_mem0_sink_contract():
        run_sink_contract(
            lambda url: sinks.get_sink("mem0", url=url),
            lambda: serving(mem0_route),          # context manager yielding a RecordingStub
        )

`mem0_route(method, path, body) -> (status, json)` must emulate the provider well enough that, in order: the
health endpoint answers 2xx; prepare, retain (every optional argument) and delete of a stored document succeed;
and delete of a document the provider does not know replies the way the provider does for "not found" (the
contract requires the sink to swallow that). For an asynchronous provider (`capabilities.async_ingest`) the stub
only has to accept the calls.

The function returns a `ContractResult` mapping each step to the stub requests it caused, so a provider test can
add exact path/body assertions on top of the generic checks without re-running anything.

Generic guarantees checked: protocol conformance; health() True against a live stub and False (no exception)
against a closed port; prepare() idempotent; retain() accepts minimal and full arguments, and retaining one doc_id
twice neither raises nor is skipped (the sink forwards the second upsert); delete() of an existing and of an
unknown document does not raise; every sink call on an unreachable server raises SinkError or OSError; and a
bank name with spaces, slashes and colons is accepted.
"""

from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field

import pytest

import sinks
from stub_server import RecordingStub, closed_port_url


AWKWARD_BANK = "coding-agent::proj with space/and slash"


@dataclass
class ContractResult:
    steps: dict[str, list[dict]] = field(default_factory=dict)


def run_sink_contract(
    sink_factory: Callable[[str], sinks.Sink],
    stub_factory: Callable[[], AbstractContextManager[RecordingStub]],
    *,
    bank: str = "contract::bank",
) -> ContractResult:
    result = ContractResult()

    with stub_factory() as stub:
        sink = sink_factory(stub.url)

        assert isinstance(sink, sinks.Sink), "object does not satisfy the Sink protocol"
        assert isinstance(sink.capabilities, sinks.Capabilities)

        def step(name: str, action: Callable[[], object]) -> None:
            stub.clear()
            action()
            result.steps[name] = list(stub.requests)

        step("health", lambda: _expect(sink.health() is True, "health() must be True against a live stub"))

        step("prepare", lambda: sink.prepare(bank))
        step("prepare_again", lambda: sink.prepare(bank))

        step("retain_minimal", lambda: sink.retain(bank, "doc-1", "first body"))
        _expect(result.steps["retain_minimal"], "retain() sent no request")

        step(
            "retain_full",
            lambda: sink.retain(
                bank,
                "doc-2",
                "second body",
                tags=["a", "b"],
                metadata={"path": "x.md", "kind": "doc"},
                context="Project proj doc source",
                timestamp="2026-01-02T03:04:05Z",
            ),
        )
        _expect(result.steps["retain_full"], "retain() with all arguments sent no request")

        step("retain_upsert", lambda: sink.retain(bank, "doc-1", "first body, edited"))
        _expect(result.steps["retain_upsert"], "second retain of the same doc_id was not forwarded")

        step("retain_awkward_bank", lambda: sink.retain(AWKWARD_BANK, "doc-3", "body"))
        for request in result.steps["retain_awkward_bank"]:
            assert " " not in request["path"], f"unencoded space in request target {request['path']!r}"

        step("delete", lambda: sink.delete(bank, "doc-1"))
        step("delete_missing", lambda: sink.delete(bank, "never-retained"))

    dead = sink_factory(closed_port_url())
    assert dead.health() is False, "health() must return False, not raise, when the server is down"
    for call in (lambda: dead.retain(bank, "doc-1", "x"), lambda: dead.delete(bank, "doc-1")):
        with pytest.raises((sinks.SinkError, OSError)):
            call()
    return result


def _expect(condition: object, message: str) -> None:
    assert condition, message
