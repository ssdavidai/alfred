# Alfred Code & Security Review

**Review Date:** 2026-02-24  
**Reviewer:** Kilo Code (Automated Review)  
**Version Reviewed:** 0.3.1

---

## Executive Summary

Alfred is a personal agentic infrastructure suite for managing an Obsidian vault through automated daemons (Curator, Janitor, Distiller, Surveyor). The codebase demonstrates solid security practices overall with a few areas requiring attention.

### Overall Risk Assessment: **MEDIUM**

The application handles sensitive data (API keys, vault contents) and executes external commands. While the code shows security-conscious design, several areas need hardening.

---

## Critical Findings

### 1. ðŸ”´ CRITICAL: Shell Command Injection via `bash -c` (quickstart.py:109-111)

**Location:** [`src/alfred/quickstart.py:109-111`](src/alfred/quickstart.py:109)

```python
result = subprocess.run(
    ["bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
    capture_output=True, text=True,
)
```

**Risk:** This pattern downloads and executes a remote script without verification. While the URL is hardcoded, this is a dangerous pattern that could be exploited if the code is modified or if there's a supply chain attack on ollama.com.

**Recommendation:**
- Add checksum verification for downloaded scripts
- Consider pinning to a specific version with verified checksum
- Add a user confirmation prompt before executing remote scripts

### 2. ðŸ”´ CRITICAL: API Keys Written to .env File in Plaintext (quickstart.py:343-347)

**Location:** [`src/alfred/quickstart.py:343-347`](src/alfred/quickstart.py:343)

```python
env_lines = ["# Alfred environment variables"]
if zo_api_key:
    env_lines.append(f"ZO_API_KEY={zo_api_key}")
if openrouter_api_key:
    env_lines.append(f"OPENROUTER_API_KEY={openrouter_api_key}")
```

**Risk:** API keys are written to `.env` file in plaintext without encryption or secure storage.

**Recommendation:**
- Use system keyring for API key storage (e.g., `keyring` library)
- Encrypt sensitive values at rest
- Add `.env` to `.gitignore` automatically (already done, but verify)
- Warn users about plaintext storage

---

## High Severity Findings

### 3. ðŸŸ  HIGH: Arbitrary Command Execution via `alfred exec` (cli.py:309-310)

**Location:** [`src/alfred/cli.py:309-310`](src/alfred/cli.py:309)

```python
result = subprocess.run(command, env=env)
```

**Risk:** The `alfred exec` command allows running arbitrary commands with vault environment variables set. While this is by design, there's no validation of the command being executed.

**Recommendation:**
- Add command logging/auditing
- Consider implementing a command allowlist for restricted modes
- Document the security implications in help text

### 4. ðŸŸ  HIGH: Path Traversal Protection Could Be Bypassed on Windows (vault/ops.py:32-37)

**Location:** [`src/alfred/vault/ops.py:32-37`](src/alfred/vault/ops.py:32)

```python
def _resolve_vault_path(vault_path: Path, rel_path: str) -> Path:
    full = (vault_path / rel_path).resolve()
    if not str(full).startswith(str(vault_path.resolve())):
        raise VaultError(f"Path traversal denied: {rel_path}")
    return full
```

**Risk:** On Windows, path comparison might be case-insensitive and could potentially be bypassed using alternate data streams or UNC paths.

**Recommendation:**
- Use case-normalized path comparison on Windows
- Block UNC paths and alternate data streams
- Consider using `os.path.normcase()` for platform-specific normalization

### 5. ðŸŸ  HIGH: No Rate Limiting on LLM API Calls (surveyor/labeler.py, embedder.py)

**Location:** Multiple files

**Risk:** API calls to OpenRouter and Ollama have minimal rate limiting (only `API_CALL_DELAY = 1.0` second between calls). This could lead to:
- Unexpected API cost spikes
- Rate limit bans from providers
- Resource exhaustion

**Recommendation:**
- Implement configurable rate limiting with token buckets
- Add cost tracking and budget limits
- Implement circuit breakers for failing APIs

---

## Medium Severity Findings

### 6. ðŸŸ¡ MEDIUM: Insecure Default Configuration (config.yaml.example)

**Location:** [`config.yaml.example`](config.yaml.example)

**Issues:**
- `timeout: 600` (10 minutes) is very long for LLM calls
- No maximum file size limits for processing
- `allowed_tools: ["Bash"]` gives broad filesystem access

**Recommendation:**
- Reduce default timeout to 300 seconds
- Add `max_file_size_mb` configuration option
- Document security implications of `allowed_tools`

### 7. ðŸŸ¡ MEDIUM: Temporary File Security (curator/pipeline.py:152-162)

**Location:** [`src/alfred/curator/pipeline.py:152-162`](src/alfred/curator/pipeline.py:152)

```python
prompt_file = tempfile.NamedTemporaryFile(
    mode="w",
    prefix=f"alfred-curator-{stage_label}-",
    suffix=".md",
    delete=False,
    encoding="utf-8",
)
```

**Risk:** Temporary files are created with default permissions (potentially world-readable on some systems) and contain sensitive prompt data including vault context.

**Recommendation:**
- Set explicit file permissions (0600) for temporary files
- Use `tempfile.mkstemp()` with secure permissions
- Consider using in-memory pipes instead of files

### 8. ðŸŸ¡ MEDIUM: Missing Input Validation for Entity Names (vault/ops.py)

**Location:** [`src/alfred/vault/ops.py:339-410`](src/alfred/vault/ops.py:339)

**Risk:** Entity names from LLM output are used directly in file paths without sufficient sanitization. While `_normalize_name()` does some processing, special characters could potentially cause issues.

