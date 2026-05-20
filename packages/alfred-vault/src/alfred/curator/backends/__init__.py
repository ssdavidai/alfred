"""Backend base class and shared types."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..utils import get_logger

log = get_logger(__name__)


@dataclass
class BackendResult:
    """Result from a backend dispatch.

    The agent writes files directly — we just track success and what changed.
    """

    success: bool = False
    summary: str = ""
    files_changed: list[str] = field(default_factory=list)


VAULT_CLI_REFERENCE = """
## Vault CLI Reference

Use `alfred vault` commands via Bash. Never access the filesystem directly.
All commands output JSON to stdout.

```bash
# Read a record
alfred vault read "person/John Smith.md"

# Search by glob or grep
alfred vault search --glob "person/*.md"
alfred vault search --grep "Eagle Farm"

# List all records of a type
alfred vault list person

# Get compact vault summary
alfred vault context

# Create a record
alfred vault create person "John Smith" --set status=active --set 'org="[[org/Acme]]"'

# Create with body from stdin
echo "# John Smith" | alfred vault create person "John Smith" --set status=active --body-stdin

# Edit a record
alfred vault edit "person/John Smith.md" --set status=inactive
alfred vault edit "conversation/Thread.md" --append 'participants="[[person/Jane]]"'
alfred vault edit "note/My Note.md" --body-append "New paragraph content"

# Move a record
alfred vault move "inbox/raw.md" "inbox/processed/raw.md"

# Delete a record
alfred vault delete "note/garbage.md"
```
"""


def build_prompt(
    inbox_content: str,
    skill_text: str,
    vault_context: str,
    inbox_filename: str,
    vault_path: str,
) -> str:
    """Assemble the full prompt sent to any backend.

    The agent uses ``alfred vault`` CLI commands via Bash.
    """
    return f"""{skill_text}

---

## Vault Access

Use `alfred vault` commands. Never access the filesystem directly.

{VAULT_CLI_REFERENCE}

---

## Current Vault Context

{vault_context}

---

## Inbox File to Process

**Filename:** {inbox_filename}

To read its contents:
```bash
alfred vault read "inbox/{inbox_filename}"
```

```
{inbox_content}
```

---

Process this inbox file now. Search existing vault records as needed, then create/update the appropriate records using `alfred vault` commands. When done, output a brief summary of what you created or modified."""


class BaseBackend(ABC):
    """Abstract base for all agent backends."""

    @abstractmethod
    async def process(
        self,
        inbox_content: str,
        skill_text: str,
        vault_context: str,
        inbox_filename: str,
        vault_path: str,
    ) -> BackendResult:
        """Send inbox content to the agent and return result summary."""
        ...
