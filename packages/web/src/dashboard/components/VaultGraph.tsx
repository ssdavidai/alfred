import { useRef, useCallback, useMemo, useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery, getVaultGraph, getVaultRecords } from "wasp/client/operations";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods, NodeObject } from "react-force-graph-3d";
import * as THREE from "three";
import { VAULT_TYPE_COLORS, AGENT_CONFIG } from "../constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  type: string;
  name: string;
  status: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

interface ActivityEntry {
  agent: string;
  file: string;
  action: string;
  ts: string;
}

type GNode = NodeObject<GraphNode>;

// Agent color lookup
const AGENT_COLORS: Record<string, string> = {};
for (const a of AGENT_CONFIG) {
  AGENT_COLORS[a.key] = a.color;
  AGENT_COLORS[`vault-${a.key}`] = a.color;
}

const GLOW_DURATION_MS = 60 * 60 * 1000;
const GRAPH_HEIGHT = 620;
const SEARCH_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// C-B2 — optional matter-focus mode. When `focusPath` is set the graph asks
// ctrl-api for that record's neighborhood (`?focus=`) and renders only the
// focus node + its 1-hop neighbors at a compact height. With no props it
// stays the whole-vault explorer the CommandCenter mounts (back-compat).
interface VaultGraphProps {
  focusPath?: string;
  height?: number;
}

