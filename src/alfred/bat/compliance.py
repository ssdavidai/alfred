"""
Compliance Reporting for Enterprise Governance.

Implements Phase 4 Enterprise:
- SOC 2 Type II control mappings
- ISO 27001 control mappings
- Evidence collection and reporting
- Audit trail generation

Core Principle: Compliance is a byproduct of good governance.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from pathlib import Path
from typing import Optional
import json
import logging
import threading

logger = logging.getLogger(__name__)


class ComplianceFramework(str, Enum):
    """Supported compliance frameworks."""
    SOC2 = "soc2"
    ISO27001 = "iso27001"
    GDPR = "gdpr"
    HIPAA = "hipaa"
    PCI_DSS = "pci_dss"


class ControlStatus(str, Enum):
    """Status of a compliance control."""
    COMPLIANT = "compliant"
    NON_COMPLIANT = "non_compliant"
    PARTIALLY_COMPLIANT = "partially_compliant"
    NOT_APPLICABLE = "not_applicable"
    NOT_ASSESSED = "not_assessed"


class EvidenceType(str, Enum):
    """Types of compliance evidence."""
    LOG_ENTRY = "log_entry"
    CONFIGURATION = "configuration"
    SCREENSHOT = "screenshot"
    POLICY_DOCUMENT = "policy_document"
    TEST_RESULT = "test_result"
    AUDIT_TRAIL = "audit_trail"
    SYSTEM_OUTPUT = "system_output"


@dataclass
class ComplianceControl:
    """A compliance control definition.
    
    Attributes:
        control_id: Control identifier (e.g., "CC6.1" for SOC 2)
        name: Control name
        description: Control description
        framework: Compliance framework
        category: Control category
        subcategory: Control subcategory
        mappings: Mappings to other frameworks
    """
    control_id: str
    name: str
    description: str
    framework: ComplianceFramework
    category: str = ""
    subcategory: str = ""
    mappings: dict[str, str] = field(default_factory=dict)
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "control_id": self.control_id,
            "name": self.name,
            "description": self.description,
            "framework": self.framework.value,
            "category": self.category,
            "subcategory": self.subcategory,
            "mappings": self.mappings,
        }


@dataclass
class Evidence:
    """Compliance evidence.
    
    Attributes:
        evidence_id: Unique identifier
        control_id: Related control ID
        evidence_type: Type of evidence
        description: Description of the evidence
        collected_at: When the evidence was collected
        collected_by: Who/what collected the evidence
        source: Source system or file
        data: Evidence data (JSON-serializable)
        hash: Hash of evidence data for integrity
    """
    evidence_id: str
    control_id: str
    evidence_type: EvidenceType
    description: str
    collected_at: datetime
    collected_by: str
    source: str
    data: dict
    hash: str = ""
    
    def __post_init__(self):
        """Compute hash if not provided."""
        if not self.hash:
            import hashlib
            data_str = json.dumps(self.data, sort_keys=True)
            self.hash = hashlib.sha256(data_str.encode()).hexdigest()
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "evidence_id": self.evidence_id,
            "control_id": self.control_id,
            "evidence_type": self.evidence_type.value,
            "description": self.description,
            "collected_at": self.collected_at.isoformat(),
            "collected_by": self.collected_by,
            "source": self.source,
            "data": self.data,
            "hash": self.hash,
        }


@dataclass
class ControlAssessment:
    """Assessment of a compliance control.
    
    Attributes:
        control_id: Control being assessed
        status: Assessment status
        evidence_ids: IDs of supporting evidence
        assessed_at: When the assessment was performed
        assessed_by: Who performed the assessment
        notes: Assessment notes
        gaps: Identified gaps
        remediation: Remediation steps if non-compliant
    """
    control_id: str
    status: ControlStatus
    evidence_ids: list[str] = field(default_factory=list)
    assessed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    assessed_by: str = "system"
    notes: str = ""
    gaps: list[str] = field(default_factory=list)
    remediation: list[str] = field(default_factory=list)
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "control_id": self.control_id,
            "status": self.status.value,
            "evidence_ids": self.evidence_ids,
            "assessed_at": self.assessed_at.isoformat(),
            "assessed_by": self.assessed_by,
            "notes": self.notes,
            "gaps": self.gaps,
            "remediation": self.remediation,
        }


# SOC 2 Type II Control Definitions
SOC2_CONTROLS: list[ComplianceControl] = [
    # CC6 - Logical and Physical Access
    ComplianceControl(
        control_id="CC6.1",
        name="Logical Access",
        description="Logical access to systems is restricted to authorized users.",
        framework=ComplianceFramework.SOC2,
        category="Access Control",
        subcategory="Logical Access",
        mappings={"ISO27001": "A.9.1.1", "NIST": "AC-1"},
    ),
    ComplianceControl(
        control_id="CC6.2",
        name="Access Authorization",
        description="Access is authorized based on business need and granted upon approval.",
        framework=ComplianceFramework.SOC2,
        category="Access Control",
        subcategory="Authorization",
        mappings={"ISO27001": "A.9.1.2", "NIST": "AC-2"},
    ),
    ComplianceControl(
        control_id="CC6.3",
        name="Access Removal",
        description="Access is removed upon termination or transfer.",
        framework=ComplianceFramework.SOC2,
        category="Access Control",
        subcategory="Access Removal",
        mappings={"ISO27001": "A.9.2.6", "NIST": "AC-2(3)"},
    ),
    ComplianceControl(
        control_id="CC6.6",
        name="Boundary Protection",
        description="System boundaries are protected against unauthorized access.",
        framework=ComplianceFramework.SOC2,
        category="Access Control",
        subcategory="Boundary Protection",
        mappings={"ISO27001": "A.13.1.1", "NIST": "SC-7"},
    ),
    # CC7 - System Operations
    ComplianceControl(
        control_id="CC7.1",
        name="Vulnerability Management",
        description="Vulnerabilities are identified and remediated.",
        framework=ComplianceFramework.SOC2,
        category="System Operations",
        subcategory="Vulnerability Management",
        mappings={"ISO27001": "A.12.6.1", "NIST": "RA-5"},
    ),
    ComplianceControl(
        control_id="CC7.2",
        name="Anomaly Detection",
        description="Security events are monitored and anomalies detected.",
        framework=ComplianceFramework.SOC2,
        category="System Operations",
        subcategory="Monitoring",
        mappings={"ISO27001": "A.12.4.1", "NIST": "AU-6"},
    ),
    # CC8 - Change Management
    ComplianceControl(
        control_id="CC8.1",
        name="Change Management",
        description="Changes are authorized, tested, and approved before implementation.",
        framework=ComplianceFramework.SOC2,
        category="Change Management",
        subcategory="Change Control",
        mappings={"ISO27001": "A.12.1.2", "NIST": "CM-3"},
    ),
    # A1 - Availability
    ComplianceControl(
        control_id="A1.1",
        name="Capacity Management",
        description="System capacity is monitored and managed.",
        framework=ComplianceFramework.SOC2,
        category="Availability",
        subcategory="Capacity",
        mappings={"ISO27001": "A.12.1.3", "NIST": "CP-2"},
    ),
    ComplianceControl(
        control_id="A1.2",
        name="Backup and Recovery",
        description="Data is backed up and recoverable.",
        framework=ComplianceFramework.SOC2,
        category="Availability",
        subcategory="Backup",
        mappings={"ISO27001": "A.12.3.1", "NIST": "CP-9"},
    ),
    # C1 - Confidentiality
    ComplianceControl(
        control_id="C1.1",
        name="Data Classification",
        description="Data is classified based on sensitivity.",
        framework=ComplianceFramework.SOC2,
        category="Confidentiality",
        subcategory="Classification",
        mappings={"ISO27001": "A.8.2.1", "NIST": "MP-3"},
    ),
    ComplianceControl(
        control_id="C1.2",
        name="Data Protection",
        description="Confidential data is protected during transmission and storage.",
        framework=ComplianceFramework.SOC2,
        category="Confidentiality",
        subcategory="Data Protection",
        mappings={"ISO27001": "A.10.1.1", "NIST": "SC-8"},
    ),
]

# ISO 27001 Control Definitions
ISO27001_CONTROLS: list[ComplianceControl] = [
    # A.9 - Access Control
    ComplianceControl(
        control_id="A.9.1.1",
        name="Access Control Policy",
        description="Access control policy is established and reviewed.",
        framework=ComplianceFramework.ISO27001,
        category="Access Control",
        subcategory="Policy",
        mappings={"SOC2": "CC6.1", "NIST": "AC-1"},
    ),
    ComplianceControl(
        control_id="A.9.1.2",
        name="Access Provisioning",
        description="Access to systems is formally authorized and managed.",
        framework=ComplianceFramework.ISO27001,
        category="Access Control",
        subcategory="Provisioning",
        mappings={"SOC2": "CC6.2", "NIST": "AC-2"},
    ),
    ComplianceControl(
        control_id="A.9.2.1",
        name="User Registration",
        description="User registration and de-registration is controlled.",
        framework=ComplianceFramework.ISO27001,
        category="Access Control",
        subcategory="User Management",
        mappings={"SOC2": "CC6.2", "NIST": "AC-2"},
    ),
    ComplianceControl(
        control_id="A.9.2.2",
        name="Access Approval",
        description="User access provisioning is approved by appropriate authority.",
        framework=ComplianceFramework.ISO27001,
        category="Access Control",
        subcategory="Approval",
        mappings={"SOC2": "CC6.2", "NIST": "AC-2"},
    ),
    ComplianceControl(
        control_id="A.9.2.3",
        name="Privileged Access",
        description="Privileged access rights are restricted and controlled.",
        framework=ComplianceFramework.ISO27001,
        category="Access Control",
        subcategory="Privileged Access",
        mappings={"SOC2": "CC6.1", "NIST": "AC-6"},
    ),
    ComplianceControl(
        control_id="A.9.2.6",
        name="Access Removal",
        description="Access is removed or adjusted upon termination or change.",
        framework=ComplianceFramework.ISO27001,
        category="Access Control",
        subcategory="Removal",
        mappings={"SOC2": "CC6.3", "NIST": "AC-2(3)"},
    ),
    # A.12 - Operations Security
    ComplianceControl(
        control_id="A.12.1.2",
        name="Change Management",
        description="Changes to systems are controlled.",
        framework=ComplianceFramework.ISO27001,
        category="Operations Security",
        subcategory="Change Management",
        mappings={"SOC2": "CC8.1", "NIST": "CM-3"},
    ),
    ComplianceControl(
        control_id="A.12.4.1",
        name="Event Logging",
        description="Events are logged and maintained.",
        framework=ComplianceFramework.ISO27001,
        category="Operations Security",
        subcategory="Logging",
        mappings={"SOC2": "CC7.2", "NIST": "AU-2"},
    ),
    ComplianceControl(
        control_id="A.12.6.1",
        name="Vulnerability Management",
        description="Vulnerabilities are identified and addressed.",
        framework=ComplianceFramework.ISO27001,
        category="Operations Security",
        subcategory="Vulnerability Management",
        mappings={"SOC2": "CC7.1", "NIST": "RA-5"},
    ),
    # A.16 - Information Security Incident Management
    ComplianceControl(
        control_id="A.16.1.1",
        name="Incident Response",
        description="Security incidents are reported and managed.",
        framework=ComplianceFramework.ISO27001,
        category="Incident Management",
        subcategory="Response",
        mappings={"SOC2": "CC7.2", "NIST": "IR-1"},
    ),
]


class ComplianceReporter:
    """Generate compliance reports for SOC 2 and ISO 27001.
    
    Features:
    - Control mapping between frameworks
    - Evidence collection and storage
    - Automated control assessment
    - Report generation
    
    Core Principle: Compliance reporting is automated and evidence-based.
    """
    
    def __init__(
        self,
        evidence_store_path: Path,
        frameworks: Optional[list[ComplianceFramework]] = None,
    ):
        """Initialize the compliance reporter.
        
        Args:
            evidence_store_path: Path to store evidence
            frameworks: Frameworks to report on (default: SOC2, ISO27001)
        """
        self._store_path = Path(evidence_store_path)
        self._frameworks = frameworks or [ComplianceFramework.SOC2, ComplianceFramework.ISO27001]
        self._lock = threading.RLock()
        
        # Control registry
        self._controls: dict[str, ComplianceControl] = {}
        self._load_controls()
        
        # Evidence storage
        self._evidence: dict[str, Evidence] = {}
        self._assessments: dict[str, ControlAssessment] = {}
        
        self._store_path.mkdir(parents=True, exist_ok=True)
        self._load_stored_data()
    
    def _load_controls(self) -> None:
        """Load control definitions."""
        for control in SOC2_CONTROLS:
            # Store with both prefixed and non-prefixed keys (both cases for robustness)
            self._controls[f"SOC2:{control.control_id}"] = control
            self._controls[f"soc2:{control.control_id}"] = control
            self._controls[control.control_id] = control
        
        for control in ISO27001_CONTROLS:
            self._controls[f"ISO27001:{control.control_id}"] = control
            self._controls[f"iso27001:{control.control_id}"] = control
            self._controls[control.control_id] = control
    
    def _load_stored_data(self) -> None:
        """Load stored evidence and assessments."""
        evidence_path = self._store_path / "evidence.json"
        if evidence_path.exists():
            try:
                data = json.loads(evidence_path.read_text())
                for e in data:
                    evidence = Evidence(
                        evidence_id=e["evidence_id"],
                        control_id=e["control_id"],
                        evidence_type=EvidenceType(e["evidence_type"]),
                        description=e["description"],
                        collected_at=datetime.fromisoformat(e["collected_at"]),
                        collected_by=e["collected_by"],
                        source=e["source"],
                        data=e["data"],
                        hash=e.get("hash", ""),
                    )
                    self._evidence[evidence.evidence_id] = evidence
            except Exception as e:
                logger.warning(f"Failed to load evidence: {e}")
        
        assessments_path = self._store_path / "assessments.json"
        if assessments_path.exists():
            try:
                data = json.loads(assessments_path.read_text())
                for a in data:
                    assessment = ControlAssessment(
                        control_id=a["control_id"],
                        status=ControlStatus(a["status"]),
                        evidence_ids=a.get("evidence_ids", []),
                        assessed_at=datetime.fromisoformat(a["assessed_at"]),
                        assessed_by=a.get("assessed_by", "system"),
                        notes=a.get("notes", ""),
                        gaps=a.get("gaps", []),
                        remediation=a.get("remediation", []),
                    )
                    self._assessments[assessment.control_id] = assessment
            except Exception as e:
                logger.warning(f"Failed to load assessments: {e}")
    
    def _save_stored_data(self) -> None:
        """Save evidence and assessments to disk."""
        evidence_path = self._store_path / "evidence.json"
        evidence_path.write_text(json.dumps(
            [e.to_dict() for e in self._evidence.values()],
            indent=2
        ))
        
        assessments_path = self._store_path / "assessments.json"
        assessments_path.write_text(json.dumps(
            [a.to_dict() for a in self._assessments.values()],
            indent=2
        ))
    
    def collect_evidence(
        self,
        control_id: str,
        evidence_type: EvidenceType,
        description: str,
        source: str,
        data: dict,
        collected_by: str = "system",
    ) -> Evidence:
        """Collect compliance evidence.
        
        Args:
            control_id: Related control ID
            evidence_type: Type of evidence
            description: Description of the evidence
            source: Source system or file
            data: Evidence data
            collected_by: Who collected the evidence
        
        Returns:
            Collected Evidence
        """
        with self._lock:
            import uuid
            evidence = Evidence(
                evidence_id=str(uuid.uuid4()),
                control_id=control_id,
                evidence_type=evidence_type,
                description=description,
                collected_at=datetime.now(timezone.utc),
                collected_by=collected_by,
                source=source,
                data=data,
            )
            
            self._evidence[evidence.evidence_id] = evidence
            self._save_stored_data()
            
            logger.info(
                f"Collected evidence {evidence.evidence_id[:8]}... "
                f"for control {control_id}"
            )
            
            return evidence
    
    def assess_control(
        self,
        control_id: str,
        status: ControlStatus,
        evidence_ids: Optional[list[str]] = None,
        notes: str = "",
        gaps: Optional[list[str]] = None,
        remediation: Optional[list[str]] = None,
        assessed_by: str = "system",
    ) -> ControlAssessment:
        """Assess a compliance control.
        
        Args:
            control_id: Control to assess
            status: Assessment status
            evidence_ids: Supporting evidence IDs
            notes: Assessment notes
            gaps: Identified gaps
            remediation: Remediation steps
            assessed_by: Who performed the assessment
        
        Returns:
            ControlAssessment
        """
        with self._lock:
            assessment = ControlAssessment(
                control_id=control_id,
                status=status,
                evidence_ids=evidence_ids or [],
                assessed_at=datetime.now(timezone.utc),
                assessed_by=assessed_by,
                notes=notes,
                gaps=gaps or [],
                remediation=remediation or [],
            )
            
            # Store with control_id as key (without framework prefix)
            self._assessments[control_id] = assessment
            self._save_stored_data()
            
            logger.info(
                f"Assessed control {control_id}: {status.value}"
            )
            
            return assessment
    
    def get_control(self, control_id: str, framework: ComplianceFramework) -> Optional[ComplianceControl]:
        """Get a control definition."""
        # Try uppercase prefix first (primary storage format)
        key = f"{framework.name}:{control_id}"
        if key in self._controls:
            return self._controls[key]
        # Fallback to lowercase prefix
        key = f"{framework.value}:{control_id}"
        return self._controls.get(key)
    
    def get_controls_by_framework(self, framework: ComplianceFramework) -> list[ComplianceControl]:
        """Get all controls for a framework."""
        # Use uppercase prefix for consistency with storage
        prefix = f"{framework.name}:"
        seen = set()
        controls = []
        for k, c in self._controls.items():
            if k.startswith(prefix) and c.control_id not in seen:
                seen.add(c.control_id)
                controls.append(c)
        return controls
    
    def get_mapped_controls(self, control_id: str, framework: ComplianceFramework) -> list[ComplianceControl]:
        """Get controls mapped to a given control.
        
        Args:
            control_id: Source control ID
            framework: Source framework
        
        Returns:
            List of mapped controls from other frameworks
        """
        control = self.get_control(control_id, framework)
        if not control or not control.mappings:
            return []
        
        mapped = []
        for target_framework, target_id in control.mappings.items():
            # Handle case-insensitive framework name lookup
            try:
                # Try uppercase first (e.g., "ISO27001" -> ISO27001)
                target_fw = ComplianceFramework[target_framework.upper()]
            except KeyError:
                try:
                    # Try lowercase value (e.g., "iso27001" -> ISO27001)
                    target_fw = ComplianceFramework(target_framework.lower())
                except ValueError:
                    continue
            target_control = self.get_control(target_id, target_fw)
            if target_control:
                mapped.append(target_control)
        
        return mapped
    
    def generate_report(
        self,
        framework: ComplianceFramework,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> dict:
        """Generate a compliance report.
        
        Args:
            framework: Framework to report on
            start_date: Report period start
            end_date: Report period end
        
        Returns:
            Compliance report dictionary
        """
        with self._lock:
            controls = self.get_controls_by_framework(framework)
            
            # Assess each control
            control_reports = []
            compliant_count = 0
            non_compliant_count = 0
            partial_count = 0
            not_assessed_count = 0
            
            for control in controls:
                # Look up assessment by control_id (without framework prefix)
                assessment = self._assessments.get(control.control_id)
                
                if assessment:
                    status = assessment.status
                    if status == ControlStatus.COMPLIANT:
                        compliant_count += 1
                    elif status == ControlStatus.NON_COMPLIANT:
                        non_compliant_count += 1
                    elif status == ControlStatus.PARTIALLY_COMPLIANT:
                        partial_count += 1
                else:
                    status = ControlStatus.NOT_ASSESSED
                    not_assessed_count += 1
                
                # Get evidence for this control
                control_evidence = [
                    e for e in self._evidence.values()
                    if e.control_id == control.control_id
                ]
                
                # Filter by date range
                if start_date:
                    control_evidence = [
                        e for e in control_evidence
                        if e.collected_at >= start_date
                    ]
                if end_date:
                    control_evidence = [
                        e for e in control_evidence
                        if e.collected_at <= end_date
                    ]
                
                control_reports.append({
                    "control": control.to_dict(),
                    "status": status.value,
                    "assessment": assessment.to_dict() if assessment else None,
                    "evidence_count": len(control_evidence),
                    "evidence_ids": [e.evidence_id for e in control_evidence],
                })
            
            total = len(controls)
            compliance_score = (compliant_count / total * 100) if total > 0 else 0
            
            return {
                "report_type": "compliance_assessment",
                "framework": framework.value,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "period": {
                    "start": start_date.isoformat() if start_date else None,
                    "end": end_date.isoformat() if end_date else None,
                },
                "summary": {
                    "total_controls": total,
                    "compliant": compliant_count,
                    "non_compliant": non_compliant_count,
                    "partially_compliant": partial_count,
                    "not_assessed": not_assessed_count,
                    "compliance_score": round(compliance_score, 2),
                },
                "controls": control_reports,
            }
    
    def generate_gap_analysis(
        self,
        framework: ComplianceFramework,
    ) -> dict:
        """Generate a gap analysis report.
        
        Args:
            framework: Framework to analyze
        
        Returns:
            Gap analysis report
        """
        with self._lock:
            controls = self.get_controls_by_framework(framework)
            
            gaps = []
            for control in controls:
                assessment = self._assessments.get(control.control_id)
                
                if not assessment:
                    gaps.append({
                        "control_id": control.control_id,
                        "name": control.name,
                        "gap_type": "not_assessed",
                        "description": "Control has not been assessed",
                        "remediation": ["Perform control assessment"],
                    })
                elif assessment.status == ControlStatus.NON_COMPLIANT:
                    gaps.append({
                        "control_id": control.control_id,
                        "name": control.name,
                        "gap_type": "non_compliant",
                        "description": assessment.notes,
                        "identified_gaps": assessment.gaps,
                        "remediation": assessment.remediation,
                    })
                elif assessment.status == ControlStatus.PARTIALLY_COMPLIANT:
                    gaps.append({
                        "control_id": control.control_id,
                        "name": control.name,
                        "gap_type": "partially_compliant",
                        "description": assessment.notes,
                        "identified_gaps": assessment.gaps,
                        "remediation": assessment.remediation,
                    })
            
            return {
                "report_type": "gap_analysis",
                "framework": framework.value,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "total_gaps": len(gaps),
                "gaps": gaps,
            }
    
    def get_stats(self) -> dict:
        """Get compliance reporter statistics."""
        by_framework: dict[str, int] = {}
        for fw in self._frameworks:
            controls = self.get_controls_by_framework(fw)
            by_framework[fw.value] = len(controls)
        
        by_status: dict[str, int] = {}
        for assessment in self._assessments.values():
            status = assessment.status.value
            by_status[status] = by_status.get(status, 0) + 1
        
        return {
            "frameworks": [f.value for f in self._frameworks],
            "controls_by_framework": by_framework,
            "total_evidence": len(self._evidence),
            "total_assessments": len(self._assessments),
            "assessments_by_status": by_status,
        }


def create_compliance_reporter(
    evidence_store_path: Path,
    frameworks: Optional[list[ComplianceFramework]] = None,
) -> ComplianceReporter:
    """Factory function to create a compliance reporter.
    
    Args:
        evidence_store_path: Path to store evidence
        frameworks: Frameworks to report on
    
    Returns:
        Configured ComplianceReporter instance
    """
    return ComplianceReporter(
        evidence_store_path=evidence_store_path,
        frameworks=frameworks,
    )
