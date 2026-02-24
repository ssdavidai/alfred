"""
Governance Ledger - HMAC-signed append-only audit ledger.

CRITICAL: Ledger integrity is fundamental to governance.
- Entries are cryptographically linked
- Each entry is signed
- Tampering is detectable

Core Principle: All governance decisions are recorded and auditable.
"""

import hashlib
import hmac
import json
import os
import tempfile
import uuid
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Any
import logging


logger = logging.getLogger(__name__)


class LedgerWriteError(Exception):
    """Raised when ledger write fails.

    This is a critical error - the ledger must be writable for
    governance to function properly.
    """

    pass


class LedgerIntegrityError(Exception):
    """Raised when ledger integrity verification fails.

    This indicates potential tampering or corruption.
    """

    pass


@dataclass
class LedgerEntry:
    """Single entry in the governance ledger.

    Each entry contains:
    - The proposal that was evaluated
    - The enforcement decision made
    - Cryptographic hash linking to previous entry
    - HMAC signature for authenticity

    Attributes:
        entry_id: Unique identifier for this entry
        timestamp: When the entry was created
        proposal: The operation proposal
        decision: The enforcement decision
        previous_hash: Hash of the previous entry (for chain integrity)
        hash: Hash of this entry
        signature: HMAC signature of the hash
    """

    entry_id: str
    timestamp: datetime
    proposal: dict
    decision: dict
    previous_hash: str = ""
    hash: str = ""
    signature: str = ""

    def __post_init__(self):
        """Ensure timestamp is timezone-aware."""
        if isinstance(self.timestamp, str):
            self.timestamp = datetime.fromisoformat(self.timestamp)
        if self.timestamp.tzinfo is None:
            self.timestamp = self.timestamp.replace(tzinfo=timezone.utc)

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "entry_id": self.entry_id,
            "timestamp": self.timestamp.isoformat() if isinstance(self.timestamp, datetime) else self.timestamp,
            "proposal": self.proposal,
            "decision": self.decision,
            "previous_hash": self.previous_hash,
            "hash": self.hash,
            "signature": self.signature,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LedgerEntry":
        """Create from dictionary."""
        return cls(**data)


