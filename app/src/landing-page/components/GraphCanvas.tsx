import { useEffect, useRef } from "react";

type EntityType =
  | "person"
  | "project"
  | "decision"
  | "task"
  | "event"
  | "commitment"
  | "note"
  | "assumption";

const TYPE_COLORS: Record<EntityType, string> = {
  person: "#B8976A",
  project: "#6BA8B8",
  decision: "#B89F6B",
  task: "#8AB86B",
  event: "#B86B8A",
  commitment: "#8A6BB8",
  note: "#E8E4DE",
  assumption: "#B87A6B",
};

// Cluster angles — each type gets a sector of the circle for organized layout
const TYPE_SECTOR: Record<EntityType, number> = {
  person: 0,
  project: (Math.PI * 2) / 8,
  decision: (Math.PI * 2 * 2) / 8,
  task: (Math.PI * 2 * 3) / 8,
  event: (Math.PI * 2 * 4) / 8,
  commitment: (Math.PI * 2 * 5) / 8,
  note: (Math.PI * 2 * 6) / 8,
  assumption: (Math.PI * 2 * 7) / 8,
};

const DOT_DATA: { label: string; type: EntityType }[] = [
  { label: "Dr. Martinez", type: "person" },
  { label: "Q3 Budget", type: "project" },
  { label: "Mom's Birthday", type: "event" },
  { label: "Lease renewal", type: "task" },
  { label: "Tokyo trip", type: "event" },
  { label: "Board meeting", type: "event" },
  { label: "Sarah's wedding", type: "event" },
  { label: "Gym membership", type: "commitment" },
  { label: "Jake (tutor)", type: "person" },
  { label: "Migrate to AWS", type: "decision" },
  { label: "Weekly groceries", type: "task" },
  { label: "Book club", type: "commitment" },
  { label: "Tax filing", type: "task" },
  { label: "Series A terms", type: "decision" },
  { label: "Dog vet appt", type: "task" },
  { label: "Piano recital", type: "event" },
  { label: "Investor update", type: "project" },
  { label: "Call Mom", type: "task" },
  { label: "Hire designer", type: "decision" },
  { label: "Soccer practice", type: "commitment" },
  { label: "Anniversary", type: "event" },
  { label: "Roof repair", type: "task" },
  { label: "Lisa (partner)", type: "person" },
  { label: "Diet plan", type: "assumption" },
  { label: "Client proposal", type: "project" },
  { label: "School pickup", type: "commitment" },
  { label: "Read that book", type: "note" },
  { label: "Dentist Thurs", type: "task" },
  { label: "Ship v2.0", type: "project" },
  { label: "Team offsite", type: "event" },
  { label: "Insurance claim", type: "task" },
  { label: "Meditation", type: "commitment" },
  { label: "Board deck", type: "project" },
  { label: "Passport renewal", type: "task" },
  { label: "Weekend plans", type: "note" },
  { label: "Nanny schedule", type: "assumption" },
  { label: "Fix drawer", type: "note" },
  { label: "HOA meeting", type: "event" },
  { label: "Cancel subscription", type: "task" },
  { label: "Therapy 4pm", type: "commitment" },
];

// Labeled relationship edges (by dot label pairs)
const LABELED_EDGES: { from: string; to: string; relation: string }[] = [
  { from: "Series A terms", to: "Board meeting", relation: "needs approval" },
  { from: "Ship v2.0", to: "Hire designer", relation: "blocked by" },
  { from: "Diet plan", to: "Weekly groceries", relation: "contradiction" },
  { from: "Team offsite", to: "Q3 Budget", relation: "blocked by office planning" },
  { from: "Investor update", to: "Board deck", relation: "depends on" },
  { from: "Mom's Birthday", to: "Call Mom", relation: "reminder" },
  { from: "Lisa (partner)", to: "Anniversary", relation: "don't forget" },
  { from: "Lease renewal", to: "Insurance claim", relation: "related" },
  { from: "Tax filing", to: "Nanny schedule", relation: "needs docs" },
  { from: "Therapy 4pm", to: "Soccer practice", relation: "schedule conflict" },
];

interface Dot {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  scatterX: number;
  scatterY: number;
  driftAngle: number;
  driftSpeed: number;
  driftRadius: number;
  label: string;
  type: EntityType;
  colorProgress: number;
  connected: boolean;
  connectionProgress: number;
}

interface Edge {
  a: number;
  b: number;
  relation?: string;
}

// Alfred roaming dot state
interface AlfredAgent {
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  targetDotIndex: number;
  travelProgress: number; // 0→1 lerp between from→to
  visitOrder: number[];   // order of dot indices to visit
  visitIndex: number;     // current index in visitOrder
  trail: { x: number; y: number; alpha: number }[];
}

