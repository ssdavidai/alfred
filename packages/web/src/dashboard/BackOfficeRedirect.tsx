// /back-office → /study (M6).
import { Navigate } from "react-router-dom";

export default function BackOfficeRedirect() {
  return <Navigate to="/study" replace />;
}
