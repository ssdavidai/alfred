import { type AuthUser } from "wasp/auth";
import { Navigate } from "react-router-dom";
import DashboardLayout from "../../../dashboard/DashboardLayout";
import UsersTable from "./UsersTable";

const Users = ({ user }: { user: AuthUser }) => {
  if (!user.isAdmin) return <Navigate to="/" replace />;

  return (
    <DashboardLayout>
      <h1 className="mb-6 font-serif text-2xl font-light text-cream">Users</h1>
      <div className="flex flex-col gap-10">
        <UsersTable />
      </div>
    </DashboardLayout>
  );
};

export default Users;