// Build edges: nearest neighbors + labeled relationships
function buildEdges(dots: Dot[]): Edge[] {
  const edgeSet = new Set<string>();
  const edges: Edge[] = [];

  const key = (a: number, b: number) =>
    `${Math.min(a, b)}-${Math.max(a, b)}`;

  // Labeled edges first
  const labelByDotName = new Map<string, number>();
  dots.forEach((d, i) => labelByDotName.set(d.label, i));

  for (const le of LABELED_EDGES) {
    const ai = labelByDotName.get(le.from);
    const bi = labelByDotName.get(le.to);
    if (ai !== undefined && bi !== undefined) {
      const k = key(ai, bi);
      if (!edgeSet.has(k)) {
        edgeSet.add(k);
        edges.push({ a: ai, b: bi, relation: le.relation });
      }
    }
  }

  // Nearest-neighbor edges (1-2 per node)
  for (let i = 0; i < dots.length; i++) {
    const dists: { j: number; d: number }[] = [];
    for (let j = 0; j < dots.length; j++) {
      if (i === j) continue;
      const dx = dots[i].scatterX - dots[j].scatterX;
      const dy = dots[i].scatterY - dots[j].scatterY;
      dists.push({ j, d: Math.sqrt(dx * dx + dy * dy) });
    }
    dists.sort((a, b) => a.d - b.d);
    const count = 1 + Math.floor(Math.random() * 2); // 1-2 edges
    for (let k = 0; k < count && k < dists.length; k++) {
      const ek = key(i, dists[k].j);
      if (!edgeSet.has(ek)) {
        edgeSet.add(ek);
        edges.push({ a: i, b: dists[k].j });
      }
    }
  }

  return edges;
}

// Generate a visit order: nearest-neighbor path starting from a random node
function buildVisitOrder(dots: Dot[]): number[] {
  const n = dots.length;
  const visited = new Set<number>();
  const order: number[] = [];
  let current = Math.floor(Math.random() * n);
  order.push(current);
  visited.add(current);

  while (visited.size < n) {
    let nearest = -1;
    let nearestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) continue;
      const dx = dots[current].scatterX - dots[j].scatterX;
      const dy = dots[current].scatterY - dots[j].scatterY;
      const dist = dx * dx + dy * dy;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = j;
      }
    }
    if (nearest === -1) break;
    order.push(nearest);
    visited.add(nearest);
    current = nearest;
  }

  return order;
}

// Repulsion pass: push overlapping nodes apart, clamp to rectangular bounds
function applyRepulsion(
  positions: { x: number; y: number }[],
  minDist: number,
  iterations: number,
  cx: number,
  cy: number,
  _maxR: number,
) {
  const padX = cx * 0.92;
  const padY = cy * 0.92;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist && dist > 0) {
          const force = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          positions[i].x -= nx * force;
          positions[i].y -= ny * force;
          positions[j].x += nx * force;
          positions[j].y += ny * force;
        }
      }
    }
    // Clamp to rectangular canvas bounds
    for (const p of positions) {
      p.x = Math.max(cx - padX, Math.min(cx + padX, p.x));
      p.y = Math.max(cy - padY, Math.min(cy + padY, p.y));
    }
  }
}

