import asyncio
import ast
from pathlib import Path
from unittest.mock import AsyncMock, patch
import httpx
from src.activities.omi_sync import reconcile_omi_chat_tasks
from src.workflows.omi_sync import OmiSyncWorkflow

def test_activity_uses_controller_and_propagates_failure(monkeypatch):
    monkeypatch.setenv('ALFRED_CTRL_URL', 'http://controller.test:3100')
    monkeypatch.setenv('AAS_API_KEY', 'test-key')
    seen = []
    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={'messages': 2, 'updated': 1})
    real = httpx.AsyncClient
    with patch('src.activities.omi_sync.httpx.AsyncClient', side_effect=lambda **kw: real(transport=httpx.MockTransport(handle), **kw)):
        assert asyncio.run(reconcile_omi_chat_tasks()) == {'messages': 2, 'updated': 1}
    assert str(seen[0].url) == 'http://controller.test:3100/api/v1/channels/omi/pilot/sync'
    assert seen[0].headers['authorization'] == 'Bearer test-key'

def test_workflow_does_not_retry_uncertain_provider_actions():
    execute = AsyncMock(return_value={'disabled': True})
    with patch('src.workflows.omi_sync.workflow.execute_activity', execute):
        assert asyncio.run(OmiSyncWorkflow().run()) == {'disabled': True}
    assert execute.call_args.kwargs['retry_policy'].maximum_attempts == 1

def test_schedule_registered_at_one_minute_and_worker_has_both_handlers():
    root = Path(__file__).parents[1]
    tree = ast.parse((root / 'scripts/register_schedules.py').read_text())
    schedule = next(n for n in ast.walk(tree) if isinstance(n, ast.Dict) and
                    any(isinstance(v, ast.Constant) and v.value == 'al-omi-chat-tasks' for v in n.values))
    values = {k.value: v for k,v in zip(schedule.keys,schedule.values)}
    assert values['workflow'].value == 'OmiSyncWorkflow'
    assert values['interval'].keywords[0].arg == 'minutes'
    assert values['interval'].keywords[0].value.value == 1
    worker = (root / 'src/worker.py').read_text()
    assert worker.count('    OmiSyncWorkflow,') == 1
    assert worker.count('    reconcile_omi_chat_tasks,') == 1
