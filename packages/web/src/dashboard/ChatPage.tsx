// ChatPage — the dashboard chat surface (#29).
//
// Replaces the legacy "Open OpenClaw" external link that pointed at the
// OpenClaw raw-WebSocket dashboard. Hermes is HTTP/SSE; ChatWidget talks
// to the Wasp server's chat proxy, which forwards to the Hermes runtime.
import { Frame, PageHeading } from "../client/components/ab/Frame";
import ChatWidget from "./ChatWidget";

export default function ChatPage() {
  return (
    <Frame>
      <section className="mx-auto max-w-[900px] px-8 py-12">
        <PageHeading
          kicker="Chat"
          icon="voice"
          title="A word with Alfred."
          lede="The long thread, in the browser — same Alfred, same memory as every other channel."
        />
        <ChatWidget />
      </section>
    </Frame>
  );
}