**Recommendation:**
- Add explicit validation for file path characters
- Reject or escape characters that are problematic on Windows/Unix
- Add maximum length validation for names

### 9. ðŸŸ¡ MEDIUM: Scope Enforcement Relies on Environment Variable (vault/scope.py)

**Location:** [`src/alfred/vault/scope.py`](src/alfred/vault/scope.py)

**Risk:** Scope restrictions are enforced via `ALFRED_VAULT_SCOPE` environment variable. A compromised or buggy agent could unset or modify this variable.

**Recommendation:**
- Consider additional enforcement mechanisms
- Log scope violations with high priority
- Add process-level scope isolation where possible

---

## Low Severity Findings

### 10. ðŸŸ¢ LOW: Information Disclosure in Error Messages

**Location:** Multiple files

**Issue:** Error messages sometimes include full paths and partial content that could expose system information.

**Examples:**
- `cli.py:47-48`: Prints full config path when not found
- `daemon.py:100`: Logs file read errors with paths

**Recommendation:** Sanitize paths in user-facing error messages while preserving detail in logs.

### 11. ðŸŸ¢ LOW: Missing Security Headers for HTTP Backend

**Location:** [`src/alfred/curator/backends/http.py`](src/alfred/curator/backends/http.py)

**Issue:** The HTTP backend doesn't set explicit security headers or validate TLS certificates explicitly.

**Recommendation:**
- Add explicit certificate verification
- Consider adding request signing for API calls

### 12. ðŸŸ¢ LOW: No Integrity Verification for State Files

**Location:** State files in `data/` directory

**Issue:** State files (JSON) are read/written without integrity verification. A corrupted or tampered state file could cause unexpected behavior.

**Recommendation:**
- Add checksums to state files
- Consider file locking for concurrent access

---

## Code Quality Issues

### 13. Code Style & Best Practices

**Positive Observations:**
- âœ… Uses `yaml.safe_load()` instead of `yaml.load()` (no arbitrary code execution)
- âœ… Uses `asyncio.create_subprocess_exec()` instead of shell=True
- âœ… Implements proper path traversal protection
- âœ… Uses structlog for structured logging
- âœ… Type hints throughout the codebase
- âœ… Dataclasses for configuration objects

**Areas for Improvement:**
- âš ï¸ Some functions exceed 50 lines (e.g., `run_quickstart()`)
- âš ï¸ Mixed use of `Path` and string paths
- âš ï¸ Inconsistent error handling patterns (some raise, some return None)
- âš ï¸ Missing docstrings in some helper functions

### 14. Dependency Security

**Location:** [`pyproject.toml`](pyproject.toml)

**Dependencies:**
- `pyyaml>=6.0` - âœ… Safe (uses safe_load)
- `httpx>=0.27` - âœ… Modern, maintained
- `python-frontmatter>=1.1` - âœ… Standard library
- `structlog>=24.0` - âœ… Well-maintained
- `watchdog>=4.0` - âœ… Standard library
- `rich>=13.0` - âœ… Well-maintained
- `textual>=0.89` - âœ… Well-maintained

**Optional Dependencies:**
- `temporalio>=1.9.0` - âœ… Official Temporal SDK
- `pymilvus[milvus_lite]>=2.4` - âœ… Official Milvus client
- `openai>=1.30` - âœ… Official OpenAI SDK

**Recommendation:** Pin exact versions in production deployments and use dependency scanning tools.

---

## Security Architecture Review

### Positive Security Patterns

1. **Scope-Based Access Control:** The [`scope.py`](src/alfred/vault/scope.py) implements role-based restrictions for different agents (curator, janitor, distiller).

2. **Mutation Logging:** All vault changes are logged via [`mutation_log.py`](src/alfred/vault/mutation_log.py) providing an audit trail.

3. **No Direct Filesystem Access:** Agents use `alfred vault` CLI commands rather than direct filesystem access, providing a security boundary.

4. **Environment Variable Substitution:** Sensitive values use `${VAR}` syntax rather than hardcoding.

5. **Process Isolation:** Daemons run as separate processes with configurable permissions.

### Areas for Security Improvement

1. **Secrets Management:** Implement proper secrets storage instead of plaintext `.env` files.

2. **Input Sanitization:** Add more rigorous validation for all external inputs (LLM outputs, file contents).

3. **Audit Logging:** Expand audit logging to include all security-relevant events.

4. **Network Security:** Add TLS verification and certificate pinning for API calls.

5. **Sandboxing:** Consider containerization or sandboxing for agent execution.

---

## Recommendations Summary

### Immediate Actions (Critical)

1. Remove or add verification for the remote script execution in quickstart.py
2. Implement secure storage for API keys (keyring or encrypted storage)
3. Add user confirmation before executing remote scripts

### Short-Term Actions (High Priority)

1. Add command validation/auditing for `alfred exec`
2. Enhance path traversal protection for Windows compatibility
3. Implement configurable rate limiting for API calls
4. Add maximum file size limits

### Long-Term Actions (Medium Priority)

1. Implement proper secrets management system
2. Add integrity verification for state files
3. Expand audit logging capabilities
4. Consider containerization for agent isolation
5. Add security documentation for users

---

## Conclusion

Alfred demonstrates security-conscious design with proper input validation, scope-based access control, and audit logging. However, the critical issues around remote script execution and plaintext API key storage should be addressed before production use in security-sensitive environments.

The codebase is well-structured with good use of modern Python practices. The main security concerns relate to the inherent risks of giving LLM agents filesystem access, which is the core functionality of the application.

**Recommended Security Maturity Level:** Suitable for personal use with awareness of risks. Additional hardening required for enterprise or multi-user deployments.
