import { useState, useEffect, useCallback } from "react";
import { useQuery, getFirstBrief } from "wasp/client/operations";
import { Card, CardContent } from "../../client/components/ui/card";
import { Loader2, FileText, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * Render markdown-lite text: paragraphs, **bold**, *italic*.
 * No heavy deps — just split on double newlines and handle inline formatting.
 */
function renderBriefText(text: string) {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((p, i) => {
    // Handle bold and italic
    const formatted = p
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // Preserve single newlines as <br>
      .replace(/\n/g, "<br />");
    return (
      <p
        key={i}
        className="font-sans text-sm font-light leading-relaxed text-cream/80"
        dangerouslySetInnerHTML={{ __html: formatted }}
      />
    );
  });
}

interface FirstBriefProps {
  /** If true, poll more frequently (used on onboarding completion page) */
  polling?: boolean;
  /** Callback when brief becomes available */
  onBriefReady?: () => void;
}

export default function FirstBrief({ polling = false, onBriefReady }: FirstBriefProps) {
  const { data, isLoading, error } = useQuery(getFirstBrief, undefined, {
    refetchInterval: polling ? 5_000 : 60_000,
  });

  const brief = data?.brief ?? null;
  const briefPath = data?.path ?? null;

  // Notify parent when brief arrives
  useEffect(() => {
    if (brief && onBriefReady) {
      onBriefReady();
    }
  }, [brief, onBriefReady]);

  // Generating state — no brief yet, but we're polling
  const isGenerating = polling && !brief && !error;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <FileText className="h-4 w-4 text-gold" />
          <span className="font-serif text-base font-light text-cream">
            Your First Brief
          </span>
        </div>

        {isLoading && !data && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <p className="font-mono text-xs text-muted-foreground/50">
              Loading...
            </p>
          </div>
        )}

        {isGenerating && !isLoading && (
          <div className="py-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="relative flex h-5 w-5 items-center justify-center">
                <div className="absolute h-5 w-5 animate-ping rounded-full bg-gold/20" />
                <div className="h-2.5 w-2.5 rounded-full bg-gold/60" />
              </div>
              <p className="font-sans text-sm font-light text-cream/70">
                Alfred is reading your emails and preparing your personalized brief...
              </p>
            </div>
            <p className="ml-8 font-mono text-[0.6rem] text-muted-foreground/50">
              This usually takes about 2 minutes.
            </p>
          </div>
        )}

        {!isLoading && !isGenerating && !brief && (
          <p className="py-2 font-mono text-xs text-muted-foreground/50">
            No brief yet. Complete onboarding to generate your first personalized brief.
          </p>
        )}

        {brief && (
          <div className="space-y-2">
            <div className="space-y-3">{renderBriefText(brief)}</div>
            {briefPath && (
              <div className="flex items-center justify-end pt-2">
                <Link
                  to={`/dashboard/vault/${encodeURIComponent(briefPath)}`}
                  className="flex items-center gap-1.5 font-mono text-[0.6rem] text-gold/70 transition-colors hover:text-gold"
                >
                  View Full Brief
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
