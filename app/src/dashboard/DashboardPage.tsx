import { useState } from "react";
import {
  useQuery,
  getDashboardData,
} from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Switch } from "../client/components/ui/switch";
import TopBar from "./components/TopBar";
import DevicesPanel from "./components/DevicesPanel";
import VaultGraph from "./components/VaultGraph";
import VaultCompositionChart from "./components/VaultCompositionChart";
import ActivityFeed from "./components/ActivityFeed";
import WorkerActivityCharts from "./components/WorkerActivityCharts";
import TasksSection from "./components/TasksSection";
import ChoresSection from "./components/ChoresSection";
import RemindersSection from "./components/RemindersSection";
import RulesSection from "./components/RulesSection";
import StreamsSection from "./components/StreamsSection";
import IntuitionSection from "./components/IntuitionSection";

export default function DashboardPage() {
  const [graphVisible, setGraphVisible] = useState(true);
  const [activePanel, setActivePanel] = useState<string | null>(null);

  // Always poll stats at 30s
  const { data, isLoading, error } = useQuery(getDashboardData, undefined, {
    refetchInterval: 30_000,
  });

  // Containers from dashboard data
  const containers: any[] = data?.containers ?? [];

  return (
    <DashboardLayout>
      {/* Header row */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-2xl font-light text-cream">
          Command Center
        </h1>
      </div>

      {isLoading && (
        <p className="font-sans text-sm font-light text-muted-foreground">
          Loading dashboard...
        </p>
      )}

      {error && (
        <div className="rounded-sm border border-destructive/30 bg-destructive/10 p-4 text-destructive">
          <p className="font-sans text-sm font-light">{error.message}</p>
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* TopBar — replaces StatCards */}
          <TopBar
            data={data}
            containers={containers}
            activePanel={activePanel}
            onPanelToggle={setActivePanel}
          />

          {/* Devices panel — expandable below TopBar */}
          {activePanel === "devices" && <DevicesPanel />}

          {/* Worker Activity Charts */}
          <WorkerActivityCharts />

          {/* Knowledge Graph — full width */}
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-serif text-base font-light text-cream">Knowledge Graph</span>
                <label className="flex cursor-pointer items-center gap-2">
                  <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.2em] text-muted-foreground">
                    Graph
                  </span>
                  <Switch checked={graphVisible} onCheckedChange={setGraphVisible} />
                </label>
              </div>
              {graphVisible ? <VaultGraph /> : null}
            </CardContent>
          </Card>

          {/* Activity Feed — full width */}
          <ActivityFeed />

          {/* Coming Soon sections — 2-column grid */}
          <div className="grid gap-6 lg:grid-cols-2">
            <TasksSection />
            <ChoresSection />
            <RemindersSection />
            <RulesSection />
          </div>
          <StreamsSection />
          <IntuitionSection />

          {/* Vault Composition (standalone at bottom) */}
          {data.vault?.types &&
            Object.keys(data.vault.types).length > 0 && (
              <Card className="h-full">
                <CardContent className="p-6">
                  <CardTitle className="mb-4 font-serif text-base font-light text-cream">
                    Vault Composition
                  </CardTitle>
                  <VaultCompositionChart types={data.vault.types} />
                </CardContent>
              </Card>
            )}
        </div>
      )}
    </DashboardLayout>
  );
}