class GovernanceLedger:
    """HMAC-signed append-only audit ledger.

    CRITICAL: Ledger integrity is fundamental to governance.
    - Entries are cryptographically linked (hash chain)
    - Each entry is signed (HMAC)
    - Tampering is detectable (verify method)

    The ledger uses JSON Lines format (one JSON object per line)
    for efficient appending and streaming.

    Example:
        >>> from pathlib import Path
        >>> ledger = GovernanceLedger(
        ...     path=Path("data/bat-ledger.jsonl"),
        ...     signing_key=b"my-secret-key"
        ... )
        >>> entry_hash = ledger.append(decision, proposal)
        >>> valid, errors = ledger.verify()
    """

    # Genesis hash for the first entry
    GENESIS_HASH = "0" * 64

    def __init__(self, path: Path, signing_key: bytes):
        """Initialize the governance ledger.

        Args:
            path: Path to the ledger file (will be created if needed)
            signing_key: Secret key for HMAC signatures

        Raises:
            OSError: If the ledger file cannot be created
        """
        self._path = Path(path)
        self._key = signing_key

        # Ensure parent directory exists
        self._path.parent.mkdir(parents=True, exist_ok=True)

        # Read the last hash for chain continuity
        self._last_hash = self._read_last_hash()

        logger.info(f"Ledger initialized at {self._path}")

    @property
    def path(self) -> Path:
        """Get the ledger file path."""
        return self._path

    def _read_last_hash(self) -> str:
        """Read the hash of the last entry in the ledger.

        Returns:
            Hash of the last entry, or GENESIS_HASH if empty
        """
        if not self._path.exists():
            return self.GENESIS_HASH

        try:
            with open(self._path, "r", encoding="utf-8") as f:
                last_line = None
                for line in f:
                    line = line.strip()
                    if line:
                        last_line = line

                if last_line:
                    entry = json.loads(last_line)
                    return entry.get("hash", self.GENESIS_HASH)

        except (OSError, json.JSONDecodeError) as e:
            logger.warning(f"Error reading last hash: {e}")

        return self.GENESIS_HASH

    def _compute_hash(self, entry: dict) -> str:
        """Compute SHA-256 hash of an entry.

        Args:
            entry: Dictionary to hash

        Returns:
            Hexadecimal SHA-256 hash string
        """
        # Exclude hash and signature from hash computation
        data = {k: v for k, v in entry.items() if k not in ("hash", "signature")}
        data_str = json.dumps(data, sort_keys=True, default=str)
        return hashlib.sha256(data_str.encode()).hexdigest()

    def _sign(self, data: str) -> str:
        """Create HMAC-SHA256 signature.

        Args:
            data: String to sign

        Returns:
            Hexadecimal HMAC signature
        """
        return hmac.new(self._key, data.encode(), hashlib.sha256).hexdigest()

    def _serialize_for_ledger(self, obj: Any) -> dict:
        """Serialize an object for ledger storage.

        Args:
            obj: Object to serialize (dataclass or dict)

        Returns:
            Dictionary representation
        """
        if hasattr(obj, '__dataclass_fields__'):
            return asdict(obj)
        elif hasattr(obj, 'to_dict'):
            return obj.to_dict()
        elif isinstance(obj, dict):
            return obj
        else:
            return {"value": str(obj)}

    def append(self, decision: Any, proposal: Any) -> str:
        """Append a decision to the ledger.

        This method:
        1. Creates a new ledger entry
        2. Links it to the previous entry via hash chain
        3. Signs the entry with HMAC
        4. Writes atomically to the ledger file

        Args:
            decision: The enforcement decision
            proposal: The operation proposal

        Returns:
            Hash of the new entry

        Raises:
            LedgerWriteError: If the write fails

        Example:
            >>> entry_hash = ledger.append(decision, proposal)
            >>> len(entry_hash)
            64
        """
        # Create entry
        entry_data = {
            "entry_id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "proposal": self._serialize_for_ledger(proposal),
            "decision": self._serialize_for_ledger(decision),
            "previous_hash": self._last_hash,
        }

        # Compute hash chain
        entry_data["hash"] = self._compute_hash(entry_data)

        # Sign
        entry_data["signature"] = self._sign(entry_data["hash"])

        # Write atomically
        try:
            # Append to file
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry_data) + "\n")
                f.flush()
                os.fsync(f.fileno())

            self._last_hash = entry_data["hash"]

            logger.debug(
                f"Ledger entry written: id={entry_data['entry_id'][:8]}... "
                f"hash={entry_data['hash'][:8]}..."
            )

            return entry_data["hash"]

        except OSError as e:
            # FAIL-CLOSED: Ledger write failure is critical
            logger.error(f"Ledger write failed: {e}")
            raise LedgerWriteError(f"Failed to write to ledger: {e}")

    def verify(self) -> tuple[bool, list[str]]:
        """Verify ledger integrity.

        This method checks:
        1. Hash chain integrity (each entry links to previous)
        2. Hash correctness (each entry's hash is correct)
        3. Signature validity (each entry is properly signed)

        Returns:
            Tuple of (is_valid, list_of_errors)

        Example:
            >>> valid, errors = ledger.verify()
            >>> if not valid:
            ...     print(f"Ledger corrupted: {errors}")
        """
        errors = []
        prev_hash = self.GENESIS_HASH

        if not self._path.exists():
            # Empty ledger is valid
            return True, []

        try:
            with open(self._path, "r", encoding="utf-8") as f:
                for i, line in enumerate(f):
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError as e:
                        errors.append(f"Line {i+1}: Invalid JSON - {e}")
                        continue

                    # Verify hash chain
                    if entry.get("previous_hash") != prev_hash:
                        errors.append(
                            f"Line {i+1}: Hash chain broken - "
                            f"expected {prev_hash[:8]}..., "
                            f"got {entry.get('previous_hash', 'missing')[:8]}..."
                        )

                    # Verify hash
                    expected_hash = self._compute_hash(entry)
                    if entry.get("hash") != expected_hash:
                        errors.append(
                            f"Line {i+1}: Hash mismatch - "
                            f"entry may have been tampered with"
                        )

                    # Verify signature
                    expected_sig = self._sign(entry.get("hash", ""))
                    if entry.get("signature") != expected_sig:
                        errors.append(
                            f"Line {i+1}: Invalid signature - "
                            f"entry may have been tampered with"
                        )

                    prev_hash = entry.get("hash", "")

        except OSError as e:
            errors.append(f"Read error: {e}")

        is_valid = len(errors) == 0

        if is_valid:
            logger.info("Ledger integrity verified successfully")
        else:
            logger.error(f"Ledger integrity check failed: {len(errors)} errors")

        return is_valid, errors

    def read_entries(
        self,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> list[LedgerEntry]:
        """Read entries from the ledger.

        Args:
            limit: Maximum number of entries to read (None for all)
            offset: Number of entries to skip

        Returns:
            List of ledger entries
        """
        entries = []

        if not self._path.exists():
            return entries

        try:
            with open(self._path, "r", encoding="utf-8") as f:
                for i, line in enumerate(f):
                    if i < offset:
                        continue
                    if limit is not None and len(entries) >= limit:
                        break

                    line = line.strip()
                    if line:
                        try:
                            entry = json.loads(line)
                            entries.append(LedgerEntry.from_dict(entry))
                        except json.JSONDecodeError:
                            continue

        except OSError as e:
            logger.error(f"Error reading ledger: {e}")

        return entries

    def count(self) -> int:
        """Count the number of entries in the ledger.

        Returns:
            Number of entries
        """
        if not self._path.exists():
            return 0

        count = 0
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        count += 1
        except OSError:
            pass

        return count

    def get_stats(self) -> dict:
        """Get ledger statistics.

        Returns:
            Dictionary with ledger statistics
        """
        entries = self.read_entries(limit=1000)  # Sample for stats

        if not entries:
            return {
                "total_entries": 0,
                "first_entry": None,
                "last_entry": None,
                "actions": {},
                "risk_levels": {},
            }

        actions = {}
        risk_levels = {}

        for entry in entries:
            action = entry.decision.get("action", "unknown")
            actions[action] = actions.get(action, 0) + 1

            level = entry.decision.get("classification", {}).get("level", "unknown")
            risk_levels[level] = risk_levels.get(level, 0) + 1

        return {
            "total_entries": self.count(),
            "first_entry": entries[0].timestamp.isoformat() if entries else None,
            "last_entry": entries[-1].timestamp.isoformat() if entries else None,
            "actions": actions,
            "risk_levels": risk_levels,
        }

    def export(self, output_path: Path) -> int:
        """Export ledger to a file.

        Args:
            output_path: Path to write the export

        Returns:
            Number of entries exported
        """
        entries = self.read_entries()

        with open(output_path, "w", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry.to_dict()) + "\n")

        return len(entries)
