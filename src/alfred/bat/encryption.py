"""
Ledger Encryption - Encryption at rest for governance ledger.

Implements SECURITY ELEVATION Phase 2:
- Optional encryption for enterprise mode
- AES-256-GCM for confidentiality and integrity
- Key derivation from master key
- Secure key storage integration

Core Principle: Ledger is governed confidential state.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple
import hashlib
import json
import logging
import os
import secrets

logger = logging.getLogger(__name__)


class EncryptionError(Exception):
    """Raised when encryption/decryption fails."""
    pass


class KeyDerivationError(Exception):
    """Raised when key derivation fails."""
    pass


@dataclass
class EncryptedBlock:
    """An encrypted block of ledger data.
    
    Attributes:
        nonce: Random nonce for AES-GCM
        ciphertext: Encrypted data
        tag: Authentication tag
        version: Encryption version
    """
    nonce: bytes
    ciphertext: bytes
    tag: bytes
    version: int = 1
    
    def serialize(self) -> bytes:
        """Serialize to bytes for storage."""
        # Format: version(1) + nonce_len(2) + nonce + tag_len(2) + tag + ciphertext
        data = bytes([self.version])
        data += len(self.nonce).to_bytes(2, 'big')
        data += self.nonce
        data += len(self.tag).to_bytes(2, 'big')
        data += self.tag
        data += self.ciphertext
        return data
    
    @classmethod
    def deserialize(cls, data: bytes) -> "EncryptedBlock":
        """Deserialize from bytes."""
        offset = 0
        
        version = data[offset]
        offset += 1
        
        nonce_len = int.from_bytes(data[offset:offset+2], 'big')
        offset += 2
        nonce = data[offset:offset+nonce_len]
        offset += nonce_len
        
        tag_len = int.from_bytes(data[offset:offset+2], 'big')
        offset += 2
        tag = data[offset:offset+tag_len]
        offset += tag_len
        
        ciphertext = data[offset:]
        
        return cls(
            nonce=nonce,
            ciphertext=ciphertext,
            tag=tag,
            version=version,
        )


class LedgerEncryption:
    """Encryption for ledger data at rest.
    
    Uses AES-256-GCM for:
    - Confidentiality: Data cannot be read without key
    - Integrity: Any tampering is detected
    - Authentication: Verified sender
    
    Core Principle: Ledger is governed confidential state.
    """
    
    KEY_SIZE = 32  # AES-256
    NONCE_SIZE = 12  # 96 bits for GCM
    TAG_SIZE = 16  # 128 bits
    VERSION = 1
    
    def __init__(
        self,
        master_key: Optional[bytes] = None,
        key_derivation_salt: Optional[bytes] = None,
    ):
        """Initialize ledger encryption.
        
        Args:
            master_key: Master encryption key (if None, generates new key)
            key_derivation_salt: Salt for key derivation
        """
        if master_key is None:
            master_key = secrets.token_bytes(self.KEY_SIZE)
        
        if len(master_key) < 32:
            raise KeyDerivationError("Master key must be at least 32 bytes")
        
        self._master_key = master_key[:self.KEY_SIZE]
        self._salt = key_derivation_salt or secrets.token_bytes(16)
        self._derived_keys: dict[str, bytes] = {}
    
    @property
    def salt(self) -> bytes:
        """Get the key derivation salt."""
        return self._salt
    
    @classmethod
    def generate_master_key(cls) -> bytes:
        """Generate a new master key.
        
        Returns:
            32-byte master key
        """
        return secrets.token_bytes(cls.KEY_SIZE)
    
    @classmethod
    def derive_key_from_password(
        cls,
        password: str,
        salt: Optional[bytes] = None,
        iterations: int = 100000,
    ) -> Tuple[bytes, bytes]:
        """Derive a master key from a password.
        
        Uses PBKDF2-HMAC-SHA256 for key derivation.
        
        Args:
            password: User password
            salt: Salt for derivation (generates if None)
            iterations: PBKDF2 iterations
        
        Returns:
            Tuple of (master_key, salt)
        """
        if salt is None:
            salt = secrets.token_bytes(16)
        
        key = hashlib.pbkdf2_hmac(
            'sha256',
            password.encode('utf-8'),
            salt,
            iterations,
            dklen=cls.KEY_SIZE,
        )
        
        return key, salt
    
    def encrypt(self, plaintext: bytes, context: str = "ledger") -> EncryptedBlock:
        """Encrypt data.
        
        Args:
            plaintext: Data to encrypt
            context: Context for key derivation (e.g., "ledger", "secrets")
        
        Returns:
            EncryptedBlock with encrypted data
        
        Raises:
            EncryptionError: If encryption fails
        """
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            
            # Get or derive context-specific key
            key = self._get_context_key(context)
            
            # Generate nonce
            nonce = secrets.token_bytes(self.NONCE_SIZE)
            
            # Encrypt
            aesgcm = AESGCM(key)
            ciphertext_with_tag = aesgcm.encrypt(nonce, plaintext, None)
            
            # Split ciphertext and tag
            ciphertext = ciphertext_with_tag[:-self.TAG_SIZE]
            tag = ciphertext_with_tag[-self.TAG_SIZE:]
            
            return EncryptedBlock(
                nonce=nonce,
                ciphertext=ciphertext,
                tag=tag,
                version=self.VERSION,
            )
            
        except ImportError:
            logger.warning("cryptography not installed - using fallback encryption")
            return self._fallback_encrypt(plaintext, context)
        except Exception as e:
            raise EncryptionError(f"Encryption failed: {e}")
    
    def decrypt(self, block: EncryptedBlock, context: str = "ledger") -> bytes:
        """Decrypt data.
        
        Args:
            block: Encrypted block
            context: Context for key derivation
        
        Returns:
            Decrypted plaintext
        
        Raises:
            EncryptionError: If decryption fails or integrity check fails
        """
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            
            # Get context-specific key
            key = self._get_context_key(context)
            
            # Decrypt
            aesgcm = AESGCM(key)
            ciphertext_with_tag = block.ciphertext + block.tag
            plaintext = aesgcm.decrypt(block.nonce, ciphertext_with_tag, None)
            
            return plaintext
            
        except ImportError:
            logger.warning("cryptography not installed - using fallback decryption")
            return self._fallback_decrypt(block, context)
        except Exception as e:
            raise EncryptionError(f"Decryption failed: {e}")
    
    def _get_context_key(self, context: str) -> bytes:
        """Get or derive a context-specific key.
        
        Each context (ledger, secrets, etc.) gets its own derived key
        to prevent key reuse across contexts.
        """
        if context not in self._derived_keys:
            # Derive context-specific key using HKDF-like approach
            context_bytes = context.encode('utf-8')
            derived = hashlib.sha256(
                self._master_key + self._salt + context_bytes
            ).digest()
            self._derived_keys[context] = derived
        
        return self._derived_keys[context]
    
    def _fallback_encrypt(self, plaintext: bytes, context: str) -> EncryptedBlock:
        """Fallback encryption when cryptography library not available.
        
        WARNING: This is NOT secure. Install the cryptography library
        for production use.
        """
        import warnings
        warnings.warn(
            "Using fallback encryption - NOT SECURE. "
            "Install cryptography library: pip install cryptography"
        )
        
        # Simple XOR with derived key (NOT SECURE - for testing only)
        key = self._get_context_key(context)
        nonce = secrets.token_bytes(self.NONCE_SIZE)
        
        # Extend key to plaintext length
        key_stream = hashlib.sha256(key + nonce).digest()
        while len(key_stream) < len(plaintext):
            key_stream += hashlib.sha256(key_stream).digest()
        
        ciphertext = bytes(p ^ k for p, k in zip(plaintext, key_stream))
        tag = hashlib.sha256(ciphertext + nonce + key).digest()[:self.TAG_SIZE]
        
        return EncryptedBlock(
            nonce=nonce,
            ciphertext=ciphertext,
            tag=tag,
            version=self.VERSION,
        )
    
    def _fallback_decrypt(self, block: EncryptedBlock, context: str) -> bytes:
        """Fallback decryption when cryptography library not available."""
        import warnings
        warnings.warn(
            "Using fallback decryption - NOT SECURE. "
            "Install cryptography library: pip install cryptography"
        )
        
        key = self._get_context_key(context)
        
        # Verify tag
        expected_tag = hashlib.sha256(
            block.ciphertext + block.nonce + key
        ).digest()[:self.TAG_SIZE]
        
        if not secrets.compare_digest(block.tag, expected_tag):
            raise EncryptionError("Integrity check failed")
        
        # Decrypt
        key_stream = hashlib.sha256(key + block.nonce).digest()
        while len(key_stream) < len(block.ciphertext):
            key_stream += hashlib.sha256(key_stream).digest()
        
        plaintext = bytes(c ^ k for c, k in zip(block.ciphertext, key_stream))
        return plaintext


class EncryptedLedgerWriter:
    """Writer for encrypted ledger files.
    
    Provides transparent encryption for ledger entries.
    """
    
    def __init__(
        self,
        path: Path,
        encryption: LedgerEncryption,
        context: str = "ledger",
    ):
        """Initialize the encrypted ledger writer.
        
        Args:
            path: Path to the ledger file
            encryption: Ledger encryption instance
            context: Encryption context
        """
        self._path = Path(path)
        self._encryption = encryption
        self._context = context
        self._buffer: list[bytes] = []
    
    def write_entry(self, entry: dict) -> None:
        """Write an encrypted entry to the ledger.
        
        Args:
            entry: Ledger entry dictionary
        """
        # Serialize entry
        entry_bytes = json.dumps(entry, default=str).encode('utf-8')
        
        # Encrypt
        block = self._encryption.encrypt(entry_bytes, self._context)
        
        # Write to file
        self._path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(self._path, 'ab') as f:
            # Write length prefix + encrypted block
            serialized = block.serialize()
            f.write(len(serialized).to_bytes(4, 'big'))
            f.write(serialized)
            f.flush()
            os.fsync(f.fileno())
    
    def read_entries(self) -> list[dict]:
        """Read and decrypt all entries from the ledger.
        
        Returns:
            List of decrypted entries
        """
        entries = []
        
        if not self._path.exists():
            return entries
        
        with open(self._path, 'rb') as f:
            while True:
                # Read length prefix
                length_data = f.read(4)
                if not length_data:
                    break
                
                length = int.from_bytes(length_data, 'big')
                
                # Read encrypted block
                block_data = f.read(length)
                if not block_data:
                    break
                
                try:
                    block = EncryptedBlock.deserialize(block_data)
                    plaintext = self._encryption.decrypt(block, self._context)
                    entry = json.loads(plaintext.decode('utf-8'))
                    entries.append(entry)
                except (EncryptionError, json.JSONDecodeError) as e:
                    logger.error(f"Failed to decrypt entry: {e}")
                    continue
        
        return entries


def create_encryption(
    master_key: Optional[bytes] = None,
    password: Optional[str] = None,
    salt: Optional[bytes] = None,
) -> LedgerEncryption:
    """Factory function to create ledger encryption.
    
    Args:
        master_key: Master encryption key
        password: Password to derive key from (alternative to master_key)
        salt: Salt for key derivation
    
    Returns:
        Configured LedgerEncryption instance
    """
    if password and not master_key:
        master_key, salt = LedgerEncryption.derive_key_from_password(password, salt)
    
    return LedgerEncryption(
        master_key=master_key,
        key_derivation_salt=salt,
    )
