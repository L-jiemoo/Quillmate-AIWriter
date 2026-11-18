import { notFound } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";
import { getProjectDetail } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await getProjectDetail(slug).catch(() => notFound());
  return <Workspace initialDetail={detail} />;
}
