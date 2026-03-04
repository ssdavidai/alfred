import { useState } from "react";
import {
  useQuery,
  getInboxItems,
  submitInboxItem,
} from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
import { Button } from "../client/components/ui/button";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Input } from "../client/components/ui/input";
import { Textarea } from "../client/components/ui/textarea";
import { Plus, FileText } from "lucide-react";

export default function InboxPage() {
  const { data: items, isLoading, error, refetch } = useQuery(getInboxItems);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    try {
      await submitInboxItem({ title: title.trim(), content: content.trim() });
      setTitle("");
      setContent("");
      setShowForm(false);
      refetch();
    } catch (err) {
      console.error("Failed to submit:", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-2xl font-light text-cream">Inbox</h1>
        <Button onClick={() => setShowForm(!showForm)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          New Item
        </Button>
      </div>

      {showForm && (
        <Card className="mb-6">
          <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                placeholder="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
              <Textarea
                placeholder="Content (paste text, links, notes...)"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={6}
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Submitting..." : "Submit to Inbox"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowForm(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <p className="text-muted-foreground">Loading inbox...</p>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {items && (
        <div className="space-y-3">
          {(items.files || []).filter((f: string) => f !== "processed").length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <FileText className="text-muted-foreground mx-auto mb-3 h-12 w-12" />
                <p className="text-muted-foreground">
                  Your inbox is empty. Add items to be processed by the Inbox
                  Processor.
                </p>
              </CardContent>
            </Card>
          ) : (
            (items.files || [])
              .filter((f: string) => f !== "processed")
              .map((filename: string, i: number) => (
              <Card key={filename || i}>
                <CardContent className="p-4">
                  <CardTitle className="text-cream text-base">
                    {filename.replace(/\.md$/, "").replace(/[-_]/g, " ")}
                  </CardTitle>
                  <span className="text-muted-foreground mt-1 inline-block text-xs">
                    {filename}
                  </span>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