export default function GraphCanvas({
  className = "",
}: {
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    dots: Dot[];
    edges: Edge[];
    phase: "scattered" | "connecting" | "steady";
    phaseStartTime: number;
    youOpacity: number;
    visible: boolean;
    visibleSince: number;
    alfred: AlfredAgent;
  }>({
    dots: [],
    edges: [],
    phase: "scattered",
    phaseStartTime: 0,
    youOpacity: 0,
    visible: false,
    visibleSince: 0,
    alfred: {
      x: 0, y: 0,
      fromX: 0, fromY: 0, toX: 0, toY: 0,
      targetDotIndex: 0, travelProgress: 0,
      visitOrder: [], visitIndex: 0,
      trail: [],
    },
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    const state = stateRef.current;

    function resize() {
      if (!canvas) return;
      const dpr = window.devicePixelRatio;
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function initDots() {
      if (!canvas) return;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      const cx = w / 2;
      const cy = h / 2;
      const spreadX = cx * 0.92;
      const spreadY = cy * 0.92;

      // Random scatter positions
      const scatterPos = DOT_DATA.map(() => {
        return {
          x: cx + (Math.random() - 0.5) * 2 * spreadX,
          y: cy + (Math.random() - 0.5) * 2 * spreadY,
        };
      });

      applyRepulsion(scatterPos, 90, 80, cx, cy, Math.max(spreadX, spreadY));

      // Target positions: clustered by entity type
      const typeCounters: Record<string, number> = {};
      const targetPos = DOT_DATA.map((d) => {
        const sectorAngle = TYPE_SECTOR[d.type];
        const idx = (typeCounters[d.type] = (typeCounters[d.type] || 0) + 1);
        const jitterAngle = sectorAngle + (idx * 0.3 - 0.6) + (Math.random() - 0.5) * 0.25;
        const dist = 0.35 + idx * 0.09 + Math.random() * 0.12;
        return {
          x: cx + Math.cos(jitterAngle) * spreadX * Math.min(dist, 0.85),
          y: cy + Math.sin(jitterAngle) * spreadY * Math.min(dist, 0.85),
        };
      });

      applyRepulsion(targetPos, 70, 50, cx, cy, Math.max(spreadX, spreadY) * 0.88);

      state.dots = DOT_DATA.map((d, i) => ({
        x: scatterPos[i].x,
        y: scatterPos[i].y,
        targetX: targetPos[i].x,
        targetY: targetPos[i].y,
        scatterX: scatterPos[i].x,
        scatterY: scatterPos[i].y,
        driftAngle: Math.random() * Math.PI * 2,
        driftSpeed: 0.002 + Math.random() * 0.003,
        driftRadius: 1.5 + Math.random() * 3,
        label: d.label,
        type: d.type,
        colorProgress: 0,
        connected: false,
        connectionProgress: 0,
      }));

      state.edges = buildEdges(state.dots);
      state.phase = "scattered";
      state.phaseStartTime = 0;
      state.youOpacity = 0;
      state.visible = false;
      state.visibleSince = 0;

      // Init Alfred roaming agent
      const visitOrder = buildVisitOrder(state.dots);
      const firstDot = state.dots[visitOrder[0]];
      state.alfred = {
        x: firstDot.scatterX,
        y: firstDot.scatterY,
        fromX: firstDot.scatterX,
        fromY: firstDot.scatterY,
        toX: firstDot.scatterX,
        toY: firstDot.scatterY,
        targetDotIndex: visitOrder[0],
        travelProgress: 1,
        visitOrder,
        visitIndex: 0,
        trail: [],
      };
    }

    function draw(timestamp: number) {
      if (!canvas || !ctx) return;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      const cx = w / 2;
      const cy = h / 2;

      ctx.clearRect(0, 0, w, h);

      const alfred = state.alfred;
      let alfredActive = false;

      // Phase transitions
      if (state.visible) {
        const elapsed = timestamp - state.visibleSince;

        // "YOU" fades in immediately
        state.youOpacity = Math.min(1, elapsed / 1500);

        // Hold scattered state for 5 seconds
        if (state.phase === "scattered" && elapsed > 5000) {
          state.phase = "connecting";
          state.phaseStartTime = timestamp;
        }

        if (state.phase === "connecting" || state.phase === "steady") {
          alfredActive = true;
          const ce = timestamp - state.phaseStartTime;

          // Alfred roaming logic: zips between nodes
          const TRAVEL_SPEED = 0.025; // progress per frame (~150ms per hop)

          if (alfred.travelProgress >= 1) {
            // Arrived — connect this dot
            const dotIdx = alfred.targetDotIndex;
            if (!state.dots[dotIdx].connected) {
              state.dots[dotIdx].connected = true;
            }

            // Move to next target
            alfred.visitIndex++;
            if (alfred.visitIndex < alfred.visitOrder.length) {
              const nextIdx = alfred.visitOrder[alfred.visitIndex];
              alfred.fromX = alfred.x;
              alfred.fromY = alfred.y;
              alfred.toX = state.dots[nextIdx].x;
              alfred.toY = state.dots[nextIdx].y;
              alfred.targetDotIndex = nextIdx;
              alfred.travelProgress = 0;
            } else {
              // All visited — steady state
              state.phase = "steady";
            }
          }

          if (alfred.travelProgress < 1) {
            alfred.travelProgress = Math.min(1, alfred.travelProgress + TRAVEL_SPEED);
            // Ease-out for snappy movement
            const t = 1 - Math.pow(1 - alfred.travelProgress, 3);
            alfred.x = alfred.fromX + (alfred.toX - alfred.fromX) * t;
            alfred.y = alfred.fromY + (alfred.toY - alfred.fromY) * t;
          }

          // Update trail
          alfred.trail.push({ x: alfred.x, y: alfred.y, alpha: 0.6 });
          // Decay trail
          for (let i = alfred.trail.length - 1; i >= 0; i--) {
            alfred.trail[i].alpha -= 0.015;
            if (alfred.trail[i].alpha <= 0) {
              alfred.trail.splice(i, 1);
            }
          }

          // Progress connected dots' color and pull toward target
          for (const dot of state.dots) {
            if (dot.connected) {
              dot.colorProgress = Math.min(1, dot.colorProgress + 0.02);
              dot.connectionProgress = Math.min(1, dot.connectionProgress + 0.025);

              const ease = dot.connectionProgress * dot.connectionProgress * (3 - 2 * dot.connectionProgress);
              dot.x = dot.scatterX + (dot.targetX - dot.scatterX) * ease;
              dot.y = dot.scatterY + (dot.targetY - dot.scatterY) * ease;
            }
          }
        }
      }

      // Compute drawn positions with drift
      const drawn: { x: number; y: number }[] = [];
      for (const dot of state.dots) {
        dot.driftAngle += dot.driftSpeed;
        drawn.push({
          x: dot.x + Math.cos(dot.driftAngle) * dot.driftRadius,
          y: dot.y + Math.sin(dot.driftAngle) * dot.driftRadius,
        });
      }

      // ---- Draw edges ----
      for (const edge of state.edges) {
        const pa = drawn[edge.a];
        const pb = drawn[edge.b];
        const dotA = state.dots[edge.a];
        const dotB = state.dots[edge.b];
        const bothConnected = dotA.connected && dotB.connected;
        const minColor = Math.min(dotA.colorProgress, dotB.colorProgress);

        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);

        if (bothConnected && minColor > 0) {
          ctx.strokeStyle = `rgba(184, 151, 106, ${0.12 + 0.2 * minColor})`;
          ctx.lineWidth = 1;
        } else {
          ctx.strokeStyle = "rgba(232, 228, 222, 0.12)";
          ctx.lineWidth = 0.7;
        }
        ctx.stroke();

        // Edge label (only for labeled edges, only after both connected)
        if (edge.relation && bothConnected && minColor > 0.5) {
          const mx = (pa.x + pb.x) / 2;
          const my = (pa.y + pb.y) / 2;
          const labelAlpha = Math.min(1, (minColor - 0.5) * 2);
          ctx.font = "9px 'JetBrains Mono', monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = `rgba(184, 151, 106, ${0.55 * labelAlpha})`;
          ctx.fillText(edge.relation, mx, my - 4);
        }
      }

      // ---- Draw dots and labels ----
      for (let i = 0; i < state.dots.length; i++) {
        const dot = state.dots[i];
        const pos = drawn[i];

        const tc = TYPE_COLORS[dot.type];
        const r = parseInt(tc.slice(1, 3), 16);
        const g = parseInt(tc.slice(3, 5), 16);
        const b = parseInt(tc.slice(5, 7), 16);

        const dotColor =
          dot.colorProgress > 0
            ? `rgba(${r}, ${g}, ${b}, ${0.4 + 0.5 * dot.colorProgress})`
            : "rgba(232, 228, 222, 0.35)";

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();

        ctx.font = "11px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle =
          dot.colorProgress > 0
            ? `rgba(${r}, ${g}, ${b}, ${0.4 + 0.45 * dot.colorProgress})`
            : "rgba(232, 228, 222, 0.3)";
        ctx.fillText(dot.label, pos.x, pos.y + 17);
      }

      // ---- "YOU" center node (always visible once section is in view) ----
      if (state.youOpacity > 0) {
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 40);
        grad.addColorStop(0, `rgba(232, 228, 222, ${0.12 * state.youOpacity})`);
        grad.addColorStop(1, "rgba(232, 228, 222, 0)");
        ctx.beginPath();
        ctx.arc(cx, cy, 40, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(232, 228, 222, ${0.7 * state.youOpacity})`;
        ctx.fill();

        ctx.font = "bold 12px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(232, 228, 222, ${0.6 * state.youOpacity})`;
        ctx.fillText("YOU", cx, cy + 20);
      }

      // ---- Alfred roaming agent (drawn on top of everything) ----
      if (alfredActive) {
        // Trail
        for (const pt of alfred.trail) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(184, 151, 106, ${pt.alpha * 0.4})`;
          ctx.fill();
        }

        // Glow
        const glow = ctx.createRadialGradient(alfred.x, alfred.y, 0, alfred.x, alfred.y, 25);
        glow.addColorStop(0, "rgba(184, 151, 106, 0.25)");
        glow.addColorStop(1, "rgba(184, 151, 106, 0)");
        ctx.beginPath();
        ctx.arc(alfred.x, alfred.y, 25, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        // Dot
        ctx.beginPath();
        ctx.arc(alfred.x, alfred.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(184, 151, 106, 0.95)";
        ctx.fill();

        // Label
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(184, 151, 106, 0.85)";
        ctx.fillText("ALFRED", alfred.x, alfred.y - 10);
      }

      animationId = requestAnimationFrame(draw);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !state.visible) {
            state.visible = true;
            state.visibleSince = performance.now();
          }
        });
      },
      { threshold: 0.3 },
    );
    observer.observe(canvas);

    resize();
    initDots();
    animationId = requestAnimationFrame(draw);

    const onResize = () => {
      resize();
      initDots();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", onResize);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={`h-full w-full ${className}`} />;
}