export default function VaultGraph({ focusPath, height }: VaultGraphProps = {}) {
  const isFocusMode = Boolean(focusPath);
  const graphHeight = height ?? (isFocusMode ? 420 : GRAPH_HEIGHT);
  const fgRef = useRef<ForceGraphMethods<GNode>>();
  const containerRef = useRef<HTMLDivElement>(null);
  // Beacon layers: each node can have up to 3 pulsing ring materials
  const beaconMaterials = useRef<Map<string, THREE.MeshBasicMaterial[]>>(new Map());
  const navigate = useNavigate();

  const [containerWidth, setContainerWidth] = useState(800);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [showResults, setShowResults] = useState(false);

  // Track container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Debounce search for server-side grep
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Graph data (30s poll). In focus mode forward `?focus=` so ctrl-api
  // returns the matter's neighborhood; otherwise whole-vault as before.
  const { data: graphData } = useQuery(
    getVaultGraph,
    isFocusMode ? { focus: focusPath as string } : undefined,
    { refetchInterval: 30_000 },
  );

  // Server-side full-text search (debounced)
  const { data: serverResults } = useQuery(
    getVaultRecords,
    { query: debouncedQuery },
    { enabled: debouncedQuery.length >= 2 },
  );

  // ---- Search matching ----

  // Client-side: match node names, types, status
  const clientMatches = useMemo(() => {
    const set = new Set<string>();
    if (!searchQuery || searchQuery.length < 2 || !graphData?.nodes) return set;
    const q = searchQuery.toLowerCase();
    for (const n of graphData.nodes as GraphNode[]) {
      if (
        n.name.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q) ||
        n.status.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q)
      ) {
        set.add(n.id);
      }
    }
    return set;
  }, [searchQuery, graphData]);

  // Server-side: match file paths from grep results
  const serverMatches = useMemo(() => {
    const set = new Set<string>();
    if (!serverResults?.results) return set;
    for (const r of serverResults.results as any[]) {
      // Server returns path without .md sometimes; normalize
      const p = r.path?.endsWith(".md") ? r.path : r.path + ".md";
      set.add(p);
    }
    return set;
  }, [serverResults]);

  // Combined matches
  const matchedIds = useMemo(() => {
    const set = new Set<string>();
    for (const id of clientMatches) set.add(id);
    for (const id of serverMatches) set.add(id);
    return set;
  }, [clientMatches, serverMatches]);

  // Neighbor nodes (1-hop from matched)
  const neighborIds = useMemo(() => {
    const set = new Set<string>();
    if (matchedIds.size === 0 || !graphData?.edges) return set;
    for (const e of graphData.edges as GraphEdge[]) {
      if (matchedIds.has(e.source)) set.add(e.target);
      if (matchedIds.has(e.target)) set.add(e.source);
    }
    // Remove nodes that are already direct matches
    for (const id of matchedIds) set.delete(id);
    return set;
  }, [matchedIds, graphData]);

  const isSearchActive = searchQuery.length >= 2;

  // Combined results list (matched graph nodes, ordered)
  const searchResults = useMemo(() => {
    if (!isSearchActive || !graphData?.nodes) return [];
    const nodes = graphData.nodes as GraphNode[];
    return nodes
      .filter((n) => matchedIds.has(n.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  }, [isSearchActive, matchedIds, graphData]);

  // ---- Agent activity ----

  const agentTouchMap = useMemo(() => {
    const map = new Map<string, { color: string; recency: number; agent: string }>();
    if (!graphData?.activity) return map;
    const now = Date.now();
    for (const entry of graphData.activity as ActivityEntry[]) {
      const ts = new Date(entry.ts).getTime();
      if (isNaN(ts)) continue;
      const age = now - ts;
      if (age > GLOW_DURATION_MS) continue;
      const recency = 1 - age / GLOW_DURATION_MS;
      const agentKey = entry.agent.replace(/^vault-/, "");
      const color = AGENT_COLORS[entry.agent] || AGENT_COLORS["curator"];
      const existing = map.get(entry.file);
      if (!existing || existing.recency < recency) {
        map.set(entry.file, { color, recency, agent: agentKey });
      }
    }
    return map;
  }, [graphData]);

  // ---- Graph data ----

  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!graphData?.edges) return counts;
    for (const e of graphData.edges as GraphEdge[]) {
      counts.set(e.source, (counts.get(e.source) || 0) + 1);
      counts.set(e.target, (counts.get(e.target) || 0) + 1);
    }
    return counts;
  }, [graphData]);

  // C-B2 — in focus mode, restrict to the focus node + its 1-hop neighbors.
  // The `?focus=` endpoint may return the whole graph, so filter client-side
  // (same neighbor pattern the search path uses). Normalize focusPath to the
  // node id convention (display path, with `.md`).
  const focusId = useMemo(() => {
    if (!focusPath) return null;
    return focusPath.endsWith(".md") ? focusPath : `${focusPath}.md`;
  }, [focusPath]);

  const focusVisibleIds = useMemo(() => {
    if (!isFocusMode || !focusId || !graphData?.edges) return null;
    const set = new Set<string>([focusId]);
    for (const e of graphData.edges as GraphEdge[]) {
      if (e.source === focusId) set.add(e.target);
      if (e.target === focusId) set.add(e.source);
    }
    return set;
  }, [isFocusMode, focusId, graphData]);

  const fg3dData = useMemo(() => {
    if (!graphData?.nodes) return { nodes: [], links: [] };
    let nodes = graphData.nodes as GraphNode[];
    let edges = graphData.edges as GraphEdge[];
    if (focusVisibleIds) {
      nodes = nodes.filter((n) => focusVisibleIds.has(n.id));
      edges = edges.filter(
        (e) => focusVisibleIds.has(e.source) && focusVisibleIds.has(e.target),
      );
    }
    return {
      nodes: nodes.map((n) => ({ ...n })),
      links: edges.map((e) => ({
        source: e.source,
        target: e.target,
        relation: e.relation,
      })),
    };
  }, [graphData, focusVisibleIds]);

  // Configure forces for tighter clustering + zoom to fit on initial load
  useEffect(() => {
    if (fg3dData.nodes.length > 0 && fgRef.current) {
      const fg = fgRef.current;
      try {
        const charge = fg.d3Force("charge");
        if (charge && typeof charge.strength === "function") charge.strength(-40);
        const link = fg.d3Force("link");
        if (link && typeof link.distance === "function") link.distance(20);
        if (typeof fg.d3ReheatSimulation === "function") fg.d3ReheatSimulation();
      } catch { /* ignore — force config is optional enhancement */ }
      const timer = setTimeout(() => fgRef.current?.zoomToFit(600, 50), 1800);
      return () => clearTimeout(timer);
    }
  }, [fg3dData.nodes.length]);

  // ---- Pulsing agent glow via onEngineTick ----

  const onEngineTick = useCallback(() => {
    const now = performance.now();
    for (const [, layers] of beaconMaterials.current) {
      for (let i = 0; i < layers.length; i++) {
        const mat = layers[i];
        if (!mat) continue;
        const base = (mat as any)._beaconBaseOpacity ?? 0.3;
        // Each ring gets a staggered phase offset → ripple outward effect
        const phase = (now * 0.002 - i * 1.4) % (Math.PI * 2);
        const wave = Math.sin(phase) * 0.5 + 0.5; // 0..1
        // Inner rings pulse brighter, outer rings fade more
        const fade = 1 - i * 0.15;
        mat.opacity = base * fade * (0.2 + 0.8 * wave);
        // Scale the ring meshes — outer rings breathe more for visible ripple
        const mesh = (mat as any)._beaconMesh;
        if (mesh) {
          const baseScale = 1 + i * 0.1;
          const breathe = baseScale + wave * (0.15 + i * 0.08);
          mesh.scale.setScalar(breathe);
        }
      }
    }
  }, []);

  // ---- Three.js node objects ----

  const nodeThreeObject = useCallback(
    (node: GNode) => {
      const id = node.id as string;
      const group = new THREE.Group();
      const baseColor = VAULT_TYPE_COLORS[node.type] || "#8A8680";
      const count = connectionCounts.get(id) || 0;
      const radius = 3.5 + Math.min(count, 15) * 0.5;

      // Determine visual state
      const isMatch = isSearchActive && matchedIds.has(id);
      const isNeighbor = isSearchActive && neighborIds.has(id);
      const isDimmed = isSearchActive && !isMatch && !isNeighbor;
      const touch = agentTouchMap.get(id);

      // Main sphere — glow emissive when agent-touched or search-matched
      const isBeacon = !!touch && touch.recency > 0.05 && !isDimmed;
      const geo = new THREE.SphereGeometry(radius, 16, 12);
      const matParams: THREE.MeshLambertMaterialParameters = {
        color: isMatch ? "#ffffff" : baseColor,
        transparent: true,
        opacity: isDimmed ? 0.12 : isMatch ? 0.95 : isNeighbor ? 0.6 : 0.85,
      };
      if (isMatch) {
        matParams.emissive = new THREE.Color(baseColor);
        matParams.emissiveIntensity = 0.4;
      } else if (isBeacon) {
        matParams.emissive = new THREE.Color(touch!.color);
        matParams.emissiveIntensity = 0.6 * touch!.recency;
      }
      const mat = new THREE.MeshLambertMaterial(matParams);
      group.add(new THREE.Mesh(geo, mat));

      // Search highlight glow
      if (isMatch) {
        const hlGeo = new THREE.SphereGeometry(radius * 2.2, 16, 12);
        const hlMat = new THREE.MeshBasicMaterial({
          color: baseColor,
          transparent: true,
          opacity: 0.25,
        });
        group.add(new THREE.Mesh(hlGeo, hlMat));
      }

      // Beacon effect — multi-ring pulsing glow when agent is active
      // Sized to be visible even at full zoom-out on a 1000+ node graph.
      // Uses AdditiveBlending so overlapping beacons stack brighter.
      if (touch && touch.recency > 0.05 && !isDimmed) {
        const layers: THREE.MeshBasicMaterial[] = [];

        // Bright emissive core overlay
        const coreGeo = new THREE.SphereGeometry(radius * 3, 12, 8);
        const coreMat = new THREE.MeshBasicMaterial({
          color: touch.color,
          transparent: true,
          opacity: 0.55 * touch.recency,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const coreMesh = new THREE.Mesh(coreGeo, coreMat);
        (coreMat as any)._beaconBaseOpacity = 0.55 * touch.recency;
        (coreMat as any)._beaconMesh = coreMesh;
        group.add(coreMesh);
        layers.push(coreMat);

        // 3 concentric beacon rings — large enough to see from orbit
        const ringRadii = [radius * 12, radius * 25, radius * 45];
        const ringOpacities = [0.30, 0.16, 0.08];
        for (let i = 0; i < 3; i++) {
          const ringGeo = new THREE.SphereGeometry(ringRadii[i], 10, 6);
          const ringMat = new THREE.MeshBasicMaterial({
            color: touch.color,
            transparent: true,
            opacity: ringOpacities[i] * touch.recency,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const ringMesh = new THREE.Mesh(ringGeo, ringMat);
          (ringMat as any)._beaconBaseOpacity = ringOpacities[i] * touch.recency;
          (ringMat as any)._beaconMesh = ringMesh;
          group.add(ringMesh);
          layers.push(ringMat);
        }

        beaconMaterials.current.set(id, layers);
      } else {
        beaconMaterials.current.delete(id);
      }

      return group;
    },
    [agentTouchMap, connectionCounts, isSearchActive, matchedIds, neighborIds],
  );

  // ---- Labels ----

  const nodeLabel = useCallback(
    (node: GNode) => {
      const touch = agentTouchMap.get(node.id as string);
      const agentLine = touch
        ? `<div style="margin-top:3px;padding-top:3px;border-top:1px solid rgba(232,228,222,0.1);font-size:9px;color:${touch.color};">&#9679; ${touch.agent} active</div>`
        : "";
      return `<div style="padding:6px 10px;background:rgba(30,28,25,0.94);border:1px solid rgba(232,228,222,0.2);border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E8E4DE;max-width:280px;pointer-events:none;">
        <div style="font-weight:600;margin-bottom:2px;">${node.name}</div>
        <div style="opacity:0.6;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;">${node.type}${node.status ? ` / ${node.status}` : ""}</div>
        ${agentLine}
      </div>`;
    },
    [agentTouchMap],
  );

  // ---- Interactions ----

  const onNodeClick = useCallback(
    (node: GNode) => {
      // Route to the canonical vault reader. The previous target,
      // /dashboard/vault/<path>, is a dead route post-redesign.
      const recordPath = (node.id as string).replace(/\.md$/, "");
      navigate(`/vault?slug=${encodeURIComponent(recordPath)}`);
    },
    [navigate],
  );

  // ---- Link styling: brighten edges connected to search matches ----

  const linkColor = useCallback(
    (link: any) => {
      if (!isSearchActive) return "rgba(232, 228, 222, 0.2)";
      const srcId = typeof link.source === "object" ? link.source.id : link.source;
      const tgtId = typeof link.target === "object" ? link.target.id : link.target;
      const srcMatch = matchedIds.has(srcId);
      const tgtMatch = matchedIds.has(tgtId);
      if (srcMatch && tgtMatch) return "rgba(232, 228, 222, 0.7)";
      if (srcMatch || tgtMatch) return "rgba(232, 228, 222, 0.4)";
      return "rgba(232, 228, 222, 0.04)";
    },
    [isSearchActive, matchedIds],
  );

  const linkWidth = useCallback(
    (link: any) => {
      if (!isSearchActive) return 0.8;
      const srcId = typeof link.source === "object" ? link.source.id : link.source;
      const tgtId = typeof link.target === "object" ? link.target.id : link.target;
      if (matchedIds.has(srcId) && matchedIds.has(tgtId)) return 2;
      if (matchedIds.has(srcId) || matchedIds.has(tgtId)) return 1.2;
      return 0.3;
    },
    [isSearchActive, matchedIds],
  );

  const linkLabel = useCallback((link: any) => link.relation || "", []);

  // ---- Reset view ----

  const resetView = useCallback(() => {
    fgRef.current?.zoomToFit(400, 50);
  }, []);

  // ---- Active agents for legend ----

  const activeAgents = useMemo(() => {
    const agents = new Set<string>();
    for (const [, touch] of agentTouchMap) {
      agents.add(touch.agent);
    }
    return agents;
  }, [agentTouchMap]);

  // ---- Render ----

  // C-B2 — in focus mode a matter with no resolved links yields just the
  // focus node (or none). Show an honest "few links yet" line instead of the
  // whole-vault "No vault records yet" copy or an empty 3D canvas.
  const focusSparse =
    isFocusMode && fg3dData.links.length === 0;

  if (!graphData || fg3dData.nodes.length === 0 || focusSparse) {
    const message = !graphData
      ? "Loading graph data..."
      : isFocusMode
        ? "No linked records yet."
        : "No vault records yet";
    return (
      <div className="flex items-center justify-center py-16">
        <p className="font-mono text-xs text-muted-foreground/60">{message}</p>
      </div>
    );
  }

  const presentTypes = Object.entries(VAULT_TYPE_COLORS).filter(([type]) =>
    fg3dData.nodes.some((n: any) => n.type === type),
  );

  return (
    <div className="relative" ref={containerRef}>
      {/* Top bar: search + controls */}
      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setShowResults(e.target.value.length >= 2);
            }}
            placeholder="Search graph... (name, type, or content)"
            className="w-full rounded border border-gold-dim/20 bg-background/60 px-3 py-1.5 font-mono text-xs text-cream placeholder:text-muted-foreground/40 focus:border-gold/40 focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery("");
                setShowResults(false);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground/50 hover:text-cream"
            >
              &times;
            </button>
          )}
        </div>
        <button
          onClick={resetView}
          className="shrink-0 rounded border border-gold-dim/20 bg-background/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:border-gold/40 hover:text-cream"
        >
          Reset View
        </button>
      </div>

      {/* Search match count */}
      {isSearchActive && (
        <div className="mb-1 font-mono text-[10px] text-muted-foreground/60">
          {matchedIds.size} match{matchedIds.size !== 1 ? "es" : ""}
          {neighborIds.size > 0 && ` + ${neighborIds.size} connected`}
          {debouncedQuery !== searchQuery && " ..."}
        </div>
      )}

      <div className="relative">
        {/* Graph — full width */}
        <div style={{ height: graphHeight }} className="w-full overflow-hidden rounded-sm">
          <ForceGraph3D
            ref={fgRef}
            graphData={fg3dData}
            backgroundColor="rgba(0,0,0,0)"
            width={containerWidth}
            height={graphHeight}
            showNavInfo={false}
            nodeThreeObject={nodeThreeObject}
            nodeLabel={nodeLabel}
            onNodeClick={onNodeClick}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkLabel={linkLabel}
            linkOpacity={0.4}
            linkDirectionalParticles={0}
            enableNodeDrag={true}
            cooldownTicks={120}
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.3}
            onEngineTick={onEngineTick}
          />
        </div>

        {/* Navigation hint */}
        <div className="absolute bottom-2 left-2 rounded bg-background/70 px-2 py-1 backdrop-blur-sm">
          <span className="font-mono text-[9px] text-muted-foreground/40">
            drag to rotate / scroll to zoom / click node to open
          </span>
        </div>

        {/* Stats — bottom right */}
        <div className="absolute bottom-2 right-2 rounded bg-background/70 px-2 py-1 backdrop-blur-sm">
          <span className="font-mono text-[9px] text-muted-foreground/40">
            {fg3dData.nodes.length} nodes / {fg3dData.links.length} edges
          </span>
        </div>

        {/* Overlay sidebar: legend + agents + search results — top right */}
        <div className="absolute right-2 top-2 flex w-[220px] flex-col gap-2">
          {/* Type legend */}
          <div className="rounded border border-gold-dim/10 bg-background/80 px-3 py-2.5 backdrop-blur-md">
            <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              Types
            </div>
            <div className="flex flex-col gap-0.5">
              {presentTypes.map(([type, color]) => (
                <button
                  key={type}
                  onClick={() => {
                    setSearchQuery(type);
                    setShowResults(true);
                  }}
                  className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/5"
                >
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    {type}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Agent activity */}
          {activeAgents.size > 0 && (
            <div className="rounded border border-gold-dim/10 bg-background/80 px-3 py-2.5 backdrop-blur-md">
              <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                Active Agents
              </div>
              <div className="flex flex-col gap-1">
                {AGENT_CONFIG.filter((a) => activeAgents.has(a.key)).map((a) => (
                  <div key={a.key} className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{
                        backgroundColor: a.color,
                        boxShadow: `0 0 6px ${a.color}`,
                        animation: "pulse 2s ease-in-out infinite",
                      }}
                    />
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                      {a.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Search results */}
          {showResults && searchResults.length > 0 && (
            <div className="rounded border border-gold-dim/10 bg-background/80 px-3 py-2.5 backdrop-blur-md">
              <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                Results
              </div>
              <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
                {searchResults.map((r) => (
                  <Link
                    key={r.id}
                    to={`/vault?slug=${encodeURIComponent(r.id.replace(/\.md$/, ""))}`}
                    className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5"
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: VAULT_TYPE_COLORS[r.type] || "#8A8680" }}
                    />
                    <span className="truncate font-mono text-[11px] text-cream/80">
                      {r.name}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CSS animation for agent pulse */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
