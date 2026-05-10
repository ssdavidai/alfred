import { useAuth } from "wasp/client/auth";
import { Navigate } from "react-router-dom";
import {
  getDailyStats,
  getAdminSettings,
  updateAdminSetting,
  useQuery,
} from "wasp/client/operations";
import { cn } from "../../../client/utils";
import { Switch } from "../../../client/components/ui/switch";
import { Label } from "../../../client/components/ui/label";
import {
  Card,
  CardContent,
} from "../../../client/components/ui/card";
import DashboardLayout from "../../../dashboard/DashboardLayout";
import RevenueAndProfitChart from "./RevenueAndProfitChart";
import SourcesTable from "./SourcesTable";
import TotalPageViewsCard from "./TotalPageViewsCard";
import TotalPayingUsersCard from "./TotalPayingUsersCard";
import TotalRevenueCard from "./TotalRevenueCard";
import TotalSignupsCard from "./TotalSignupsCard";

const Dashboard = () => {
  const { data: user } = useAuth();
  const { data: stats, isLoading, error } = useQuery(getDailyStats);
  const { data: adminSettings } = useQuery(getAdminSettings);

  const isClosedBeta = adminSettings?.closed_beta === "true";

  const handleBetaToggle = async (checked: boolean) => {
    try {
      await updateAdminSetting({
        key: "closed_beta",
        value: checked ? "true" : "false",
      });
    } catch (err) {
      console.error("Failed to update beta gate:", err);
    }
  };

  if (!user) return null;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  // M7 #869 — admin tokens pass. Paper surface, Playfair headings, brass
  // accents on key states. No IA / logic changes; the existing Card / Switch
  // primitives have already been re-skinned in M0 (#845).
  return (
    <DashboardLayout>
      {error ? (
        <div className="flex h-full items-center justify-center paper">
          <div className="border border-rule p-8">
            <p className="font-display text-2xl" style={{ color: "var(--brass)" }}>
              Error
            </p>
            <p
              className="font-body italic mt-2 text-sm"
              style={{ color: "var(--marginalia)" }}
            >
              {error.message || "Something went wrong while fetching stats."}
            </p>
          </div>
        </div>
      ) : (
        <div className="relative paper">
          <div
            className={cn({
              "opacity-25": !stats,
            })}
          >
            <div className="mb-6">
              <Card>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn("h-2 w-2 rounded-full")}
                      style={{
                        background: isClosedBeta
                          ? "var(--brass)"
                          : "color-mix(in oklab, var(--brass) 60%, var(--ink))",
                      }}
                    />
                    <Label
                      className="font-mono text-xs font-light uppercase tracking-[0.35em]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Closed Beta Gate
                    </Label>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className="font-mono text-[0.62rem] font-light uppercase tracking-[0.35em]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {isClosedBeta ? "ON" : "OFF"}
                    </span>
                    <Switch
                      checked={isClosedBeta}
                      onCheckedChange={handleBetaToggle}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="2xl:gap-7.5 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-4">
              <TotalPageViewsCard
                totalPageViews={stats?.dailyStats?.totalViews}
                prevDayViewsChangePercent={
                  stats?.dailyStats?.prevDayViewsChangePercent
                }
              />
              <TotalRevenueCard
                dailyStats={stats?.dailyStats}
                weeklyStats={stats?.weeklyStats}
                isLoading={isLoading}
              />
              <TotalPayingUsersCard
                dailyStats={stats?.dailyStats}
                isLoading={isLoading}
              />
              <TotalSignupsCard
                dailyStats={stats?.dailyStats}
                isLoading={isLoading}
              />
            </div>

            <div className="2xl:mt-7.5 2xl:gap-7.5 mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6">
              <RevenueAndProfitChart
                weeklyStats={stats?.weeklyStats}
                isLoading={isLoading}
              />

              <div className="col-span-12 xl:col-span-8">
                <SourcesTable sources={stats?.dailyStats?.sources} />
              </div>
            </div>
          </div>

          {!stats && !isLoading && (
            <div
              className="absolute inset-0 flex items-start justify-center"
              style={{ background: "color-mix(in oklab, var(--paper) 50%, transparent)" }}
            >
              <div className="border border-rule p-8 paper">
                <p className="font-display text-2xl">No analytics data yet.</p>
                <p
                  className="font-body italic mt-2 max-w-md text-sm"
                  style={{ color: "var(--marginalia)" }}
                >
                  Plausible tracking has been enabled. Data will appear here
                  once the hourly stats job has collected page views from your
                  Plausible instance.
                </p>
              </div>
            </div>
          )}

          {isLoading && !stats && (
            <div
              className="absolute inset-0 flex items-start justify-center"
              style={{ background: "color-mix(in oklab, var(--paper) 50%, transparent)" }}
            >
              <div className="border border-rule p-8 paper">
                <p className="font-display italic text-2xl">Composing…</p>
              </div>
            </div>
          )}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Dashboard;
