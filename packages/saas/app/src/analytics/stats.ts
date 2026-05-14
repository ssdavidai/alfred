import { type DailyStats } from "wasp/entities";
import { type DailyStatsJob } from "wasp/server/jobs";
import { OrderStatus } from "@polar-sh/sdk/models/components/orderstatus.js";
import {
  getDailyPageViews,
  getSources,
} from "./providers/plausibleAnalyticsUtils";
import { SubscriptionStatus } from "../payment/plans";
import { polarClient } from "../payment/polar/polarClient";

export type DailyStatsProps = {
  dailyStats?: DailyStats;
  weeklyStats?: DailyStats[];
  isLoading?: boolean;
};

export const calculateDailyStats: DailyStatsJob<never, void> = async (
  _args,
  context,
) => {
  if (process.env.WASP_DISABLE_JOBS === 'true') {
    console.log('[WASP_DISABLE_JOBS] skipping calculateDailyStats');
    return;
  }
  const nowUTC = new Date(Date.now());
  nowUTC.setUTCHours(0, 0, 0, 0);

  const yesterdayUTC = new Date(nowUTC);
  yesterdayUTC.setUTCDate(yesterdayUTC.getUTCDate() - 1);

  try {
    const yesterdaysStats = await context.entities.DailyStats.findFirst({
      where: {
        date: {
          equals: yesterdayUTC,
        },
      },
    });

    const userCount = await context.entities.User.count({});
    const paidUserCount = await context.entities.User.count({
      where: {
        subscriptionStatus: SubscriptionStatus.Active,
      },
    });

    let userDelta = userCount;
    let paidUserDelta = paidUserCount;
    if (yesterdaysStats) {
      userDelta -= yesterdaysStats.userCount;
      paidUserDelta -= yesterdaysStats.paidUserCount;
    }

    const totalRevenue = await fetchTotalPolarRevenue();

    // Fetch page views from Plausible (gracefully handles missing config)
    let totalViews = 0;
    let prevDayViewsChangePercent = "0";
    try {
      const pageViews = await getDailyPageViews();
      totalViews = pageViews.totalViews;
      prevDayViewsChangePercent = pageViews.prevDayViewsChangePercent;
    } catch (error: any) {
      console.warn(
        `Plausible analytics unavailable: ${error?.message}. Recording stats without page views.`,
      );
    }

    let dailyStats = await context.entities.DailyStats.findUnique({
      where: {
        date: nowUTC,
      },
    });

    if (!dailyStats) {
      dailyStats = await context.entities.DailyStats.create({
        data: {
          date: nowUTC,
          totalViews,
          prevDayViewsChangePercent,
          userCount,
          paidUserCount,
          userDelta,
          paidUserDelta,
          totalRevenue,
        },
      });
    } else {
      dailyStats = await context.entities.DailyStats.update({
        where: {
          id: dailyStats.id,
        },
        data: {
          totalViews,
          prevDayViewsChangePercent,
          userCount,
          paidUserCount,
          userDelta,
          paidUserDelta,
          totalRevenue,
        },
      });
    }

    // Fetch traffic sources from Plausible
    try {
      const sources = await getSources();
      for (const source of sources) {
        let visitors = source.visitors;
        if (typeof source.visitors !== "number") {
          visitors = parseInt(source.visitors);
        }
        await context.entities.PageViewSource.upsert({
          where: {
            date_name: {
              date: nowUTC,
              name: source.source,
            },
          },
          create: {
            date: nowUTC,
            name: source.source,
            visitors,
            dailyStatsId: dailyStats.id,
          },
          update: {
            visitors,
          },
        });
      }
    } catch (error: any) {
      console.warn(
        `Plausible sources unavailable: ${error?.message}. Skipping source tracking.`,
      );
    }

    console.table({ dailyStats });
  } catch (error: any) {
    console.error("Error calculating daily stats: ", error);
    await context.entities.Logs.create({
      data: {
        message: `Error calculating daily stats: ${error?.message}`,
        level: "job-error",
      },
    });
  }
};

async function fetchTotalPolarRevenue(): Promise<number> {
  let totalRevenue = 0;

  const result = await polarClient.orders.list({
    limit: 100,
  });

  for await (const page of result) {
    const orders = page.result.items || [];

    for (const order of orders) {
      if (order.status === OrderStatus.Paid && order.totalAmount > 0) {
        totalRevenue += order.totalAmount;
      }
    }
  }

  // Revenue is in cents so we convert to dollars
  return totalRevenue / 100;
}
