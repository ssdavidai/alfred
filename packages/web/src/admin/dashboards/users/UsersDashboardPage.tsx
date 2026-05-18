import { type AuthUser } from "wasp/auth";
import { Navigate } from "react-router-dom";
import DashboardLayout from "../../../dashboard/DashboardLayout";
import UsersTable from "./UsersTable";

const Users = ({ user }: { user: AuthUser }) => {
  if (!user.isAdmin) return <Navigate to="/" replace />;

  // M7 #869 — admin tokens pass.
  return (
    <DashboardLayout>
      <div className="paper">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
          style={{ color: "var(--brass)" }}
        >
          Admin
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-8">Users.</h1>
        <div className="flex flex-col gap-10">
          <UsersTable />
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Users;
