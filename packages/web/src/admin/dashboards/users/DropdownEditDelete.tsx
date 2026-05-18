import { Ellipsis, Plus, SquarePen, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  adminCreateInstance,
  adminUpdateUser,
  deleteUserById,
} from "wasp/client/operations";
import { Button } from "../../../client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../client/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../client/components/ui/dropdown-menu";
import { Input } from "../../../client/components/ui/input";
import { Label } from "../../../client/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../client/components/ui/select";

interface UserData {
  id: string;
  email: string | null;
  username: string | null;
  subscriptionPlan: string | null;
  subscriptionStatus: string | null;
  instance: { id: string; status: string } | null;
}

interface DropdownEditDeleteProps {
  user: UserData;
  isCurrentUser: boolean;
}

const DropdownEditDelete = ({
  user,
  isCurrentUser,
}: DropdownEditDeleteProps) => {
  const [editOpen, setEditOpen] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button>
            <Ellipsis className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <SquarePen className="mr-2 size-4" />
            Edit
          </DropdownMenuItem>
          {!user.instance && (
            <DropdownMenuItem onClick={() => setProvisionOpen(true)}>
              <Plus className="mr-2 size-4" />
              Provision
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => setDeleteOpen(true)}
            disabled={isCurrentUser}
            className={isCurrentUser ? "opacity-50" : ""}
          >
            <Trash2 className="mr-2 size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditUserDialog
        user={user}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <ProvisionDialog
        userId={user.id}
        open={provisionOpen}
        onOpenChange={setProvisionOpen}
      />
      <DeleteUserDialog
        userId={user.id}
        userEmail={user.email}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
};

// ============================================================
// Edit User Dialog
// ============================================================

function EditUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: UserData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState(user.email ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [plan, setPlan] = useState(user.subscriptionPlan ?? "");
  const [status, setStatus] = useState(user.subscriptionStatus ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens
  const handleOpenChange = (v: boolean) => {
    if (v) {
      setEmail(user.email ?? "");
      setUsername(user.username ?? "");
      setPlan(user.subscriptionPlan ?? "");
      setStatus(user.subscriptionStatus ?? "");
      setError(null);
    }
    onOpenChange(v);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await adminUpdateUser({
        id: user.id,
        ...(email !== (user.email ?? "") && { email }),
        ...(username !== (user.username ?? "") && { username }),
        ...(plan !== (user.subscriptionPlan ?? "") && {
          subscriptionPlan: plan || null,
        }),
        ...(status !== (user.subscriptionStatus ?? "") && {
          subscriptionStatus: status || null,
        }),
      });
      onOpenChange(false);
    } catch (err: any) {
      setError(err.message || "Failed to update user");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>
            Update user details for {user.email || user.id}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="edit-email">Email</Label>
            <Input
              id="edit-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-username">Username</Label>
            <Input
              id="edit-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>Subscription Plan</Label>
            <Select value={plan} onValueChange={setPlan}>
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                <SelectItem value="premium">Premium</SelectItem>
                <SelectItem value="black">Black</SelectItem>
                <SelectItem value="starter">Starter (grandfathered)</SelectItem>
                <SelectItem value="pro">Pro (grandfathered)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Subscription Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="past_due">Past Due</SelectItem>
                <SelectItem value="cancel_at_period_end">
                  Cancel at Period End
                </SelectItem>
                <SelectItem value="deleted">Deleted</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Provision Instance Dialog
// ============================================================

const TIER_OPTIONS = [
  { value: "premium", label: "Premium", serverType: "cx53" },
  { value: "black", label: "Black", serverType: "cx53" },
];

function ProvisionDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tier, setTier] = useState("premium");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedOption = TIER_OPTIONS.find((t) => t.value === tier);

  const handleProvision = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await adminCreateInstance({ userId, tier });
      onOpenChange(false);
    } catch (err: any) {
      setError(err.message || "Failed to create instance");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Provision Instance</DialogTitle>
          <DialogDescription>
            Create a new Alfred instance for this user.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label>Tier</Label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedOption && (
              <p className="text-muted-foreground text-xs">
                Server type: {selectedOption.serverType}
              </p>
            )}
          </div>

          {error && (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleProvision} disabled={submitting}>
            {submitting ? "Provisioning..." : "Provision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Delete User Dialog
// ============================================================

function DeleteUserDialog({
  userId,
  userEmail,
  open,
  onOpenChange,
}: {
  userId: string;
  userEmail: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expectedText = userEmail || userId;
  const isMatch = confirmText === expectedText;

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setConfirmText("");
      setError(null);
    }
    onOpenChange(v);
  };

  const handleDelete = async () => {
    if (!isMatch) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteUserById({ id: userId });
      onOpenChange(false);
    } catch (err: any) {
      setError(err.message || "Failed to delete user");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete User</DialogTitle>
          <DialogDescription>
            This will permanently delete the user and all their data (instance,
            API keys, provisioning jobs). This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <p className="text-sm">
            Type{" "}
            <span className="font-mono font-bold">{expectedText}</span>{" "}
            to confirm:
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={expectedText}
          />

          {error && (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!isMatch || deleting}
          >
            {deleting ? "Deleting..." : "Delete User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DropdownEditDelete;
