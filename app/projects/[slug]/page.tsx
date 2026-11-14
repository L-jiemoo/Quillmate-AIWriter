import { notFound } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";
import { getProjectDetail } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: { slug: string } }) {
  try {
    const detail = await getProjectDetail(params.slug);
    return <Workspace initialDetail={detail} />;
  } catch {
    notFound();
  }
}
