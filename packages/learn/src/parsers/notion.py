"""Notion parser — converts Notion pages/blocks to vault-ready content."""

from parsers import ParsedEvent
from datetime import datetime


def _blocks_to_markdown(blocks: list[dict]) -> str:
    """Convert Notion block objects to markdown."""
    lines = []
    for block in blocks:
        btype = block.get("type", "")

        # Extract rich text from the block
        rich_texts = block.get(btype, {}).get("rich_text", [])
        text = "".join(rt.get("plain_text", "") for rt in rich_texts)

        if btype == "paragraph":
            lines.append(text)
        elif btype == "heading_1":
            lines.append(f"# {text}")
        elif btype == "heading_2":
            lines.append(f"## {text}")
        elif btype == "heading_3":
            lines.append(f"### {text}")
        elif btype == "bulleted_list_item":
            lines.append(f"- {text}")
        elif btype == "numbered_list_item":
            lines.append(f"1. {text}")
        elif btype == "to_do":
            checked = block.get(btype, {}).get("checked", False)
            lines.append(f"- [{'x' if checked else ' '}] {text}")
        elif btype == "toggle":
            lines.append(f"<details><summary>{text}</summary></details>")
        elif btype == "code":
            lang = block.get(btype, {}).get("language", "")
            lines.append(f"```{lang}\n{text}\n```")
        elif btype == "quote":
            lines.append(f"> {text}")
        elif btype == "callout":
            emoji = block.get(btype, {}).get("icon", {}).get("emoji", "")
            lines.append(f"> {emoji} {text}")
        elif btype == "divider":
            lines.append("---")
        elif btype == "image":
            url = block.get(btype, {}).get("file", {}).get("url", "") or block.get(btype, {}).get("external", {}).get("url", "")
            caption = "".join(rt.get("plain_text", "") for rt in block.get(btype, {}).get("caption", []))
            lines.append(f"![{caption}]({url})")
        elif btype == "bookmark":
            url = block.get(btype, {}).get("url", "")
            lines.append(f"[Bookmark]({url})")
        elif btype == "child_database":
            title = block.get(btype, {}).get("title", "Untitled Database")
            lines.append(f"**[Database: {title}]**")
        elif btype == "child_page":
            title = block.get(btype, {}).get("title", "Untitled Page")
            lines.append(f"**[Subpage: {title}]**")
        else:
            if text:
                lines.append(text)

        lines.append("")  # blank line between blocks

    return "\n".join(lines).strip()


def _extract_page_properties(properties: dict) -> dict:
    """Extract key properties from a Notion page."""
    result = {}
    for key, prop in properties.items():
        ptype = prop.get("type", "")
        if ptype == "title":
            result[key] = "".join(rt.get("plain_text", "") for rt in prop.get("title", []))
        elif ptype == "rich_text":
            result[key] = "".join(rt.get("plain_text", "") for rt in prop.get("rich_text", []))
        elif ptype == "select":
            sel = prop.get("select")
            result[key] = sel.get("name", "") if sel else ""
        elif ptype == "multi_select":
            result[key] = [s.get("name", "") for s in prop.get("multi_select", [])]
        elif ptype == "date":
            d = prop.get("date")
            result[key] = d.get("start", "") if d else ""
        elif ptype == "checkbox":
            result[key] = prop.get("checkbox", False)
        elif ptype == "url":
            result[key] = prop.get("url", "")
        elif ptype == "email":
            result[key] = prop.get("email", "")
        elif ptype == "number":
            result[key] = prop.get("number")
        elif ptype == "status":
            s = prop.get("status")
            result[key] = s.get("name", "") if s else ""
    return result


def _database_to_summary(db_data: dict) -> str:
    """Convert a Notion database to a summary description."""
    title = "".join(rt.get("plain_text", "") for rt in db_data.get("title", []))
    desc = "".join(rt.get("plain_text", "") for rt in db_data.get("description", []))

    # Extract schema (column names and types)
    props = db_data.get("properties", {})
    columns = []
    for name, prop in props.items():
        ptype = prop.get("type", "unknown")
        columns.append(f"- **{name}** ({ptype})")

    lines = [
        f"# {title or 'Untitled Database'}",
        "",
        f"*Notion Database*",
        "",
    ]
    if desc:
        lines.append(desc)
        lines.append("")
    lines.append("## Schema")
    lines.append("")
    lines.extend(columns)

    return "\n".join(lines)


def parse(raw: dict) -> list[ParsedEvent]:
    """Parse a Notion page or search result into ParsedEvents."""
    results = []
    object_type = raw.get("object", "")

    if object_type == "page":
        page_id = raw.get("id", "")
        properties = _extract_page_properties(raw.get("properties", {}))
        title = properties.get("Name", properties.get("title", properties.get("Title", "")))
        if not title:
            # Try to find any title-type property
            for v in properties.values():
                if isinstance(v, str) and v:
                    title = v
                    break

        last_edited = raw.get("last_edited_time", "")
        blocks = raw.get("_blocks", [])  # Blocks attached by the pull activity
        content = _blocks_to_markdown(blocks) if blocks else ""

        # Build summary
        summary = f"Notion: {title}" if title else "Notion page"
        if content:
            summary += f" — {content[:100]}"

        results.append(ParsedEvent(
            source_ref=f"notion:{page_id}",
            summary=summary,
            raw=raw,
            event_type="notion-page",
            received_at=last_edited or datetime.utcnow().isoformat(),
            metadata={
                "notion_page_id": page_id,
                "title": title or "Untitled",
                "properties": properties,
                "content": content,
                "parent_type": raw.get("parent", {}).get("type", ""),
            },
        ))

    elif object_type == "database":
        db_id = raw.get("id", "")
        title = "".join(rt.get("plain_text", "") for rt in raw.get("title", []))
        summary_content = _database_to_summary(raw)

        results.append(ParsedEvent(
            source_ref=f"notion-db:{db_id}",
            summary=f"Notion Database: {title or 'Untitled'}",
            raw=raw,
            event_type="notion-database",
            received_at=raw.get("last_edited_time", datetime.utcnow().isoformat()),
            metadata={
                "notion_database_id": db_id,
                "title": title or "Untitled Database",
                "content": summary_content,
                "schema": {k: v.get("type", "") for k, v in raw.get("properties", {}).items()},
            },
        ))

    elif object_type == "list":
        # Search results — multiple pages/databases
        for item in raw.get("results", []):
            results.extend(parse(item))

    return results
