import json
from types import SimpleNamespace
import httpx
import pytest
from src.activities.stream_log import emit_workflow_audit_event
from src.config import Config
from src.utils.state_client import StateClient

def _client(handler) -> StateClient:
    return StateClient(Config(alfred_ctrl_url="http://ctrl-api:3100"), transport=httpx.MockTransport(handler))

async def test_emitter_posts_completed_and_failed_correlations():
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(201, json={"id": "audit-1"})
    client = _client(handler)
    try:
        await emit_workflow_audit_event(workflow_id="wf-1", run_id="run-1",
            workflow_type="SignalExtractWorkflow", outcome="completed", client=client,
        )
        await emit_workflow_audit_event(workflow_id="wf-2", run_id="run-2",
            workflow_type="SignalExtractWorkflow", outcome="failed",
            error="extractor unavailable", client=client,
        )
    finally:
        await client.close()
    bodies = [json.loads(request.content) for request in requests]
    assert {request.url.path for request in requests} == {"/api/v1/state/audit"}
    assert all(body["action_type"] == "workflow_run" for body in bodies)
    assert all(body["actor"] == "alfred-learn" for body in bodies)
    assert bodies[0]["payload"] == {
        "workflow_id": "wf-1", "run_id": "run-1", "workflow_type": "SignalExtractWorkflow",
        "outcome": "completed",
    }
    assert bodies[1]["payload"] == {
        "workflow_id": "wf-2", "run_id": "run-2", "workflow_type": "SignalExtractWorkflow",
        "outcome": "failed",
    }
    assert "failed: extractor unavailable" in bodies[1]["summary"]

async def test_emitter_swallows_ctrl_api_http_error(caplog):
    seen_paths = []
    def handler(request):
        seen_paths.append(request.url.path)
        return httpx.Response(503, text="unavailable")
    client = _client(handler)
    try:
        await emit_workflow_audit_event(
            workflow_id="wf-3", run_id="run-3",
            workflow_type="SignalExtractWorkflow", outcome="started", client=client,
        )
    finally:
        await client.close()
    assert seen_paths == ["/api/v1/state/audit"]
    assert "workflow audit POST failed" in caplog.text

async def test_worker_interceptor_emits_all_transitions(monkeypatch):
    from src import worker as learn_worker
    emitted = []
    monkeypatch.setattr(
        learn_worker.workflow, "extern_functions",
        lambda: {learn_worker._WORKFLOW_AUDIT_EXTERN: emitted.append},
    )
    monkeypatch.setattr(
        learn_worker.workflow, "info",
        lambda: SimpleNamespace(
            workflow_id="wf-scheduled", run_id="run-scheduled",
            workflow_type="SignalExtractWorkflow",
        ),
    )
    monkeypatch.setattr(learn_worker.workflow.unsafe, "is_replaying", lambda: False)
    class Next:
        def __init__(self, error=None):
            self.error = error
        async def execute_workflow(self, _input):
            if self.error:
                raise self.error
            return "ok"
    interceptor = learn_worker._WorkflowAuditInboundInterceptor(Next())
    assert await interceptor.execute_workflow(None) == "ok"
    with pytest.raises(RuntimeError, match="boom"):
        await learn_worker._WorkflowAuditInboundInterceptor(Next(
            RuntimeError("boom"))).execute_workflow(None)
    assert [event["outcome"] for event in emitted] == ["started", "completed", "started", "failed"]
    assert all(event["workflow_id"] == "wf-scheduled" for event in emitted)
    def fail_audit(_event):
        raise RuntimeError("audit scheduler failed")
    interceptor._emit = fail_audit
    assert await interceptor.execute_workflow(None) == "ok"
    interceptor.next = Next(ValueError("original workflow failure"))
    with pytest.raises(ValueError, match="original workflow failure"):
        await interceptor.execute_workflow(None)
