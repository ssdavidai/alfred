// Inline SVG icons from src/client/assets/icons. Uses currentColor so the icon
// inherits text color. Stroke-based, monoline — meant to read as a small
// engraved mark, not as decoration.
import approval from "../../assets/icons/approval.svg?raw";
import bow_tie from "../../assets/icons/bow_tie.svg?raw";
import calendar from "../../assets/icons/calendar.svg?raw";
import calling_card from "../../assets/icons/calling_card.svg?raw";
import envelope from "../../assets/icons/envelope.svg?raw";
import globe from "../../assets/icons/globe.svg?raw";
import lock from "../../assets/icons/lock.svg?raw";
import matter from "../../assets/icons/matter.svg?raw";
import monocle from "../../assets/icons/monocle.svg?raw";
import pocket_watch from "../../assets/icons/pocket_watch.svg?raw";
import settings from "../../assets/icons/settings.svg?raw";
import shield from "../../assets/icons/shield.svg?raw";
import skeleton_key from "../../assets/icons/skeleton_key.svg?raw";
import terminal from "../../assets/icons/terminal.svg?raw";
import top_hat from "../../assets/icons/top_hat.svg?raw";
import user from "../../assets/icons/user.svg?raw";
import voice from "../../assets/icons/voice.svg?raw";

const REGISTRY = {
  approval, bow_tie, calendar, calling_card, envelope, globe, lock, matter,
  monocle, pocket_watch, settings, shield, skeleton_key, terminal, top_hat,
  user, voice,
} as const;

export type IconName = keyof typeof REGISTRY;

export function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const raw = REGISTRY[name];
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ display: "inline-block", width: size, height: size, lineHeight: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: raw.replace("<svg ", `<svg width="${size}" height="${size}" `) }}
    />
  );
}
