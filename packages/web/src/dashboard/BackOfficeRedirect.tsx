// /back-office → /settings (F83 — canonical back office renamed from /study).
import { Navigate } from "react-router-dom";

export default function BackOfficeRedirect() {
  return <Navigate to="/settings" replace />;
}
