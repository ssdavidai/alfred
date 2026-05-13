"""One-shot helper to clear bad llm_agent_id values on all chores.

The static analyzer was momentarily over-greedy and grabbed `"POST"`
(an HTTP method string) as the agent id on every chore. The analyzer
fix tightened the heuristic; this script wipes the stale field so
fresh writes get a clean slate.
"""
import asyncio
import os
from urllib.parse import quote

import httpx


async def go() -> None:
    auth = {"Authorization": f"Bearer {os.environ['AAS_API_KEY']}"}
    async with httpx.AsyncClient(
        base_url="http://ctrl-api:3100", headers=auth, timeout=30,
    ) as c:
        r = await c.get("/api/v1/chores")
        r.raise_for_status()
        for ch in r.json().get("chores", []):
            slug = ch["slug"]
            path = f"chore/{slug}.md"
            pr = await c.patch(
                f"/api/v1/vault/records/{quote(path, safe='')}",
                json={"json_set": {"llm_agent_id": None}},
            )
            print(pr.status_code, slug)


if __name__ == "__main__":
    asyncio.run(go())
