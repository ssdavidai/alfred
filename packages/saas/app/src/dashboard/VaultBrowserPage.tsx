import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, getVaultRecords, getInboxItems } from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";

import SpotlightCard from "../components/ui/SpotlightCard";
import { Input } from "../client/components/ui/input";
import { Button } from "../client/components/ui/button";
import {
  Search,
  FileText,
  FolderOpen,
  Folder,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

const VAULT_TYPES = [
  // Standing entities
  "person", "org", "project", "location", "account", "asset", "process", "matter",
  // Activity records
  "conversation", "note", "task", "triage", "event", "session", "input", "run", "ledger_entry",
  // Execution
  "skill",
  // Learning
  "assumption", "decision", "constraint", "contradiction", "synthesis",
  // Intuition
  "observation", "instinct", "reflection",
  // Special folders
  "inbox",
];

/** Normalize the path so it always ends with .md (context strips it, list/search keep it). */
function ensureMdExtension(p: string): string {
  return p.endsWith(".md") ? p : `${p}.md`;
}

type RecordsByType = Record<string, Array<{ path: string; name: string; status?: string }>>;

export default function VaultBrowserPage() {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  // Always fetch the full vault context to populate the folder tree
  const {
    data: contextData,
    isLoading: contextLoading,
    error: contextError,
  } = useQuery(getVaultRecords, {});

  // Fetch inbox item count for the folder tree
  const { data: inboxData } = useQuery(getInboxItems);
  const inboxCount = useMemo(() => {
    if (!inboxData?.files) return 0;
    return (inboxData.files as string[]).filter((f: string) => f !== "processed").length;
  }, [inboxData]);

  // Fetch search results when a search is active
  const {
    data: searchData,
    isLoading: searchLoading,
  } = useQuery(
    getVaultRecords,
    { query: activeQuery || undefined },
    { enabled: !!activeQuery },
  );

  // Fetch records for the selected folder (used for inbox and types not in context)
  const {
    data: folderData,
    isLoading: folderLoading,
  } = useQuery(
    getVaultRecords,
    { type: selectedFolder || undefined },
    { enabled: !!selectedFolder && !activeQuery },
  );

  const isSearching = !!activeQuery;

  // Build the records-by-type map from context data
  const recordsByType: RecordsByType = useMemo(() => {
    if (!contextData) return {};
    if (contextData.records_by_type && typeof contextData.records_by_type === "object") {
      return contextData.records_by_type as RecordsByType;
    }
    return {};
  }, [contextData]);

  // Get the count for each folder type
  const folderCounts: Record<string, number> = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const type of VAULT_TYPES) {
      counts[type] = type === "inbox" ? inboxCount : (recordsByType[type]?.length ?? 0);
    }
    return counts;
  }, [recordsByType, inboxCount]);

  // Total record count
  const totalCount = useMemo(() => {
    return Object.values(folderCounts).reduce((sum, c) => sum + c, 0);
  }, [folderCounts]);

  // Records to display in the right pane
  const displayRecords = useMemo(() => {
    if (isSearching && searchData) {
      if (Array.isArray(searchData.results)) {
        return searchData.results;
      }
      return [];
    }
    if (selectedFolder) {
      // Use context data if available, otherwise use on-demand folder query
      if (recordsByType[selectedFolder]) {
        return recordsByType[selectedFolder].map((r: any) => ({ ...r, type: selectedFolder }));
      }
      if (folderData?.results && Array.isArray(folderData.results)) {
        return folderData.results;
      }
      return [];
    }
    return null;
  }, [isSearching, searchData, selectedFolder, recordsByType, folderData]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSelectedFolder(null);
    setActiveQuery(searchQuery);
  };

  const handleFolderClick = (type: string) => {
    setActiveQuery("");
    setSearchQuery("");
    if (selectedFolder === type) {
      // Toggle collapse if clicking the same folder
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(type)) next.delete(type);
        else next.add(type);
        return next;
      });
    } else {
      setSelectedFolder(type);
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(type);
        return next;
      });
    }
  };

  const handleClearSearch = () => {
    setActiveQuery("");
    setSearchQuery("");
  };

  const isLoading = contextLoading || searchLoading || folderLoading;

  return (
    <DashboardLayout>
      <h1 className="font-serif mb-6 text-2xl font-light text-cream">
        File Explorer
      </h1>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="mb-6 flex gap-2">
        <Input
          placeholder="Search vault records..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" size="sm">
          <Search className="mr-1 h-4 w-4" />
          Search
        </Button>
      </form>

      {contextError && (
        <div className="bg-destructive/10 text-destructive mb-4 rounded-sm p-4">
          <p>{contextError.message}</p>
        </div>
      )}

      {/* Main explorer layout */}
      <SpotlightCard className="[&>div.relative.z-10>div.p-4]:p-0">
          <div className="flex min-h-[480px]">
            {/* Left sidebar: folder tree */}
            <div className="w-56 flex-shrink-0 border-r border-gold-dim/40 overflow-y-auto">
              {/* Folder tree header */}
              <div className="border-b border-gold-dim/20 px-4 py-3">
                <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.25em] text-[#8A8680]">
                  Vault
                </span>
                {!contextLoading && (
                  <span className="ml-2 font-mono text-[0.55rem] text-[#8A8680]">
                    ({totalCount})
                  </span>
                )}
              </div>

              {/* Folder list */}
              <nav className="py-1">
                {VAULT_TYPES.map((type) => {
                  const count = folderCounts[type];
                  const isSelected = selectedFolder === type && !isSearching;
                  const isExpanded = expandedFolders.has(type);

                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleFolderClick(type)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-150 ${
                        isSelected
                          ? "bg-gold/10 text-gold border-l-2 border-gold"
                          : "text-[#8A8680] hover:bg-white/[0.03] hover:text-cream border-l-2 border-transparent"
                      }`}
                    >
                      {/* Chevron */}
                      {isExpanded && isSelected ? (
                        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
                      ) : (
                        <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-50" />
                      )}

                      {/* Folder icon */}
                      {isSelected ? (
                        <FolderOpen className="h-4 w-4 flex-shrink-0 text-gold" />
                      ) : (
                        <Folder className="h-4 w-4 flex-shrink-0" />
                      )}

                      {/* Name and count */}
                      <span className="flex-1 truncate font-mono text-[0.65rem] tracking-wide">
                        {type}
                      </span>
                      {count > 0 && (
                        <span className={`font-mono text-[0.55rem] ${isSelected ? "text-gold/70" : "text-[#8A8680]/60"}`}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Right pane: file list */}
            <div className="flex-1 overflow-y-auto">
              {/* Pane header */}
              <div className="sticky top-0 border-b border-gold-dim/20 bg-card px-4 py-3">
                {isSearching ? (
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.25em] text-[#8A8680]">
                      Search: "{activeQuery}"
                      {searchData && (
                        <span className="ml-2">({searchData.count ?? searchData.results?.length ?? 0} results)</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={handleClearSearch}
                      className="font-mono text-[0.55rem] uppercase tracking-wider text-[#8A8680] hover:text-cream transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                ) : selectedFolder ? (
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-4 w-4 text-gold" />
                    <span className="font-mono text-[0.65rem] font-light uppercase tracking-[0.25em] text-cream">
                      {selectedFolder}/
                    </span>
                    <span className="font-mono text-[0.55rem] text-[#8A8680]">
                      ({folderCounts[selectedFolder]} files)
                    </span>
                  </div>
                ) : (
                  <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.25em] text-[#8A8680]">
                    Select a folder
                  </span>
                )}
              </div>

              {/* Content area */}
              <div className="p-2">
                {isLoading && (
                  <div className="flex items-center justify-center py-16">
                    <p className="font-mono text-[0.65rem] text-[#8A8680]">Loading...</p>
                  </div>
                )}

                {!isLoading && !displayRecords && !isSearching && (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <FolderOpen className="mb-3 h-10 w-10 text-[#8A8680]/40" />
                    <p className="font-mono text-[0.65rem] text-[#8A8680]">
                      Select a folder from the tree to browse records
                    </p>
                  </div>
                )}

                {!isLoading && displayRecords && displayRecords.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <FileText className="mb-3 h-10 w-10 text-[#8A8680]/40" />
                    <p className="font-mono text-[0.65rem] text-[#8A8680]">
                      {isSearching ? "No results found." : "This folder is empty."}
                    </p>
                  </div>
                )}

                {!isLoading && displayRecords && displayRecords.length > 0 && (
                  <div className="space-y-px">
                    {displayRecords.map((record: any, i: number) => {
                      const recordPath = ensureMdExtension(record.path || record.name || "");
                      const encodedPath = recordPath
                        .split("/")
                        .map(encodeURIComponent)
                        .join("/");

                      return (
                        <Link
                          key={record.path || i}
                          to={`/dashboard/vault/${encodedPath}`}
                          className="flex items-center gap-3 rounded-sm px-3 py-2 transition-colors duration-150 hover:bg-white/[0.03] group"
                        >
                          <FileText className="h-4 w-4 flex-shrink-0 text-[#8A8680] group-hover:text-gold transition-colors" />
                          <span className="flex-1 truncate text-sm font-light text-cream">
                            {record.name || "Untitled"}
                          </span>
                          {record.type && isSearching && (
                            <span className="font-mono text-[0.55rem] text-[#8A8680]">
                              {record.type}
                            </span>
                          )}
                          {record.status && (
                            <span className="rounded border border-gold-dim/30 px-2 py-0.5 font-mono text-[0.55rem] text-[#8A8680]">
                              {record.status}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
      </SpotlightCard>
    </DashboardLayout>
  );
}
