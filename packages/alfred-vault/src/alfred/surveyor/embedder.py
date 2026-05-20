"""Stage 2: Ollama embedding + Milvus Lite upsert/delete."""

from __future__ import annotations

import asyncio
from pathlib import Path

from urllib.parse import quote, unquote

import httpx
import numpy as np
import structlog
from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

from .config import MilvusConfig, OllamaConfig
from .parser import VaultRecord, build_embedding_text, parse_file
from .state import PipelineState

log = structlog.get_logger()

# Retry config
MAX_RETRIES = 5
RETRY_BASE_DELAY = 2.0
# Throttle between sequential embedding requests (seconds). Applied only when
# hitting local Ollama (unbounded local compute wants pacing to avoid
# thrashing the GPU/CPU). Cloud APIs don't need it — their own rate limits
# protect the backend, and inter-request sleep just wastes wall time.
EMBED_THROTTLE_LOCAL = 0.2
EMBED_THROTTLE_CLOUD = 0.0

# Maximum number of inputs per batched embeddings request. OpenAI's
# embeddings API accepts up to 2048 per call; other OpenAI-compatible
# providers vary. Conservative default trades some batch size for
# compatibility across endpoints. Local Ollama's /api/embeddings does NOT
# support batching — `_embed_batch` falls back to sequential on the local
# path regardless of this value.
EMBED_BATCH_SIZE = 256

# Chunking config — nomic-embed-text has an 8192-token context window.
# Token-per-char ratio varies by language and content: ~4 for English prose,
# but ~2 for Hungarian/agglutinative languages, and can spike even higher
# for structured markup (YAML, wikilinks, URLs) and code. 3000 chars is
# safe across all observed content (Hungarian VTTs, dense metadata blocks,
# mixed code) with comfortable headroom under 8192 tokens.
# Chunks are embedded independently; resulting vectors are mean-pooled and
# L2-normalized into a single document-level vector.
MAX_CHUNK_CHARS = 3000
CHUNK_OVERLAP_CHARS = 300


def _encode_id(path: str) -> str:
    """URL-encode a vault path for use as a Milvus primary key.

    Milvus Lite's internal upsert runs a filter-expression DELETE under the
    hood (`id == '<path>'`). File paths with apostrophes, spaces, or tokens
    the expression parser treats specially (e.g. "Road" in a filename with
    an earlier `'`) crash with "near 'X': syntax error". URL-encoding
    guarantees the ID only contains safe chars: A-Z, a-z, 0-9, -, _, ., ~.
    """
    return quote(path, safe="")


def _decode_id(encoded: str) -> str:
    """Inverse of _encode_id — recover the original vault path."""
    return unquote(encoded)


