import { ApexOptions } from "apexcharts";
import ReactApexChart from "react-apexcharts";
import { VAULT_TYPE_COLORS } from "../constants";

interface VaultCompositionChartProps {
  types: Record<string, number>;
}

export default function VaultCompositionChart({ types }: VaultCompositionChartProps) {
  const entries = Object.entries(types).filter(([, count]) => count > 0);
  const labels = entries.map(([type]) => type);
  const series = entries.map(([, count]) => count);
  const colors = labels.map((type) => VAULT_TYPE_COLORS[type] || "#8A8680");

  const options: ApexOptions = {
    chart: {
      type: "donut",
      fontFamily: "'JetBrains Mono', monospace",
      background: "transparent",
    },
    labels,
    colors,
    legend: {
      show: true,
      position: "bottom",
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: "10px",
      labels: { colors: "#8A8680" },
      markers: { width: 8, height: 8 },
    },
    dataLabels: { enabled: false },
    stroke: { show: false },
    plotOptions: {
      pie: {
        donut: {
          size: "60%",
          labels: {
            show: true,
            total: {
              show: true,
              label: "Total",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              color: "#8A8680",
              formatter: (w) => {
                return w.globals.seriesTotals
                  .reduce((a: number, b: number) => a + b, 0)
                  .toString();
              },
            },
            value: {
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: "20px",
              color: "#E8E4DE",
            },
          },
        },
      },
    },
    tooltip: {
      theme: "dark",
      style: { fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" },
    },
    states: {
      hover: { filter: { type: "lighten", value: 0.15 } },
      active: { filter: { type: "none" } },
    },
  };

  return (
    <ReactApexChart
      options={options}
      series={series}
      type="donut"
      height={300}
    />
  );
}
