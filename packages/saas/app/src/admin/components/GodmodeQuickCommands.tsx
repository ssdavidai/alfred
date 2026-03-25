interface Props {
  onCommand: (cmd: string) => void;
  disabled: boolean;
}

const COMMANDS = [
  {
    group: "Containers",
    items: [
      { label: "Status", cmd: "cd /opt/alfred/compose && docker compose ps" },
      { label: "Restart All", cmd: "cd /opt/alfred/compose && docker compose restart" },
      { label: "Restart Alfred", cmd: "cd /opt/alfred/compose && docker compose restart alfred" },
      { label: "Restart OpenClaw", cmd: "cd /opt/alfred/compose && docker compose restart openclaw" },
      { label: "Restart Ctrl-API", cmd: "cd /opt/alfred/compose && docker compose restart ctrl-api" },
    ],
  },
  {
    group: "Logs",
    items: [
      { label: "Alfred Logs", cmd: "cd /opt/alfred/compose && docker compose logs --tail=50 alfred" },
      { label: "OpenClaw Logs", cmd: "cd /opt/alfred/compose && docker compose logs --tail=50 openclaw" },
      { label: "Ctrl-API Logs", cmd: "cd /opt/alfred/compose && docker compose logs --tail=50 ctrl-api" },
    ],
  },
  {
    group: "System",
    items: [
      { label: "Disk Usage", cmd: "df -h /mnt/encrypted" },
      { label: "Memory", cmd: "free -m" },
      { label: "Tailscale", cmd: "tailscale status" },
      { label: "Fix Permissions", cmd: "chmod -R a+rwX /mnt/encrypted/openclaw /mnt/encrypted/vault" },
    ],
  },
];

export default function GodmodeQuickCommands({ onCommand, disabled }: Props) {
  return (
    <div className="flex flex-wrap gap-4 border-b border-amber-900/30 bg-amber-950/20 px-4 py-3">
      {COMMANDS.map((group) => (
        <div key={group.group} className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-amber-700/60">
            {group.group}
          </span>
          {group.items.map((item) => (
            <button
              key={item.label}
              disabled={disabled}
              onClick={() => onCommand(item.cmd + "\n")}
              className="rounded border border-amber-800/40 bg-amber-950/40 px-2 py-0.5 font-mono text-[11px] text-amber-200/80 transition-colors hover:bg-amber-900/40 hover:text-amber-100 disabled:opacity-30"
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
