"""Parser registry for stream event extraction.

Each parser is a pure function: def parse(raw: dict) -> list[ParsedEvent]
Parsers extract source_ref, summary, and structured data from raw API responses.
"""

from dataclasses import dataclass, field
from typing import Callable

@dataclass
class ParsedEvent:
    source_ref: str
    summary: str
    raw: dict
    event_type: str
    received_at: str
    metadata: dict = field(default_factory=dict)

# Import parsers
from .passthrough import parse as passthrough_parse
from .gmail import parse as gmail_parse
from .github_webhook import parse as github_webhook_parse
from .polar import parse as polar_parse
from .omi import parse as omi_parse

PARSERS: dict[str, Callable[[dict], list[ParsedEvent]]] = {
    "passthrough": passthrough_parse,
    "gmail": gmail_parse,
    "github-webhook": github_webhook_parse,
    "polar": polar_parse,
    "omi": omi_parse,
}

def get_parser(name: str) -> Callable[[dict], list[ParsedEvent]]:
    return PARSERS.get(name, passthrough_parse)
