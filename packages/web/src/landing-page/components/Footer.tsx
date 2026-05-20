export default function Footer() {
  return (
    <footer className="bg-[#0A0A0A] border-t border-[#1A1A1A] px-6 py-10">
      <div className="mx-auto max-w-[680px] text-center">
        <img
          src="/images/alfred-logo.png"
          alt="ALFRED BLACK"
          className="mx-auto h-8 w-auto"
        />
        <p className="mt-3 font-sans text-sm font-light text-[#8A8680]">
          Built by{" "}
          <a
            href="https://example.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-[#C4A265] transition-colors"
          >
            Example Co
          </a>
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-5 text-xs text-[#5A5650]">
          <a href="/tos" className="hover:text-[#8A8680] transition-colors">Terms of Service</a>
          <a href="/pp" className="hover:text-[#8A8680] transition-colors">Privacy Policy</a>
          <a href="/docs" className="hover:text-[#8A8680] transition-colors">Documentation</a>
          <a href="mailto:help@alfred.black" className="hover:text-[#8A8680] transition-colors">Support</a>
        </div>
        <p className="mt-4 text-xs text-[#3A3630]">© 2026 Example LLC. All rights reserved.</p>
      </div>
    </footer>
  );
}