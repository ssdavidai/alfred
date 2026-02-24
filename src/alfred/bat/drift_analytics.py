"""
Advanced Drift Governance Triggers and Anomaly Analytics.

Implements SECURITY ELEVATION Phase 3:
- Statistical drift detection algorithms
- Anomaly analytics with multiple detection methods
- Governance triggers for semantic drift
- Integration with wire protocol for event propagation

Core Principle: Drift detection is deterministic; statistical methods
are inputs to governance decisions, not the decisions themselves.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Optional, Callable, Any
from collections.abc import Sequence
import hashlib
import json
import logging
import math
import statistics
import threading
import uuid

logger = logging.getLogger(__name__)


class DriftType(str, Enum):
    """Types of semantic drift."""
    CONCEPT_DRIFT = "concept_drift"      # Underlying concept has changed
    DATA_DRIFT = "data_drift"            # Input distribution has changed
    MODEL_DRIFT = "model_drift"          # Model behavior has changed
    TEMPORAL_DRIFT = "temporal_drift"    # Time-based degradation
    SPATIAL_DRIFT = "spatial_drift"      # Cluster structure has changed


class AnomalyScore(str, Enum):
    """Anomaly severity classification."""
    NORMAL = "normal"          # Within expected bounds
    WARNING = "warning"        # Approaching threshold
    ANOMALOUS = "anomalous"    # Exceeds threshold
    CRITICAL = "critical"      # Requires immediate action


class TriggerAction(str, Enum):
    """Actions triggered by drift detection."""
    NONE = "none"              # No action required
    ALERT = "alert"            # Log alert
    QUARANTINE = "quarantine"  # Quarantine affected vectors
    REBUILD = "rebuild"        # Trigger index rebuild
    LOCKDOWN = "lockdown"      # Lock vector store
    NOTIFY = "notify"          # Send notification


@dataclass
class VectorStatistics:
    """Statistical summary of a vector collection.
    
    Attributes:
        count: Number of vectors
        dimensions: Vector dimensions
        centroid: Mean vector (centroid)
        variance: Variance per dimension
        std_dev: Standard deviation per dimension
        min_norm: Minimum vector norm
        max_norm: Maximum vector norm
        mean_norm: Mean vector norm
        sparsity: Average sparsity ratio
    """
    count: int = 0
    dimensions: int = 0
    centroid: list[float] = field(default_factory=list)
    variance: list[float] = field(default_factory=list)
    std_dev: list[float] = field(default_factory=list)
    min_norm: float = 0.0
    max_norm: float = 0.0
    mean_norm: float = 0.0
    sparsity: float = 0.0
    
    def to_dict(self) -> dict:
        return {
            "count": self.count,
            "dimensions": self.dimensions,
            "centroid": self.centroid,
            "variance": self.variance,
            "std_dev": self.std_dev,
            "min_norm": self.min_norm,
            "max_norm": self.max_norm,
            "mean_norm": self.mean_norm,
            "sparsity": self.sparsity,
        }


@dataclass
class DriftMetrics:
    """Metrics for drift detection.
    
    Attributes:
        metric_id: Unique identifier
        metric_type: Type of drift metric
        baseline_value: Baseline (expected) value
        current_value: Current measured value
        deviation: Absolute deviation from baseline
        relative_deviation: Relative deviation (percentage)
        threshold: Threshold for anomaly detection
        score: Anomaly score
        timestamp: When the metric was computed
    """
    metric_id: str
    metric_type: str
    baseline_value: float = 0.0
    current_value: float = 0.0
    deviation: float = 0.0
    relative_deviation: float = 0.0
    threshold: float = 0.0
    score: AnomalyScore = AnomalyScore.NORMAL
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    def __post_init__(self):
        """Compute derived values."""
        self.deviation = abs(self.current_value - self.baseline_value)
        
        # Compute relative deviation when baseline is non-zero
        # When baseline is 0, use absolute deviation compared to threshold
        if self.baseline_value != 0:
            self.relative_deviation = self.deviation / abs(self.baseline_value)
        else:
            # For zero baseline, relative_deviation is infinity if there's any deviation
            # We use absolute deviation compared to threshold for scoring
            self.relative_deviation = float('inf') if self.deviation > 0 else 0.0
        
        # Classify score based on threshold and deviation
        # Special handling for zero baseline: use absolute deviation vs threshold
        if self.deviation == 0:
            self.score = AnomalyScore.NORMAL
        elif self.baseline_value == 0:
            # Zero baseline: compare absolute deviation to threshold
            # If threshold is also 0, any deviation is critical
            if self.threshold == 0:
                self.score = AnomalyScore.CRITICAL
            elif self.deviation < self.threshold:
                self.score = AnomalyScore.WARNING
            elif self.deviation < self.threshold * 2:
                self.score = AnomalyScore.ANOMALOUS
            else:
                self.score = AnomalyScore.CRITICAL
        elif self.relative_deviation < 0.1:
            self.score = AnomalyScore.NORMAL
        elif self.relative_deviation < 0.25:
            self.score = AnomalyScore.WARNING
        elif self.relative_deviation < 0.5:
            self.score = AnomalyScore.ANOMALOUS
        else:
            self.score = AnomalyScore.CRITICAL
    
    def to_dict(self) -> dict:
        return {
            "metric_id": self.metric_id,
            "metric_type": self.metric_type,
            "baseline_value": self.baseline_value,
            "current_value": self.current_value,
            "deviation": self.deviation,
            "relative_deviation": self.relative_deviation,
            "threshold": self.threshold,
            "score": self.score.value,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class DriftTrigger:
    """A governance trigger from drift detection.
    
    Attributes:
        trigger_id: Unique identifier
        drift_type: Type of drift detected
        metrics: Metrics that triggered this
        severity: Overall severity
        action: Recommended action
        affected_count: Number of affected vectors
        details: Additional details
        timestamp: When the trigger was generated
        acknowledged: Whether the trigger has been acknowledged
        acknowledged_by: Who acknowledged it
        acknowledged_at: When it was acknowledged
    """
    trigger_id: str
    drift_type: DriftType
    metrics: list[DriftMetrics]
    severity: AnomalyScore
    action: TriggerAction
    affected_count: int = 0
    details: dict = field(default_factory=dict)
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    acknowledged: bool = False
    acknowledged_by: str = ""
    acknowledged_at: Optional[datetime] = None
    
    def to_dict(self) -> dict:
        return {
            "trigger_id": self.trigger_id,
            "drift_type": self.drift_type.value,
            "metrics": [m.to_dict() for m in self.metrics],
            "severity": self.severity.value,
            "action": self.action.value,
            "affected_count": self.affected_count,
            "details": self.details,
            "timestamp": self.timestamp.isoformat(),
            "acknowledged": self.acknowledged,
            "acknowledged_by": self.acknowledged_by,
            "acknowledged_at": self.acknowledged_at.isoformat() if self.acknowledged_at else None,
        }


class DriftDetector:
    """Statistical drift detection engine.
    
    Provides multiple detection methods:
    - Centroid shift detection
    - Distribution change detection
    - Outlier detection
    - Temporal pattern analysis
    
    Core Principle: Detection is deterministic; the same input
    always produces the same drift assessment.
    """
    
    def __init__(
        self,
        centroid_threshold: float = 0.1,
        distribution_threshold: float = 0.15,
        outlier_threshold: float = 3.0,  # Standard deviations
        temporal_window_hours: int = 24,
    ):
        """Initialize the drift detector.
        
        Args:
            centroid_threshold: Threshold for centroid shift (relative)
            distribution_threshold: Threshold for distribution change
            outlier_threshold: Standard deviations for outlier detection
            temporal_window_hours: Window for temporal analysis
        """
        self._centroid_threshold = centroid_threshold
        self._distribution_threshold = distribution_threshold
        self._outlier_threshold = outlier_threshold
        self._temporal_window = timedelta(hours=temporal_window_hours)
        
        # Baseline statistics
        self._baseline: Optional[VectorStatistics] = None
        self._baseline_norms: list[float] = []
        
        # History for temporal analysis
        self._history: list[tuple[datetime, VectorStatistics]] = []
        self._lock = threading.RLock()
    
    def set_baseline(
        self,
        vectors: Sequence[list[float]],
    ) -> VectorStatistics:
        """Set the baseline statistics from a vector collection.
        
        Args:
            vectors: Collection of embedding vectors
        
        Returns:
            Computed VectorStatistics
        """
        with self._lock:
            stats = self._compute_statistics(vectors)
            self._baseline = stats
            self._baseline_norms = [self._compute_norm(v) for v in vectors]
            
            logger.info(
                f"Set baseline: {stats.count} vectors, "
                f"{stats.dimensions} dimensions, "
                f"mean_norm={stats.mean_norm:.4f}"
            )
            
            return stats
    
    def detect(
        self,
        vectors: Sequence[list[float]],
    ) -> list[DriftMetrics]:
        """Detect drift in a vector collection.
        
        Args:
            vectors: Collection of embedding vectors to analyze
        
        Returns:
            List of DriftMetrics for each detection method
        """
        with self._lock:
            if not self._baseline:
                logger.warning("No baseline set; cannot detect drift")
                return []
            
            current = self._compute_statistics(vectors)
            current_norms = [self._compute_norm(v) for v in vectors]
            
            metrics = []
            
            # 1. Centroid shift detection
            centroid_metric = self._detect_centroid_shift(current)
            if centroid_metric:
                metrics.append(centroid_metric)
            
            # 2. Distribution change detection
            dist_metric = self._detect_distribution_change(current, current_norms)
            if dist_metric:
                metrics.append(dist_metric)
            
            # 3. Outlier detection
            outlier_metric = self._detect_outliers(current_norms)
            if outlier_metric:
                metrics.append(outlier_metric)
            
            # 4. Temporal analysis
            temporal_metric = self._detect_temporal_drift(current)
            if temporal_metric:
                metrics.append(temporal_metric)
            
            # Update history
            self._history.append((datetime.now(timezone.utc), current))
            
            # Trim history to window
            cutoff = datetime.now(timezone.utc) - self._temporal_window
            self._history = [(t, s) for t, s in self._history if t > cutoff]
            
            return metrics
    
    def _compute_statistics(
        self,
        vectors: Sequence[list[float]],
    ) -> VectorStatistics:
        """Compute statistical summary of vectors."""
        if not vectors:
            return VectorStatistics()
        
        count = len(vectors)
        dimensions = len(vectors[0])
        
        # Validate all vectors have consistent dimensions
        # Track dimension mismatches as anomalies
        dimension_mismatch = False
        for i, v in enumerate(vectors):
            if len(v) != dimensions:
                logger.warning(
                    f"Vector {i} has {len(v)} dimensions, expected {dimensions}. "
                    f"Using minimum dimension count for statistics."
                )
                dimension_mismatch = True
                dimensions = min(dimensions, len(v))
        
        if dimensions == 0:
            return VectorStatistics(count=count, dimensions=0)
        
        # Compute centroid (mean vector) - only use valid dimensions
        centroid = [0.0] * dimensions
        valid_count = 0
        for v in vectors:
            if len(v) >= dimensions:
                valid_count += 1
                for i in range(dimensions):
                    centroid[i] += v[i]
        
        if valid_count == 0:
            return VectorStatistics(count=count, dimensions=dimensions)
        
        centroid = [c / valid_count for c in centroid]
        
        # Compute variance and std_dev
        variance = [0.0] * dimensions
        for v in vectors:
            if len(v) >= dimensions:
                for i in range(dimensions):
                    variance[i] += (v[i] - centroid[i]) ** 2
        variance = [v / valid_count for v in variance]
        std_dev = [math.sqrt(v) for v in variance]
        
        # Compute norms
        norms = [self._compute_norm(v) for v in vectors]
        min_norm = min(norms) if norms else 0.0
        max_norm = max(norms) if norms else 0.0
        mean_norm = statistics.mean(norms) if norms else 0.0
        
        # Compute sparsity (ratio of near-zero elements)
        total_elements = sum(len(v) for v in vectors)
        if total_elements == 0:
            sparsity = 0.0
        else:
            sparsity = sum(
                1 for v in vectors
                for val in v
                if abs(val) < 1e-10
            ) / total_elements
        
        stats = VectorStatistics(
            count=count,
            dimensions=dimensions,
            centroid=centroid,
            variance=variance,
            std_dev=std_dev,
            min_norm=min_norm,
            max_norm=max_norm,
            mean_norm=mean_norm,
            sparsity=sparsity,
        )
        
        # Store dimension mismatch in metadata if detected
        if dimension_mismatch:
            # Return stats but note the anomaly
            logger.warning(
                f"Dimension mismatch detected in vector batch. "
                f"Statistics computed with {dimensions} dimensions from {valid_count}/{count} vectors."
            )
        
        return stats
    
    def _compute_norm(self, vector: list[float]) -> float:
        """Compute L2 norm of a vector."""
        return math.sqrt(sum(x * x for x in vector))
    
    def _detect_centroid_shift(
        self,
        current: VectorStatistics,
    ) -> Optional[DriftMetrics]:
        """Detect shift in centroid position."""
        if not self._baseline or not current.centroid:
            return None
        
        # Compute cosine distance between centroids
        dot = sum(a * b for a, b in zip(self._baseline.centroid, current.centroid))
        norm_baseline = math.sqrt(sum(x * x for x in self._baseline.centroid))
        norm_current = math.sqrt(sum(x * x for x in current.centroid))
        
        if norm_baseline == 0 or norm_current == 0:
            return None
        
        cosine_sim = dot / (norm_baseline * norm_current)
        cosine_dist = 1.0 - cosine_sim
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="centroid_shift",
            baseline_value=0.0,  # No shift expected
            current_value=cosine_dist,
            threshold=self._centroid_threshold,
        )
    
    def _detect_distribution_change(
        self,
        current: VectorStatistics,
        current_norms: list[float],
    ) -> Optional[DriftMetrics]:
        """Detect change in vector distribution."""
        if not self._baseline or not current_norms:
            return None
        
        # Compare mean norms
        baseline_mean = self._baseline.mean_norm
        current_mean = current.mean_norm
        
        if baseline_mean == 0:
            return None
        
        # Also compare variance using coefficient of variation
        baseline_cv = statistics.stdev(self._baseline_norms) / baseline_mean if len(self._baseline_norms) > 1 else 0
        current_cv = statistics.stdev(current_norms) / current_mean if len(current_norms) > 1 else 0
        
        # Combined metric
        mean_shift = abs(current_mean - baseline_mean) / baseline_mean
        cv_shift = abs(current_cv - baseline_cv)
        
        combined = (mean_shift + cv_shift) / 2
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="distribution_change",
            baseline_value=0.0,
            current_value=combined,
            threshold=self._distribution_threshold,
        )
    
    def _detect_outliers(
        self,
        norms: list[float],
    ) -> Optional[DriftMetrics]:
        """Detect anomalous outliers in vector norms."""
        if not norms or len(norms) < 3:
            return None
        
        mean = statistics.mean(norms)
        stdev = statistics.stdev(norms)
        
        if stdev == 0:
            return None
        
        # Count outliers (beyond threshold standard deviations)
        outlier_count = sum(
            1 for n in norms
            if abs(n - mean) > self._outlier_threshold * stdev
        )
        
        outlier_ratio = outlier_count / len(norms)
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="outlier_ratio",
            baseline_value=0.0,  # No outliers expected
            current_value=outlier_ratio,
            threshold=0.05,  # 5% outlier threshold
        )
    
    def _detect_temporal_drift(
        self,
        current: VectorStatistics,
    ) -> Optional[DriftMetrics]:
        """Detect temporal drift from history."""
        if len(self._history) < 2:
            return None
        
        # Compare current to oldest in window
        oldest_time, oldest = self._history[0]
        
        # Compute drift rate
        time_diff = (datetime.now(timezone.utc) - oldest_time).total_seconds()
        if time_diff == 0:
            return None
        
        # Use centroid distance as drift measure
        if not oldest.centroid or not current.centroid:
            return None
        
        dot = sum(a * b for a, b in zip(oldest.centroid, current.centroid))
        norm_oldest = math.sqrt(sum(x * x for x in oldest.centroid))
        norm_current = math.sqrt(sum(x * x for x in current.centroid))
        
        if norm_oldest == 0 or norm_current == 0:
            return None
        
        cosine_sim = dot / (norm_oldest * norm_current)
        drift_rate = (1.0 - cosine_sim) / time_diff  # Drift per second
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="temporal_drift_rate",
            baseline_value=0.0,  # No drift expected
            current_value=drift_rate,
            threshold=1e-6,  # Very small threshold for rate
        )


class AnomalyAnalyzer:
    """Comprehensive anomaly analysis engine.
    
    Provides multiple anomaly detection methods:
    - Statistical anomaly detection
    - Embedding plausibility checks
    - Pattern analysis
    - Correlation analysis
    
    Core Principle: Anomaly detection is deterministic and
    produces consistent results for the same inputs.
    """
    
    def __init__(
        self,
        plausibility_threshold: float = 0.7,
        correlation_threshold: float = 0.9,
        pattern_window: int = 100,
    ):
        """Initialize the anomaly analyzer.
        
        Args:
            plausibility_threshold: Minimum plausibility score
            correlation_threshold: Maximum allowed correlation
            pattern_window: Window size for pattern analysis
        """
        self._plausibility_threshold = plausibility_threshold
        self._correlation_threshold = correlation_threshold
        self._pattern_window = pattern_window
        self._lock = threading.RLock()
    
    def analyze_embedding(
        self,
        embedding: list[float],
        expected_dimensions: int,
        reference_embeddings: Optional[Sequence[list[float]]] = None,
    ) -> list[DriftMetrics]:
        """Analyze a single embedding for anomalies.
        
        Args:
            embedding: The embedding to analyze
            expected_dimensions: Expected number of dimensions
            reference_embeddings: Reference embeddings for comparison
        
        Returns:
            List of DriftMetrics for detected anomalies
        """
        with self._lock:
            metrics = []
            
            # 1. Dimension check
            dim_metric = self._check_dimensions(embedding, expected_dimensions)
            if dim_metric:
                metrics.append(dim_metric)
            
            # 2. Norm check
            norm_metric = self._check_norm(embedding)
            if norm_metric:
                metrics.append(norm_metric)
            
            # 3. Sparsity check
            sparsity_metric = self._check_sparsity(embedding)
            if sparsity_metric:
                metrics.append(sparsity_metric)
            
            # 4. Distribution check
            dist_metric = self._check_distribution(embedding)
            if dist_metric:
                metrics.append(dist_metric)
            
            # 5. Plausibility check (if references available)
            if reference_embeddings:
                plausibility_metric = self._check_plausibility(
                    embedding, reference_embeddings
                )
                if plausibility_metric:
                    metrics.append(plausibility_metric)
            
            return metrics
    
    def _check_dimensions(
        self,
        embedding: list[float],
        expected: int,
    ) -> Optional[DriftMetrics]:
        """Check embedding dimensions."""
        actual = len(embedding)
        if actual == expected:
            return None
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="dimension_mismatch",
            baseline_value=float(expected),
            current_value=float(actual),
            threshold=0.0,  # Any mismatch is anomalous
        )
    
    def _check_norm(
        self,
        embedding: list[float],
    ) -> Optional[DriftMetrics]:
        """Check embedding norm is reasonable."""
        norm = math.sqrt(sum(x * x for x in embedding))
        
        # Norm should be positive and not too large
        if 0.1 <= norm <= 100.0:
            return None
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="norm_anomaly",
            baseline_value=1.0,  # Normalized embeddings expected
            current_value=norm,
            threshold=0.9,  # 90% deviation allowed
        )
    
    def _check_sparsity(
        self,
        embedding: list[float],
    ) -> Optional[DriftMetrics]:
        """Check embedding sparsity."""
        if not embedding:
            return None
        
        zero_count = sum(1 for x in embedding if abs(x) < 1e-10)
        sparsity = zero_count / len(embedding)
        
        # High sparsity is anomalous
        if sparsity < 0.5:
            return None
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="high_sparsity",
            baseline_value=0.0,
            current_value=sparsity,
            threshold=0.5,
        )
    
    def _check_distribution(
        self,
        embedding: list[float],
    ) -> Optional[DriftMetrics]:
        """Check embedding value distribution."""
        if len(embedding) < 2:
            return None
        
        mean = statistics.mean(embedding)
        stdev = statistics.stdev(embedding)
        
        # Check for uniform distribution (potential anomaly)
        # Normal embeddings have varied values
        if stdev < 1e-10:
            return DriftMetrics(
                metric_id=str(uuid.uuid4()),
                metric_type="uniform_distribution",
                baseline_value=0.1,  # Expect some variance
                current_value=stdev,
                threshold=0.01,
            )
        
        # Check for extreme values
        max_val = max(embedding)
        min_val = min(embedding)
        
        if max_val > 1000 or min_val < -1000:
            return DriftMetrics(
                metric_id=str(uuid.uuid4()),
                metric_type="extreme_values",
                baseline_value=10.0,  # Reasonable range
                current_value=max(abs(max_val), abs(min_val)),
                threshold=100.0,
            )
        
        return None
    
    def _check_plausibility(
        self,
        embedding: list[float],
        references: Sequence[list[float]],
    ) -> Optional[DriftMetrics]:
        """Check embedding plausibility against references.
        
        Uses average cosine similarity to reference embeddings.
        """
        if not references:
            return None
        
        # Compute average similarity to references
        similarities = []
        for ref in references:
            if len(ref) != len(embedding):
                continue
            
            dot = sum(a * b for a, b in zip(embedding, ref))
            norm_e = math.sqrt(sum(x * x for x in embedding))
            norm_r = math.sqrt(sum(x * x for x in ref))
            
            if norm_e > 0 and norm_r > 0:
                sim = dot / (norm_e * norm_r)
                similarities.append(sim)
        
        if not similarities:
            return None
        
        avg_similarity = statistics.mean(similarities)
        
        if avg_similarity >= self._plausibility_threshold:
            return None
        
        return DriftMetrics(
            metric_id=str(uuid.uuid4()),
            metric_type="low_plausibility",
            baseline_value=1.0,  # Perfect similarity
            current_value=avg_similarity,
            threshold=self._plausibility_threshold,
        )


class DriftGovernor:
    """Governor for drift-triggered actions.
    
    Converts drift metrics into governance triggers
    with appropriate actions.
    
    Core Principle: Drift triggers are deterministic;
    the same metrics always produce the same trigger.
    """
    
    def __init__(
        self,
        drift_detector: DriftDetector,
        anomaly_analyzer: AnomalyAnalyzer,
        alert_threshold: AnomalyScore = AnomalyScore.WARNING,
        quarantine_threshold: AnomalyScore = AnomalyScore.ANOMALOUS,
        lockdown_threshold: AnomalyScore = AnomalyScore.CRITICAL,
    ):
        """Initialize the drift governor.
        
        Args:
            drift_detector: Drift detection engine
            anomaly_analyzer: Anomaly analysis engine
            alert_threshold: Threshold for alert action
            quarantine_threshold: Threshold for quarantine action
            lockdown_threshold: Threshold for lockdown action
        """
        self._detector = drift_detector
        self._analyzer = anomaly_analyzer
        self._alert_threshold = alert_threshold
        self._quarantine_threshold = quarantine_threshold
        self._lockdown_threshold = lockdown_threshold
        self._triggers: list[DriftTrigger] = []
        self._lock = threading.RLock()
    
    def evaluate(
        self,
        vectors: Sequence[list[float]],
        reference_embeddings: Optional[Sequence[list[float]]] = None,
        expected_dimensions: Optional[int] = None,
    ) -> Optional[DriftTrigger]:
        """Evaluate vectors for drift and generate triggers.
        
        Args:
            vectors: Vectors to evaluate
            reference_embeddings: Reference embeddings for plausibility
            expected_dimensions: Expected number of dimensions (uses baseline if None)
        
        Returns:
            DriftTrigger if thresholds exceeded, None otherwise
        """
        with self._lock:
            # Detect drift
            drift_metrics = self._detector.detect(vectors)
            
            # Get expected dimensions from baseline if not provided
            if expected_dimensions is None:
                expected_dimensions = self._detector._baseline.dimensions if self._detector._baseline else 0
            
            # Analyze individual embeddings
            all_metrics = list(drift_metrics)
            for v in vectors[:10]:  # Sample first 10 for efficiency
                anomaly_metrics = self._analyzer.analyze_embedding(
                    v, expected_dimensions, reference_embeddings
                )
                all_metrics.extend(anomaly_metrics)
            
            if not all_metrics:
                return None
            
            # Determine overall severity
            severity_order = list(AnomalyScore)
            max_severity = max(
                all_metrics,
                key=lambda m: severity_order.index(m.score)
            ).score
            
            # Check if any metric exceeds alert threshold
            alert_idx = severity_order.index(self._alert_threshold)
            max_idx = severity_order.index(max_severity)
            
            if max_idx < alert_idx:
                return None
            
            # Determine action
            action = self._determine_action(max_severity)
            
            # Determine drift type
            drift_type = self._determine_drift_type(all_metrics)
            
            # Create trigger
            trigger = DriftTrigger(
                trigger_id=str(uuid.uuid4()),
                drift_type=drift_type,
                metrics=all_metrics,
                severity=max_severity,
                action=action,
                affected_count=len(vectors),
            )
            
            self._triggers.append(trigger)
            
            logger.warning(
                f"Generated drift trigger {trigger.trigger_id[:8]}... "
                f"(type={drift_type.value}, severity={max_severity.value}, "
                f"action={action.value})"
            )
            
            return trigger
    
    def _determine_action(self, severity: AnomalyScore) -> TriggerAction:
        """Determine action based on severity."""
        severity_order = list(AnomalyScore)
        severity_idx = severity_order.index(severity)
        
        lockdown_idx = severity_order.index(self._lockdown_threshold)
        quarantine_idx = severity_order.index(self._quarantine_threshold)
        alert_idx = severity_order.index(self._alert_threshold)
        
        if severity_idx >= lockdown_idx:
            return TriggerAction.LOCKDOWN
        elif severity_idx >= quarantine_idx:
            return TriggerAction.QUARANTINE
        elif severity_idx >= alert_idx:
            return TriggerAction.ALERT
        else:
            return TriggerAction.NONE
    
    def _determine_drift_type(
        self,
        metrics: list[DriftMetrics],
    ) -> DriftType:
        """Determine drift type from metrics."""
        metric_types = {m.metric_type for m in metrics}
        
        if "centroid_shift" in metric_types:
            return DriftType.CONCEPT_DRIFT
        elif "distribution_change" in metric_types:
            return DriftType.DATA_DRIFT
        elif "temporal_drift_rate" in metric_types:
            return DriftType.TEMPORAL_DRIFT
        elif "outlier_ratio" in metric_types:
            return DriftType.SPATIAL_DRIFT
        else:
            return DriftType.MODEL_DRIFT
    
    def acknowledge_trigger(
        self,
        trigger_id: str,
        acknowledged_by: str,
    ) -> Optional[DriftTrigger]:
        """Acknowledge a drift trigger.
        
        Args:
            trigger_id: ID of the trigger
            acknowledged_by: Who is acknowledging
        
        Returns:
            Updated DriftTrigger, or None if not found
        """
        with self._lock:
            for trigger in self._triggers:
                if trigger.trigger_id == trigger_id:
                    trigger.acknowledged = True
                    trigger.acknowledged_by = acknowledged_by
                    trigger.acknowledged_at = datetime.now(timezone.utc)
                    
                    logger.info(
                        f"Acknowledged drift trigger {trigger_id[:8]}... "
                        f"(by={acknowledged_by})"
                    )
                    
                    return trigger
            
            return None
    
    def get_trigger(self, trigger_id: str) -> Optional[DriftTrigger]:
        """Get a trigger by ID."""
        for trigger in self._triggers:
            if trigger.trigger_id == trigger_id:
                return trigger
        return None
    
    def list_active_triggers(self) -> list[DriftTrigger]:
        """List all unacknowledged triggers."""
        return [t for t in self._triggers if not t.acknowledged]
    
    def get_stats(self) -> dict:
        """Get governor statistics."""
        active = self.list_active_triggers()
        
        by_severity: dict[str, int] = {}
        for t in active:
            by_severity[t.severity.value] = by_severity.get(t.severity.value, 0) + 1
        
        by_type: dict[str, int] = {}
        for t in active:
            by_type[t.drift_type.value] = by_type.get(t.drift_type.value, 0) + 1
        
        return {
            "total_triggers": len(self._triggers),
            "active_triggers": len(active),
            "by_severity": by_severity,
            "by_type": by_type,
        }


def create_drift_governor(
    centroid_threshold: float = 0.1,
    distribution_threshold: float = 0.15,
    outlier_threshold: float = 3.0,
    plausibility_threshold: float = 0.7,
    alert_threshold: AnomalyScore = AnomalyScore.WARNING,
    quarantine_threshold: AnomalyScore = AnomalyScore.ANOMALOUS,
    lockdown_threshold: AnomalyScore = AnomalyScore.CRITICAL,
) -> DriftGovernor:
    """Factory function to create a drift governor.
    
    Args:
        centroid_threshold: Threshold for centroid shift
        distribution_threshold: Threshold for distribution change
        outlier_threshold: Standard deviations for outliers
        plausibility_threshold: Minimum plausibility score
        alert_threshold: Threshold for alert action
        quarantine_threshold: Threshold for quarantine action
        lockdown_threshold: Threshold for lockdown action
    
    Returns:
        Configured DriftGovernor instance
    """
    detector = DriftDetector(
        centroid_threshold=centroid_threshold,
        distribution_threshold=distribution_threshold,
        outlier_threshold=outlier_threshold,
    )
    
    analyzer = AnomalyAnalyzer(
        plausibility_threshold=plausibility_threshold,
    )
    
    return DriftGovernor(
        drift_detector=detector,
        anomaly_analyzer=analyzer,
        alert_threshold=alert_threshold,
        quarantine_threshold=quarantine_threshold,
        lockdown_threshold=lockdown_threshold,
    )
