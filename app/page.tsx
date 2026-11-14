import { Dashboard } from "@/components/Dashboard";
import { listProjects } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const projects = await listProjects();
  return <Dashboard initialProjects={projects} />;
}
