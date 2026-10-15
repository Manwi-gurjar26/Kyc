import { VendorFlow } from "./VendorFlow";

/**
 * Stands in for the vendor's hosted flow.
 *
 * In production this is HyperVerge's own page on their own origin: the user
 * leaves our site, completes DigiLocker consent, PAN and the selfie there, and
 * comes back. The shape is kept identical here — a separate route, our site
 * waiting for a webhook rather than for this page — so that swapping in the
 * real URL changes a redirect target and nothing else.
 *
 * What it does NOT do is report the outcome. The browser tells our server
 * "the user finished"; our server then asks the vendor what actually
 * happened. HyperVerge's own documentation says not to use the SDK result for
 * backend decisions, and this page is built to make that impossible rather
 * than merely discouraged.
 */
export default async function VendorPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { sessionId } = await params;
  const { locale } = await searchParams;

  return (
    <VendorFlow sessionId={sessionId} locale={locale === "hi" ? "hi" : "en"} />
  );
}
