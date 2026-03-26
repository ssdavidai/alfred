import { useState, useEffect, useCallback } from "react";
import {
  useQuery,
  getWorkspaceFile,
  updateWorkspaceFile,
} from "wasp/client/operations";
import { Navigate } from "react-router-dom";
import { Button } from "../client/components/ui/button";
import { cn } from "../client/utils";
import { useToast } from "../client/hooks/use-toast";
import {
  Loader2,
  Save,
  AlertTriangle,
  FileText,
  User,
  Brain,
  Shield,
  Wrench,
} from "lucide-react";

interface WorkspaceFile {
  id: string;
  filename: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  warning?: string;
}

const WORKSPACE_FILES: WorkspaceFile[] = [
  {
    id: "soul",
    filename: "SOUL.md",
    label: "Soul",
    description: "Alfred's personality and service philosophy",
    icon: FileText,
    warning: "Editing this file affects Alfred's core behavior",
  },
  {
    id: "user",
    filename: "USER.md",
    label: "User",
    description: "Personal context — family, work, preferences",
    icon: User,
  },
  {
    id: "memory",
    filename: "MEMORY.md",
    label: "Memory",
    description: "Running facts Alfred has learned about you",
    icon: Brain,
  },
  {
    id: "agents",
    filename: "AGENTS.md",
    label: "Agents",
    description: "Behavioral rules and mandatory protocols",
    icon: Shield,
    warning: "Editing this file affects Alfred's core behavior",
  },
  {
    id: "tools",
    filename: "TOOLS.md",
    label: "Tools",
    description: "Integrations, credentials, tool-specific notes",
    icon: Wrench,
  },
];

/** Inner content — used by the unified Settings page */
export function WorkspaceContent() {
  const [activeFile, setActiveFile] = useState<WorkspaceFile>(WORKSPACE_FILES[0]);

  return (
    <>
      <h1 className="font-serif mb-2 text-2xl font-light text-cream">
        Workspace
      </h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Edit the files that define how Alfred thinks and behaves.
      </p>

      {/* File tabs */}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-gold-dim/40 pb-px">
        {WORKSPACE_FILES.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => setActiveFile(file)}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors",
              activeFile.id === file.id
                ? "border-b-2 border-gold text-gold"
                : "text-[#8A8680] hover:text-[#E8E4DE]",
            )}
          >
            <file.icon className="h-3.5 w-3.5" />
            {file.label}
          </button>
        ))}
      </div>

      {/* Active file editor */}
      <FileEditor key={activeFile.id} file={activeFile} />
    </>
  );
}

export default function WorkspacePage() {
  return <Navigate to="/dashboard/settings?tab=workspace" replace />;
}

function FileEditor({ file }: { file: WorkspaceFile }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery(getWorkspaceFile, {
    filename: file.filename,
  });
  const [content, setContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync fetched content into editor state
  useEffect(() => {
    if (data?.content != null) {
      setContent(data.content);
      setHasChanges(false);
    }
  }, [data?.content]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value);
      setHasChanges(e.target.value !== (data?.content ?? ""));
    },
    [data?.content],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateWorkspaceFile({
        filename: file.filename,
        content,
      });
      setHasChanges(false);
      toast({
        title: `${file.filename} saved`,
        description: "Changes are now live on your Alfred instance.",
      });
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to save",
        description: e.message || "Something went wrong",
      });
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcut: Ctrl/Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (hasChanges && !saving) {
          handleSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-12">
        <Loader2 className="h-5 w-5 animate-spin text-gold" />
        <span className="text-muted-foreground text-sm">
          Loading {file.filename}...
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-sm border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
        Failed to load {file.filename}: {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* File description & warning */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">{file.description}</p>
          {file.warning && (
            <div className="mt-2 flex items-center gap-2 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {file.warning}
            </div>
          )}
        </div>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          size="sm"
        >
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-3.5 w-3.5" />
          )}
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {/* Editor */}
      <textarea
        value={content}
        onChange={handleChange}
        spellCheck={false}
        className={cn(
          "w-full rounded-sm border bg-[#111] px-4 py-3 font-mono text-sm leading-relaxed text-[#E8E4DE] placeholder:text-[#8A8680]",
          "focus:outline-none focus:ring-1 focus:ring-gold/50",
          "min-h-[480px] resize-y",
          hasChanges
            ? "border-gold/50"
            : "border-gold-dim/40",
        )}
        placeholder={`${file.filename} is empty. Start writing...`}
      />

      {/* Status bar */}
      <div className="flex items-center justify-between text-xs text-[#8A8680]">
        <span className="font-mono">{file.filename}</span>
        <span>
          {hasChanges ? (
            <span className="text-gold">Unsaved changes</span>
          ) : (
            "No changes"
          )}
        </span>
      </div>
    </div>
  );
}
