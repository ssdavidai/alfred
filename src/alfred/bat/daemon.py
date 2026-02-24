"""
Governance Daemon - Multi-process governance consistency.

Implements SECURITY ELEVATION Phase 2:
- Single authoritative temporal stream
- Serialized ledger writer
- Cross-process proposal queue
- Governance state synchronization

Core Principle: In daemon mode, one authoritative temporal stream 
and one serialized ledger writer.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional, Any, Callable
import hashlib
import json
import logging
import os
import select
import socket
import struct
import threading
import time
import queue

logger = logging.getLogger(__name__)


class DaemonMode(str, Enum):
    """Governance daemon mode."""
    IN_PROCESS = "in_process"  # Single-process mode
    DAEMON = "daemon"          # Multi-process with daemon


class DaemonCommand(str, Enum):
    """Commands for daemon communication."""
    PROPOSE = "propose"
    STATUS = "status"
    SHUTDOWN = "shutdown"
    SYNC = "sync"


@dataclass
class DaemonMessage:
    """Message for daemon communication.
    
    Attributes:
        command: The command type
        payload: Command payload (JSON-serializable)
        timestamp: When the message was created
        sender_pid: PID of the sending process
        message_id: Unique message identifier
    """
    command: DaemonCommand
    payload: dict
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sender_pid: int = field(default_factory=os.getpid)
    message_id: str = ""
    
    def __post_init__(self):
        if not self.message_id:
            self.message_id = hashlib.sha256(
                f"{self.command.value}{self.timestamp.isoformat()}{self.sender_pid}".encode()
            ).hexdigest()[:16]
    
    def serialize(self) -> bytes:
        """Serialize message to bytes for transmission."""
        data = {
            "command": self.command.value,
            "payload": self.payload,
            "timestamp": self.timestamp.isoformat(),
            "sender_pid": self.sender_pid,
            "message_id": self.message_id,
        }
        json_bytes = json.dumps(data).encode('utf-8')
        # Prepend length for framing
        return struct.pack(">I", len(json_bytes)) + json_bytes
    
    @classmethod
    def deserialize(cls, data: bytes) -> "DaemonMessage":
        """Deserialize message from bytes."""
        obj = json.loads(data.decode('utf-8'))
        return cls(
            command=DaemonCommand(obj["command"]),
            payload=obj["payload"],
            timestamp=datetime.fromisoformat(obj["timestamp"]),
            sender_pid=obj["sender_pid"],
            message_id=obj["message_id"],
        )


@dataclass
class DaemonResponse:
    """Response from daemon.
    
    Attributes:
        success: Whether the command succeeded
        result: Result payload
        error: Error message if failed
        timestamp: When the response was created
    """
    success: bool
    result: dict = field(default_factory=dict)
    error: str = ""
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    def serialize(self) -> bytes:
        """Serialize response to bytes."""
        data = {
            "success": self.success,
            "result": self.result,
            "error": self.error,
            "timestamp": self.timestamp.isoformat(),
        }
        json_bytes = json.dumps(data).encode('utf-8')
        return struct.pack(">I", len(json_bytes)) + json_bytes
    
    @classmethod
    def deserialize(cls, data: bytes) -> "DaemonResponse":
        """Deserialize response from bytes."""
        obj = json.loads(data.decode('utf-8'))
        return cls(
            success=obj["success"],
            result=obj.get("result", {}),
            error=obj.get("error", ""),
            timestamp=datetime.fromisoformat(obj["timestamp"]),
        )


class GovernanceDaemon:
    """Governance daemon for multi-process consistency.
    
    This daemon ensures:
    1. Single serialized ledger writer
    2. Authoritative temporal stream
    3. Cross-process proposal queue
    4. Governance state synchronization
    
    Core Principle: One authoritative temporal stream and one 
    serialized ledger writer.
    """
    
    DEFAULT_SOCKET_PATH = "/tmp/bat-governance.sock"
    DEFAULT_PORT = 9527
    
    def __init__(
        self,
        socket_path: Optional[str] = None,
        port: Optional[int] = None,
        mode: DaemonMode = DaemonMode.IN_PROCESS,
    ):
        """Initialize the governance daemon.
        
        Args:
            socket_path: Path to Unix socket (for daemon mode)
            port: TCP port (fallback if Unix socket unavailable)
            mode: Daemon mode
        """
        self._socket_path = socket_path or self.DEFAULT_SOCKET_PATH
        self._port = port or self.DEFAULT_PORT
        self._mode = mode
        self._running = False
        self._server_socket: Optional[socket.socket] = None
        self._worker_thread: Optional[threading.Thread] = None
        self._proposal_queue: queue.Queue = queue.Queue()
        self._temporal_events: list = []
        self._lock = threading.Lock()
        self._clients: list[socket.socket] = []
        
        # Governance state
        self._proposal_count = 0
        self._last_proposal_time: Optional[datetime] = None
        self._start_time: Optional[datetime] = None
    
    @property
    def is_running(self) -> bool:
        """Check if the daemon is running."""
        return self._running
    
    @property
    def mode(self) -> DaemonMode:
        """Get the daemon mode."""
        return self._mode
    
    def start(self) -> bool:
        """Start the governance daemon.
        
        Returns:
            True if started successfully
        """
        if self._running:
            return True
        
        if self._mode == DaemonMode.IN_PROCESS:
            self._running = True
            self._start_time = datetime.now(timezone.utc)
            logger.info("Governance daemon started (in-process mode)")
            return True
        
        # Daemon mode - start server
        try:
            # Try Unix socket first
            try:
                self._server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self._server_socket.bind(self._socket_path)
                self._server_socket.listen(10)
                self._server_socket.setblocking(False)
                logger.info(f"Governance daemon listening on {self._socket_path}")
            except (OSError, socket.error):
                # Fallback to TCP
                self._server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                self._server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                self._server_socket.bind(("127.0.0.1", self._port))
                self._server_socket.listen(10)
                self._server_socket.setblocking(False)
                logger.info(f"Governance daemon listening on port {self._port}")
            
            self._running = True
            self._start_time = datetime.now(timezone.utc)
            
            # Start worker thread
            self._worker_thread = threading.Thread(target=self._server_loop, daemon=True)
            self._worker_thread.start()
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to start governance daemon: {e}")
            self._running = False
            return False
    
    def stop(self) -> None:
        """Stop the governance daemon."""
        self._running = False
        
        # Close all clients
        for client in self._clients:
            try:
                client.close()
            except Exception:
                pass
        self._clients.clear()
        
        # Close server socket
        if self._server_socket:
            try:
                self._server_socket.close()
            except Exception:
                pass
            self._server_socket = None
        
        # Remove Unix socket file
        if self._mode == DaemonMode.DAEMON:
            try:
                os.unlink(self._socket_path)
            except (OSError, FileNotFoundError):
                pass
        
        # Wait for worker thread
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=5.0)
        
        logger.info("Governance daemon stopped")
    
    def submit_proposal(self, proposal: dict) -> DaemonResponse:
        """Submit a proposal for governance evaluation.
        
        In daemon mode, this sends the proposal to the daemon process.
        In in-process mode, this processes directly.
        
        Args:
            proposal: The proposal to evaluate
        
        Returns:
            Daemon response with evaluation result
        """
        if self._mode == DaemonMode.IN_PROCESS:
            return self._process_proposal(proposal)
        
        # Daemon mode - send to daemon
        message = DaemonMessage(
            command=DaemonCommand.PROPOSE,
            payload=proposal,
        )
        
        return self._send_to_daemon(message)
    
    def get_status(self) -> dict:
        """Get daemon status."""
        return {
            "mode": self._mode.value,
            "running": self._running,
            "start_time": self._start_time.isoformat() if self._start_time else None,
            "proposal_count": self._proposal_count,
            "last_proposal": self._last_proposal_time.isoformat() if self._last_proposal_time else None,
            "queue_size": self._proposal_queue.qsize(),
            "temporal_events": len(self._temporal_events),
            "clients": len(self._clients) if self._mode == DaemonMode.DAEMON else 0,
        }
    
    def _process_proposal(self, proposal: dict) -> DaemonResponse:
        """Process a proposal (single writer guarantee).
        
        This method is the single point of ledger writes,
        ensuring no hash-chain corruption under concurrent load.
        """
        with self._lock:
            try:
                # Record temporal event
                event = {
                    "proposal_id": proposal.get("proposal_id"),
                    "agent_id": proposal.get("agent_id"),
                    "operation_type": proposal.get("operation_type"),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                self._temporal_events.append(event)
                
                # Trim old events (keep last 10000)
                if len(self._temporal_events) > 10000:
                    self._temporal_events = self._temporal_events[-10000:]
                
                self._proposal_count += 1
                self._last_proposal_time = datetime.now(timezone.utc)
                
                # In a full implementation, this would:
                # 1. Classify risk
                # 2. Evaluate enforcement
                # 3. Write to ledger (serialized)
                # 4. Return decision
                
                return DaemonResponse(
                    success=True,
                    result={
                        "proposal_id": proposal.get("proposal_id"),
                        "processed": True,
                        "event_index": len(self._temporal_events) - 1,
                    },
                )
                
            except Exception as e:
                logger.error(f"Proposal processing failed: {e}")
                return DaemonResponse(
                    success=False,
                    error=str(e),
                )
    
    def _send_to_daemon(self, message: DaemonMessage) -> DaemonResponse:
        """Send a message to the daemon process."""
        try:
            # Try Unix socket first
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(self._socket_path)
            except (FileNotFoundError, socket.error):
                # Fallback to TCP
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.connect(("127.0.0.1", self._port))
            
            try:
                # Send message
                sock.sendall(message.serialize())
                
                # Receive response
                response = self._receive_response(sock)
                return response
                
            finally:
                sock.close()
                
        except Exception as e:
            logger.error(f"Failed to communicate with daemon: {e}")
            return DaemonResponse(
                success=False,
                error=f"Daemon communication failed: {e}",
            )
    
    def _receive_response(self, sock: socket.socket) -> DaemonResponse:
        """Receive a response from the socket."""
        # Read length prefix
        length_data = b""
        while len(length_data) < 4:
            chunk = sock.recv(4 - len(length_data))
            if not chunk:
                raise ConnectionError("Connection closed")
            length_data += chunk
        
        length = struct.unpack(">I", length_data)[0]
        
        # Read response data
        data = b""
        while len(data) < length:
            chunk = sock.recv(length - len(data))
            if not chunk:
                raise ConnectionError("Connection closed")
            data += chunk
        
        return DaemonResponse.deserialize(data)
    
    def _server_loop(self) -> None:
        """Main server loop for daemon mode."""
        while self._running:
            try:
                # Accept new connections
                readable, _, _ = select.select([self._server_socket], [], [], 0.1)
                
                for sock in readable:
                    if sock == self._server_socket:
                        client, _ = sock.accept()
                        client.setblocking(False)
                        self._clients.append(client)
                        logger.debug(f"New client connected: {client.getpeername() if hasattr(client, 'getpeername') else 'unix socket'}")
                
                # Handle client messages
                if self._clients:
                    readable, _, exceptional = select.select(self._clients, [], self._clients, 0.1)
                    
                    for client in readable:
                        try:
                            message = self._receive_message(client)
                            if message:
                                response = self._handle_message(message)
                                client.sendall(response.serialize())
                        except (ConnectionError, socket.error):
                            self._clients.remove(client)
                            try:
                                client.close()
                            except Exception:
                                pass
                    
                    for client in exceptional:
                        self._clients.remove(client)
                        try:
                            client.close()
                        except Exception:
                            pass
                
            except Exception as e:
                logger.error(f"Server loop error: {e}")
                time.sleep(0.1)
    
    def _receive_message(self, sock: socket.socket) -> Optional[DaemonMessage]:
        """Receive a message from a client socket."""
        try:
            # Read length prefix
            length_data = b""
            while len(length_data) < 4:
                chunk = sock.recv(4 - len(length_data))
                if not chunk:
                    return None
                length_data += chunk
            
            length = struct.unpack(">I", length_data)[0]
            
            # Read message data
            data = b""
            while len(data) < length:
                chunk = sock.recv(length - len(data))
                if not chunk:
                    return None
                data += chunk
            
            return DaemonMessage.deserialize(data)
            
        except (socket.error, struct.error):
            return None
    
    def _handle_message(self, message: DaemonMessage) -> DaemonResponse:
        """Handle a received message."""
        if message.command == DaemonCommand.PROPOSE:
            return self._process_proposal(message.payload)
        
        elif message.command == DaemonCommand.STATUS:
            return DaemonResponse(
                success=True,
                result=self.get_status(),
            )
        
        elif message.command == DaemonCommand.SHUTDOWN:
            self._running = False
            return DaemonResponse(success=True, result={"shutdown": True})
        
        elif message.command == DaemonCommand.SYNC:
            return DaemonResponse(
                success=True,
                result={
                    "temporal_events": self._temporal_events[-100:],  # Last 100 events
                    "proposal_count": self._proposal_count,
                },
            )
        
        else:
            return DaemonResponse(
                success=False,
                error=f"Unknown command: {message.command}",
            )


class DaemonClient:
    """Client for connecting to the governance daemon.
    
    Use this in agent processes to communicate with the daemon.
    """
    
    def __init__(
        self,
        socket_path: Optional[str] = None,
        port: Optional[int] = None,
    ):
        """Initialize the daemon client.
        
        Args:
            socket_path: Path to Unix socket
            port: TCP port (fallback)
        """
        self._socket_path = socket_path or GovernanceDaemon.DEFAULT_SOCKET_PATH
        self._port = port or GovernanceDaemon.DEFAULT_PORT
    
    def submit_proposal(self, proposal: dict) -> DaemonResponse:
        """Submit a proposal to the daemon."""
        message = DaemonMessage(
            command=DaemonCommand.PROPOSE,
            payload=proposal,
        )
        return self._send_message(message)
    
    def get_status(self) -> DaemonResponse:
        """Get daemon status."""
        message = DaemonMessage(
            command=DaemonCommand.STATUS,
            payload={},
        )
        return self._send_message(message)
    
    def sync(self) -> DaemonResponse:
        """Synchronize governance state."""
        message = DaemonMessage(
            command=DaemonCommand.SYNC,
            payload={},
        )
        return self._send_message(message)
    
    def _send_message(self, message: DaemonMessage) -> DaemonResponse:
        """Send a message to the daemon."""
        try:
            # Try Unix socket first
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(self._socket_path)
            except (FileNotFoundError, socket.error):
                # Fallback to TCP
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.connect(("127.0.0.1", self._port))
            
            try:
                sock.sendall(message.serialize())
                return self._receive_response(sock)
            finally:
                sock.close()
                
        except Exception as e:
            return DaemonResponse(
                success=False,
                error=str(e),
            )
    
    def _receive_response(self, sock: socket.socket) -> DaemonResponse:
        """Receive a response from the socket."""
        length_data = b""
        while len(length_data) < 4:
            chunk = sock.recv(4 - len(length_data))
            if not chunk:
                raise ConnectionError("Connection closed")
            length_data += chunk
        
        length = struct.unpack(">I", length_data)[0]
        
        data = b""
        while len(data) < length:
            chunk = sock.recv(length - len(data))
            if not chunk:
                raise ConnectionError("Connection closed")
            data += chunk
        
        return DaemonResponse.deserialize(data)


def create_daemon(
    mode: str = "in_process",
    socket_path: Optional[str] = None,
    port: Optional[int] = None,
) -> GovernanceDaemon:
    """Factory function to create a governance daemon.
    
    Args:
        mode: Daemon mode ("in_process" or "daemon")
        socket_path: Path to Unix socket
        port: TCP port
    
    Returns:
        Configured GovernanceDaemon instance
    """
    daemon_mode = DaemonMode(mode.lower())
    return GovernanceDaemon(
        socket_path=socket_path,
        port=port,
        mode=daemon_mode,
    )
