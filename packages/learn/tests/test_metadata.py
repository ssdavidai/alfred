"""Tests for input metadata extraction."""

import pytest

from src.matching.metadata import extract_input_metadata


class TestExtractInputMetadata:
    async def test_extracts_domains(self):
        event = {"summary": "Email from user@clientx.com about project"}
        metadata = await extract_input_metadata(event)
        assert "clientx.com" in metadata["domains"]

    async def test_extracts_multiple_domains(self):
        event = {"summary": "Thread between user@clientx.com and admin@vendor.org"}
        metadata = await extract_input_metadata(event)
        assert "clientx.com" in metadata["domains"]
        assert "vendor.org" in metadata["domains"]

    async def test_extracts_keywords(self):
        event = {"summary": "Invoice for payment of consulting services invoice"}
        metadata = await extract_input_metadata(event)
        assert "invoice" in metadata["keywords"]
        assert "payment" in metadata["keywords"]

    async def test_filters_stopwords(self):
        event = {"summary": "The invoice is for the payment"}
        metadata = await extract_input_metadata(event)
        assert "the" not in metadata["keywords"]
        assert "for" not in metadata["keywords"]

    async def test_extracts_from_raw(self):
        event = {
            "raw": {
                "subject": "Invoice #1234",
                "body": "Please find attached the invoice for March services.",
            }
        }
        metadata = await extract_input_metadata(event)
        assert "invoice" in metadata["keywords"]

    async def test_extracts_attachment_patterns(self):
        event = {"summary": "Attached file: report.pdf and data.xlsx"}
        metadata = await extract_input_metadata(event)
        assert any(".pdf" in p for p in metadata["attachment_patterns"])
        assert any(".xlsx" in p for p in metadata["attachment_patterns"])

    async def test_uses_stream_type(self):
        event = {"stream_type": "email", "summary": "test"}
        metadata = await extract_input_metadata(event)
        assert metadata["input_type"] == "email"

    async def test_uses_classification_type_fallback(self):
        event = {"classification": {"type": "task"}, "summary": "test"}
        metadata = await extract_input_metadata(event)
        assert metadata["input_type"] == "task"

    async def test_extracts_tags_from_classification(self):
        event = {
            "classification": {"tags": ["finance", "invoice"]},
            "summary": "test",
        }
        metadata = await extract_input_metadata(event)
        assert metadata["tags"] == ["finance", "invoice"]

    async def test_empty_event(self):
        metadata = await extract_input_metadata({})
        assert metadata["domains"] == []
        assert isinstance(metadata["keywords"], list)
        assert metadata["input_type"] == "other"

    async def test_extracts_from_messages(self):
        event = {
            "raw": {
                "messages": [
                    {"content": "Please handle the invoice from vendor.com"},
                    {"content": "Filed under finance/invoices"},
                ]
            }
        }
        metadata = await extract_input_metadata(event)
        assert "invoice" in metadata["keywords"]

    async def test_keyword_limit(self):
        # Keywords are limited to top 15
        long_text = " ".join(f"word{i}" * 3 for i in range(30))
        event = {"summary": long_text}
        metadata = await extract_input_metadata(event)
        assert len(metadata["keywords"]) <= 15