def _chunk_text(
    text: str,
    max_chars: int = MAX_CHUNK_CHARS,
    overlap: int = CHUNK_OVERLAP_CHARS,
) -> list[str]:
    """Split text into overlapping chunks, preferring paragraph boundaries.

    Returns a list with a single element when the text fits in one chunk.
    """
    if len(text) <= max_chars:
        return [text]

    chunks: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + max_chars, n)
        # Prefer breaking on a paragraph boundary in the back half of the window
        if end < n:
            para = text.rfind("\n\n", start + max_chars // 2, end)
            if para != -1:
                end = para
        chunks.append(text[start:end])
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return chunks


class Embedder:
    def __init__(
        self,
        ollama_cfg: OllamaConfig,
        milvus_cfg: MilvusConfig,
        vault_path: Path,
        state: PipelineState,
    ) -> None:
        self.api_key = ollama_cfg.api_key
        if self.api_key:
            # OpenAI-compatible endpoint (e.g. OpenRouter)
            self.embed_url = f"{ollama_cfg.base_url}/embeddings"
        else:
            # Native Ollama endpoint
            self.embed_url = f"{ollama_cfg.base_url}/api/embeddings"
        self.model = ollama_cfg.model
        self.embedding_dims = ollama_cfg.embedding_dims
        self.vault_path = vault_path
        self.state = state

        # Persistent HTTP client for embedding calls (connection pooling)
        self._http: httpx.AsyncClient | None = None

        # Milvus Lite client — retry on lock contention from prior process
        self.collection_name = milvus_cfg.collection_name
        import time
        for attempt in range(4):
            try:
                self.milvus = MilvusClient(uri=milvus_cfg.uri)
                break
            except Exception as e:
                if attempt < 3:
                    delay = 2.0 * (2 ** attempt)
                    log.warning("embedder.milvus_retry", attempt=attempt + 1, delay=delay, error=str(e))
                    time.sleep(delay)
                else:
                    raise
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        """Create the Milvus collection if it doesn't exist, or recreate on dim mismatch."""
        if self.milvus.has_collection(self.collection_name):
            # Check if existing collection dim matches configured embedding_dims
            info = self.milvus.describe_collection(self.collection_name)
            for f in info.get("fields", []):
                if f.get("name") == "embedding":
                    existing_dim = f.get("params", {}).get("dim")
                    if existing_dim is not None and int(existing_dim) != self.embedding_dims:
                        log.warning(
                            "embedder.dim_mismatch",
                            existing=existing_dim,
                            configured=self.embedding_dims,
                            action="drop_and_recreate",
                        )
                        self.milvus.drop_collection(self.collection_name)
                        # Invalidate pipeline file-hash state so a full re-embed occurs
                        try:
                            files_state = getattr(self.state, "files", None)
                            if isinstance(files_state, dict):
                                files_state.clear()
                                # Persist cleared state to disk so it survives restarts
                                # (PipelineState.load() may be called later in Daemon.run())
                                self.state.save()
                        except Exception as e:
                            log.warning("embedder.state_invalidate_failed", error=str(e))
                        break
            else:
                return

        schema = CollectionSchema(
            fields=[
                FieldSchema(name="id", dtype=DataType.VARCHAR, is_primary=True, max_length=512),
                FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=self.embedding_dims),
                FieldSchema(name="record_type", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="name", dtype=DataType.VARCHAR, max_length=512),
            ],
            description="Vault file embeddings",
        )
        self.milvus.create_collection(
            collection_name=self.collection_name,
            schema=schema,
        )
        # Create index for vector search
        index_params = self.milvus.prepare_index_params()
        index_params.add_index(
            field_name="embedding",
            index_type="FLAT",
            metric_type="COSINE",
        )
        self.milvus.create_index(
            collection_name=self.collection_name,
            index_params=index_params,
        )
        log.info("embedder.collection_created", name=self.collection_name)

    async def _ensure_http(self) -> httpx.AsyncClient:
        """Lazily create and reuse a persistent HTTP client."""
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(timeout=60.0)
        return self._http

    async def close(self) -> None:
        """Clean up the persistent HTTP client."""
        if self._http is not None and not self._http.is_closed:
            await self._http.aclose()

    @property
    def _is_cloud(self) -> bool:
        """True when embedding calls target an OpenAI-compatible endpoint
        (api_key is set). False for native Ollama."""
        return bool(self.api_key)

    @property
    def _throttle_seconds(self) -> float:
        return EMBED_THROTTLE_CLOUD if self._is_cloud else EMBED_THROTTLE_LOCAL

    async def _embed_batch(self, texts: list[str]) -> list[list[float] | None]:
        """Embed a list of texts in a single API call when on cloud, otherwise
        sequential fallback.

        Returns a list of same length as `texts`, with None entries where a
        specific text failed (mirrors `_embed_single`'s None-on-failure). The
        caller maps these back to their source chunks/documents.

        - **Cloud path (api_key set)**: one POST with `input: [text1, text2, ...]`.
          Response's `data` array comes back in index order. Handles
          context-length errors by halving the batch and retrying (a single
          oversized text in the batch would fail the whole batch; splitting
          isolates the offender so others still succeed).
        - **Local Ollama path**: Ollama's /api/embeddings does not support
          multi-input batching, so we fall back to sequential `_embed_single`
          calls with throttling — preserves prior behaviour.
        """
        if not texts:
            return []

        if not self._is_cloud:
            out: list[list[float] | None] = []
            for idx, t in enumerate(texts):
                emb = await self._embed_single(t)
                out.append(emb)
                if idx < len(texts) - 1 and self._throttle_seconds > 0:
                    await asyncio.sleep(self._throttle_seconds)
            return out

        # Cloud path: single batched request
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = {"model": self.model, "input": texts}
        client = await self._ensure_http()

        for attempt in range(MAX_RETRIES):
            try:
                resp = await client.post(
                    self.embed_url,
                    json=body,
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                items = data.get("data") or []
                # Providers return items with a `index` field that we MUST use
                # to reassemble ordering — don't rely on response order.
                result: list[list[float] | None] = [None] * len(texts)
                for item in items:
                    idx = item.get("index", 0)
                    emb = item.get("embedding")
                    if emb is not None and 0 <= idx < len(texts):
                        result[idx] = emb
                log.debug(
                    "embedder.batch_success",
                    batch_size=len(texts),
                    returned=sum(1 for v in result if v is not None),
                )
                return result
            except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
                detail = ""
                if isinstance(e, httpx.HTTPStatusError):
                    detail = e.response.text[:400]
                # If the batch failed because ONE input is oversized, splitting
                # the batch isolates the offender so the rest succeed.
                if "exceeds the context length" in detail or "maximum context" in detail:
                    if len(texts) == 1:
                        log.warning(
                            "embedder.embed_skipped_oversized",
                            detail=detail[:200],
                            batch_path="cloud",
                        )
                        return [None]
                    mid = len(texts) // 2
                    log.info(
                        "embedder.batch_split_on_oversized",
                        batch_size=len(texts),
                        halves=(mid, len(texts) - mid),
                    )
                    left = await self._embed_batch(texts[:mid])
                    right = await self._embed_batch(texts[mid:])
                    return left + right
                delay = RETRY_BASE_DELAY * (2 ** attempt)
                log.warning(
                    "embedder.batch_retry",
                    attempt=attempt + 1,
                    error=str(e)[:200],
                    detail=detail[:200],
                    delay=delay,
                    batch_size=len(texts),
                )
                await asyncio.sleep(delay)
        log.error("embedder.batch_failed", max_retries=MAX_RETRIES, batch_size=len(texts))
        return [None] * len(texts)

    async def _embed_single(self, text: str) -> list[float] | None:
        """Call embedding API once for a single chunk, with retry.

        Supports Ollama native and OpenAI-compatible endpoints.
        """
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            body = {"model": self.model, "input": text}
        else:
            body = {"model": self.model, "prompt": text}

        client = await self._ensure_http()
        for attempt in range(MAX_RETRIES):
            try:
                resp = await client.post(
                    self.embed_url,
                    json=body,
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                if self.api_key:
                    return data["data"][0]["embedding"]
                return data["embedding"]
            except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
                detail = ""
                if isinstance(e, httpx.HTTPStatusError):
                    detail = e.response.text[:200]
                # Context-length overflow is not retryable — the chunk size
                # is fixed for this call. Bail immediately; the caller may
                # try smaller chunks or skip the document.
                if "exceeds the context length" in detail:
                    log.warning("embedder.embed_skipped_oversized", detail=detail)
                    return None
                delay = RETRY_BASE_DELAY * (2 ** attempt)
                log.warning("embedder.embed_retry", attempt=attempt + 1, error=str(e), detail=detail, delay=delay)
                await asyncio.sleep(delay)
        log.error("embedder.embed_failed", max_retries=MAX_RETRIES)
        return None

    async def _get_embedding(self, text: str) -> list[float] | None:
        """Embed text, chunking if it exceeds the embedding model's context window.

        For multi-chunk documents, each chunk is embedded independently and the
        resulting vectors are mean-pooled and L2-normalized into a single
        document-level vector. This preserves whole-document semantics without
        losing content (vs. truncation) and keeps the downstream clustering
        interface unchanged (one vector per document).

        - Cloud path: all chunks submitted in a single `_embed_batch` call.
        - Local Ollama: falls back to sequential `_embed_single` (with
          throttling inside `_embed_batch`).
        """
        chunks = _chunk_text(text)
        if len(chunks) == 1:
            return await self._embed_single(chunks[0])

        log.info(
            "embedder.chunking",
            total_chars=len(text),
            num_chunks=len(chunks),
        )

        results = await self._embed_batch(chunks)
        vectors: list[list[float]] = []
        for idx, emb in enumerate(results):
            if emb is None:
                log.warning("embedder.chunk_failed", chunk_idx=idx, num_chunks=len(chunks))
                continue
            vectors.append(emb)

        if not vectors:
            return None

        # Mean-pool then L2-normalize (standard practice for multi-chunk embeddings)
        arr = np.array(vectors, dtype=np.float32)
        pooled = arr.mean(axis=0)
        norm = float(np.linalg.norm(pooled))
        if norm > 0.0:
            pooled = pooled / norm
        return pooled.tolist()

    async def process_diff(
        self, new_paths: list[str], changed_paths: list[str], deleted_paths: list[str]
    ) -> dict[str, VaultRecord]:
        """Embed new/changed files, delete removed ones. Returns parsed records.

        On the cloud path (api_key set), this batches across documents AND
        across chunks so a full re-embed of 3,000+ files can complete in
        seconds instead of an hour. On the local Ollama path, preserves the
        old one-file-at-a-time behavior since Ollama's /api/embeddings
        doesn't accept batched inputs anyway.
        """
        records: dict[str, VaultRecord] = {}
        to_embed = new_paths + changed_paths

        if self._is_cloud:
            await self._process_diff_cloud(to_embed, records)
        else:
            await self._process_diff_local(to_embed, records)

        # Delete removed (same path on both)
        for rel_path in deleted_paths:
            try:
                encoded_id = _encode_id(rel_path)
                self.milvus.delete(
                    collection_name=self.collection_name,
                    ids=[encoded_id],
                )
            except Exception as e:
                log.warning("embedder.delete_error", path=rel_path, error=str(e))
            self.state.remove_file(rel_path)
            log.debug("embedder.deleted", path=rel_path)

        log.info(
            "embedder.diff_processed",
            upserted=len(to_embed),
            deleted=len(deleted_paths),
            path=("cloud" if self._is_cloud else "local"),
        )
        return records

    async def _process_diff_local(
        self, to_embed: list[str], records: dict[str, VaultRecord]
    ) -> None:
        """Original one-at-a-time embed loop for local Ollama."""
        for rel_path in to_embed:
            try:
                record = parse_file(self.vault_path, rel_path)
            except Exception as e:
                log.warning("embedder.parse_error", path=rel_path, error=str(e))
                continue

            text = build_embedding_text(record)
            if not text.strip():
                log.debug("embedder.empty_text", path=rel_path)
                continue

            embedding = await self._get_embedding(text)
            if embedding is None:
                continue

            if self._throttle_seconds > 0:
                await asyncio.sleep(self._throttle_seconds)

            self._milvus_upsert(rel_path, record, embedding)
            self.state.mark_embedded(rel_path)
            records[rel_path] = record
            log.debug("embedder.upserted", path=rel_path)

    async def _process_diff_cloud(
        self, to_embed: list[str], records: dict[str, VaultRecord]
    ) -> None:
        """Batched embed loop for cloud providers.

        Fold every document's chunks into a single flat input list, submit in
        batches of `EMBED_BATCH_SIZE`, then reassemble per-document by
        pooling (mean + L2-normalise) the chunks belonging to each document.
        One batch of 256 inputs runs in ~1-2s end-to-end vs ~256 sequential
        calls at ~200ms each (~50s) — a 30-50x speedup on cold re-embed.
        """
        # Stage 1: parse all files, build chunks, track owner per chunk.
        all_chunks: list[str] = []
        # chunk index → rel_path (so we can reassemble after batch returns)
        chunk_owner: list[str] = []
        # rel_path → (record, chunk_indices) so we can map back
        per_doc_chunks: dict[str, list[int]] = {}
        per_doc_record: dict[str, VaultRecord] = {}

        for rel_path in to_embed:
            try:
                record = parse_file(self.vault_path, rel_path)
            except Exception as e:
                log.warning("embedder.parse_error", path=rel_path, error=str(e))
                continue
            text = build_embedding_text(record)
            if not text.strip():
                log.debug("embedder.empty_text", path=rel_path)
                continue
            chunks = _chunk_text(text)
            if not chunks:
                continue
            per_doc_record[rel_path] = record
            per_doc_chunks[rel_path] = []
            for chunk in chunks:
                idx = len(all_chunks)
                all_chunks.append(chunk)
                chunk_owner.append(rel_path)
                per_doc_chunks[rel_path].append(idx)

        if not all_chunks:
            return

        # Stage 2: embed all chunks in batches.
        chunk_embeddings: list[list[float] | None] = [None] * len(all_chunks)
        for start in range(0, len(all_chunks), EMBED_BATCH_SIZE):
            batch = all_chunks[start : start + EMBED_BATCH_SIZE]
            result = await self._embed_batch(batch)
            for i, emb in enumerate(result):
                chunk_embeddings[start + i] = emb

        # Stage 3: pool per-document + upsert.
        for rel_path, indices in per_doc_chunks.items():
            vectors = [chunk_embeddings[i] for i in indices if chunk_embeddings[i] is not None]
            if not vectors:
                log.warning("embedder.doc_all_chunks_failed", path=rel_path)
                continue
            arr = np.array(vectors, dtype=np.float32)
            pooled = arr.mean(axis=0)
            norm = float(np.linalg.norm(pooled))
            if norm > 0.0:
                pooled = pooled / norm
            record = per_doc_record[rel_path]
            self._milvus_upsert(rel_path, record, pooled.tolist())
            self.state.mark_embedded(rel_path)
            records[rel_path] = record
        log.info(
            "embedder.cloud_batch_done",
            docs=len(per_doc_record),
            chunks=len(all_chunks),
            batches=(len(all_chunks) + EMBED_BATCH_SIZE - 1) // EMBED_BATCH_SIZE,
        )

    def _milvus_upsert(self, rel_path: str, record: VaultRecord, embedding: list[float]) -> None:
        """Write one embedding to Milvus with URL-encoded ID.

        Milvus Lite's internal upsert runs a filter-expression DELETE under
        the hood (`id == '<path>'`). File paths with apostrophes, spaces, or
        tokens the expression parser treats specially crash with
        "near 'X': syntax error". URL-encoding guarantees the ID only
        contains safe chars.
        """
        encoded_id = _encode_id(rel_path)
        self.milvus.upsert(
            collection_name=self.collection_name,
            data=[{
                "id": encoded_id,
                "embedding": embedding,
                "record_type": record.record_type,
                "name": record.frontmatter.get("name", rel_path),
            }],
        )

    # Page size for pulling all embeddings out of Milvus.
    #
    # Milvus Lite's `segcore` has an internal result-size cap on how many
    # rows a single `query()` can return. The hard ceiling is ~16,384, but
    # in practice the cap trips well before that once rows carry a fat
    # payload like a 768-dim embedding vector — we've seen
    # `query results exceed the limit size at ... SegmentInterface.cpp:116`
    # crash the surveyor daemon on David's vault at ~12k entity rows with
    # `limit=16_000`. 2,000 rows per page is comfortably under the cap
    # across observed payload shapes and still keeps total round-trips
    # reasonable (a 20k-row vault = 10 pages).
    _GET_ALL_PAGE_SIZE = 2_000

    def get_all_embeddings(self) -> tuple[list[str], np.ndarray] | None:
        """Retrieve all embeddings from Milvus as (paths, matrix).

        Paginates via `query_iterator` so arbitrarily large collections
        don't trip Milvus Lite's `segcore` per-query result-size cap.
        Returns None if collection is empty.
        """
        all_results: list[dict] = []
        iterator = self.milvus.query_iterator(
            collection_name=self.collection_name,
            batch_size=self._GET_ALL_PAGE_SIZE,
            filter="",
            output_fields=["id", "embedding"],
        )
        try:
            while True:
                page = iterator.next()
                if not page:
                    break
                all_results.extend(page)
        finally:
            # query_iterator holds a server-side cursor; closing is
            # mandatory to release it (esp. on milvus-lite where the
            # cursor is a process-local resource).
            try:
                iterator.close()
            except Exception:
                pass

        if not all_results:
            return None

        # IDs in Milvus are URL-encoded (see _encode_id). Decode back to
        # vault-relative paths for downstream consumers (clusterer, writer).
        paths = [_decode_id(r["id"]) for r in all_results]
        vectors = np.array([r["embedding"] for r in all_results], dtype=np.float32)
        return paths, vectors
