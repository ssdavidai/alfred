import { useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../client/components/ui/dialog";
import { Button } from "../../client/components/ui/button";
import { Upload, CheckCircle, AlertCircle } from "lucide-react";
import { submitInboxItem } from "wasp/client/operations";

interface FileUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: () => void;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Best-effort text file detection by MIME type or extension. */
function isLikelyText(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (
    file.type === "application/json" ||
    file.type === "application/xml" ||
    file.type === "application/javascript" ||
    file.type === "application/x-yaml" ||
    file.type === "application/x-sh"
  ) return true;
  const ext = file.name.includes(".")
    ? "." + file.name.split(".").pop()!.toLowerCase()
    : "";
  return [
    ".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".tsv",
    ".html", ".htm", ".css", ".js", ".ts", ".jsx", ".tsx", ".py", ".sh",
    ".log", ".env", ".ini", ".toml", ".cfg", ".conf", ".rst", ".org",
    ".sql", ".graphql", ".go", ".rs", ".rb", ".java", ".kt", ".swift",
    ".c", ".cpp", ".h", ".hpp", ".r", ".m", ".tex", ".bib",
  ].includes(ext);
}

interface UploadResult {
  name: string;
  ok: boolean;
  error?: string;
}

export default function FileUploadDialog({ open, onOpenChange, onUploaded }: FileUploadDialogProps) {
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    setUploading(true);
    setResults([]);
    const outcomes: UploadResult[] = [];

    for (const file of fileArr) {
      try {
        if (isLikelyText(file)) {
          const text = await file.text();
          await submitInboxItem({
            title: file.name,
            content: text,
            filename: file.name,
          });
        } else {
          const buffer = await file.arrayBuffer();
          await submitInboxItem({
            title: file.name,
            content: arrayBufferToBase64(buffer),
            filename: file.name,
            encoding: "base64",
          });
        }

        outcomes.push({ name: file.name, ok: true });
      } catch (err: any) {
        outcomes.push({
          name: file.name,
          ok: false,
          error: err?.message || "Upload failed",
        });
      }
      setResults([...outcomes]);
    }

    setUploading(false);
    if (outcomes.some((o) => o.ok)) onUploaded?.();
  }, [onUploaded]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        processFiles(e.target.files);
      }
    },
    [processFiles],
  );

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleClose = (v: boolean) => {
    if (!uploading) {
      setResults([]);
      onOpenChange(v);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="border-gold-dim/40 bg-[#0A0A0A]">
        <DialogHeader>
          <DialogTitle className="font-serif font-light text-cream">
            Upload to Inbox
          </DialogTitle>
          <DialogDescription>
            Drop any files to send them to your inbox for processing.
          </DialogDescription>
        </DialogHeader>

        {/* Hidden file input — kept outside the drop zone to avoid click event bubbling */}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={handleFileInput}
        />

        <div
          role="button"
          tabIndex={0}
          onClick={openFilePicker}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFilePicker();
            }
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-sm border-2 border-dashed transition-colors ${
            dragOver
              ? "border-gold bg-gold/5"
              : "border-gold-dim/40 hover:border-gold-dim"
          }`}
        >
          <Upload className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="font-mono text-xs text-muted-foreground">
            {uploading ? "Uploading..." : "Click or drag files here"}
          </p>
          <p className="mt-1 font-mono text-[0.6rem] text-muted-foreground/60">
            Any file type — PDFs, images, text, documents, etc.
          </p>
        </div>

        {results.length > 0 && (
          <div className="mt-2 space-y-1">
            {results.map((r) => (
              <div
                key={r.name}
                className="flex items-center gap-2 font-mono text-xs"
              >
                {r.ok ? (
                  <CheckCircle className="h-3 w-3 flex-shrink-0 text-green-500" />
                ) : (
                  <AlertCircle className="h-3 w-3 flex-shrink-0 text-red-500" />
                )}
                <span className="text-muted-foreground">
                  {r.name}
                  {r.error && (
                    <span className="ml-1 text-red-400">— {r.error}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {results.length > 0 && !uploading && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => handleClose(false)}
          >
            Done
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
